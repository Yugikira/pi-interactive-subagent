/**
 * Pi runner adapter: argv/env construction, sandbox replay, and result
 * extraction. This is the only place that knows how a Pi child is launched.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentConfigDir } from "../agents.ts";
import { shellEscape } from "../shell.ts";
import { getSessionId, readPiSession } from "../session.ts";
import { getToolExtensionPath, SPAWNING_TOOLS } from "../tool-extensions.ts";
import type { SubagentLoadout } from "../signals.ts";
import { buildCommonEnv, buildSignalEnv } from "./launch-env.ts";
import type {
  LaunchPlan,
  RunnerAdapter,
  RunnerLaunchContext,
  RunnerResultContext,
  RunnerResumeContext,
} from "./types.ts";

/** Tools every spawned child may use to talk back to its orchestrator. */
export const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

export function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;
  if (requested.length === 0 && !grantSpawning) return null;

  const allow = new Set(requested);
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }
  return [...allow].join(",");
}

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;
  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

/**
 * Replay a loadout's sandbox onto a raw argv array: model, identity (system
 * prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 */
export function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: {
    artifactDir: string;
    name: string;
    escape?: boolean;
    platform?: NodeJS.Platform;
    resolveToolExtension?: (tool: string) => string | undefined;
    providerExtensions?: string[];
    fallbackModel?: string | null;
  },
): void {
  const esc = opts.escape !== false;
  const wrap = (s: string) => (esc ? shellEscape(s, opts.platform) : s);
  const resolveToolExtension = opts.resolveToolExtension ?? getToolExtensionPath;

  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", wrap(model));
  }

  if (loadout.identity) {
    const flag =
      loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, wrap(spPath));
  }

  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", wrap(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const extPath = resolveToolExtension(tool);
      if (extPath && existsSync(extPath)) extPaths.add(extPath);
    }

    // `--no-extensions` also removes third-party model providers. If the resolved
    // or inherited model belongs to one, re-enable just that provider extension
    // so the child can resolve `--model`.
    const provider = providerFromModel(loadout.model ?? opts.fallbackModel);
    const npmDir = loadout.agentDir
      ? join(loadout.agentDir, "npm", "node_modules")
      : undefined;
    const gitDir = loadout.agentDir
      ? join(loadout.agentDir, "git")
      : undefined;
    const providerExtensions =
      opts.providerExtensions ?? providerExtensionPaths(provider, npmDir, gitDir);
    for (const ext of providerExtensions) {
      extPaths.add(ext);
    }

    for (const extPath of extPaths) {
      parts.push("-e", wrap(extPath));
    }
  }
}

function buildTaskArg(ctx: RunnerLaunchContext): string {
  if (ctx.taskDelivery === "direct") return ctx.fullTask;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = ctx.displayName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const artifactPath = join(ctx.artifactDir, `context/${safeName || "subagent"}-${timestamp}.md`);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, ctx.fullTask, "utf8");
  return `@${artifactPath}`;
}

/**
 * Render a Pi invocation as a shell command. Used for the launch fallback and
 * for resume, so both paths quote and order env/args identically.
 */
export function renderPiCommand(
  platform: NodeJS.Platform,
  cwd: string | null,
  env: Record<string, string>,
  args: string[],
): string {
  const escape = (value: string) => shellEscape(value, platform);
  const escapedArgs = args.map(escape).join(" ");
  if (platform === "win32") {
    const envParts = Object.entries(env).map(
      ([key, value]) => `$env:${key}=${escape(value)};`,
    );
    const cd = cwd ? `Set-Location ${escape(cwd)}; ` : "";
    // `pi` can resolve to a PowerShell shim (`pi.ps1`), after which
    // $LASTEXITCODE is not guaranteed to be set. Capture `$?` too so the
    // sentinel always carries a numeric code.
    return (
      `${cd}${envParts.join(" ")} & pi ${escapedArgs}; ` +
      `$__piOk = $?; $__piCode = $LASTEXITCODE; ` +
      `if ($null -eq $__piCode) { $__piCode = if ($__piOk) { 0 } else { 1 } }; ` +
      `echo "__SUBAGENT_DONE_\${__piCode}__"`
    );
  }
  const envParts = Object.entries(env).map(
    ([key, value]) => `${key}=${escape(value)}`,
  );
  const cd = cwd ? `cd ${escape(cwd)} && ` : "";
  return `${cd}${envParts.join(" ")} pi ${escapedArgs}; echo '__SUBAGENT_DONE_'$?'__'`;
}

/** Render the shell fallback used when `herdr agent start` rejects the launch. */
export function renderPiFallbackCommand(
  ctx: RunnerLaunchContext,
  rawArgs: string[],
  env: Record<string, string>,
): string {
  return renderPiCommand(ctx.platform, ctx.cwd, env, rawArgs);
}

/**
 * Build the resume command for a finished Pi session. Replays the sandbox from
 * the loadout and appends the follow-up message file.
 */
export function buildPiResumeCommand(ctx: RunnerResumeContext): string | null {
  const loadout = ctx.loadout;
  if (!loadout) return null;

  const args: string[] = [
    "--session",
    ctx.sessionFile,
    "-e",
    ctx.subagentDonePath,
  ];
  // `renderPiCommand` escapes each argv entry; escaping here as well produces
  // values like "'model'" and a resumed Pi rejects the model id.
  applySandboxToParts(args, loadout, {
    artifactDir: ctx.artifactDir,
    name: ctx.name,
    platform: ctx.platform,
    escape: false,
  });
  if (ctx.messageFile) args.push(`@${ctx.messageFile}`);

  const env = buildSignalEnv({
    displayName: ctx.name,
    id: ctx.id,
    sessionFile: ctx.sessionFile,
    activityFile: ctx.activityFile,
    agentName: loadout.agent,
    autoExit: ctx.autoExit,
    agentDir: ctx.agentDir,
    spawnable: ctx.spawnable,
  });
  return renderPiCommand(ctx.platform, ctx.cwd ?? loadout.cwd, env, args);
}

const providerExtensionCache = new Map<string, string[]>();

/** Providers Pi ships without extensions; no package discovery needed. */
const BUILTIN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "gemini",
  "openrouter",
  "deepseek",
  "minimax-cn",
  "xai",
  "zai",
  "groq",
  "mistral",
  "ollama",
  "azure",
  "bedrock",
  "vertex",
  "together",
  "fireworks",
  "cerebras",
  "cohere",
]);

/** Provider part of a `provider/model` reference, or null for a bare model id. */
export function providerFromModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : null;
}

function packageMatchesProvider(packageName: string, provider: string): boolean {
  const base = packageName.split("/").pop() ?? packageName;
  const wanted = `pi-${provider}`;
  return base === wanted || base === provider || base.startsWith(`${wanted}-`);
}

/**
 * Extension files that register a model provider.
 *
 * A child launched with `--no-extensions` has no third-party providers: a
 * parent model inherited from `pi-antigravity` (or a similar provider
 * extension) would fail with "Model ... not found" even though it works in
 * the parent. We discover the provider package in the agent's npm directory
 * and re-enable only its extension files, preserving the tool sandbox.
 */
function collectGitPackageDirs(root: string, depth: number): string[] {
  if (depth < 0) return [];
  const found: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    if (existsSync(join(dir, "package.json"))) {
      found.push(dir);
      continue;
    }
    found.push(...collectGitPackageDirs(dir, depth - 1));
  }
  return found;
}

export function providerExtensionPaths(
  provider: string | null,
  npmDir = join(getAgentConfigDir(), "npm", "node_modules"),
  gitDir = join(getAgentConfigDir(), "git"),
): string[] {
  if (!provider) return [];
  const normalized = provider.toLowerCase();
  if (BUILTIN_PROVIDERS.has(normalized)) return [];

  const key = `${npmDir}::${gitDir}::${normalized}`;
  const cached = providerExtensionCache.get(key);
  if (cached) return cached;

  const result: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(npmDir);
  } catch {
    entries = [];
  }

  const packageDirs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      const scopeDir = join(npmDir, entry);
      try {
        for (const sub of readdirSync(scopeDir)) {
          if (packageMatchesProvider(sub, provider)) packageDirs.push(join(scopeDir, sub));
        }
      } catch {
        // Unreadable scope; ignore.
      }
    } else if (packageMatchesProvider(entry, provider)) {
      packageDirs.push(join(npmDir, entry));
    }
  }

  // Git-installed packages live at git/<host>/<owner>/<repo>.
  for (const dir of collectGitPackageDirs(gitDir, 2)) {
    if (packageMatchesProvider(dir.split(/[\\/]/).pop() ?? "", provider)) {
      packageDirs.push(dir);
    }
  }

  for (const dir of packageDirs) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const extensions = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : [];
      for (const rel of extensions) {
        if (typeof rel !== "string") continue;
        const abs = resolve(dir, rel);
        if (existsSync(abs) && !result.includes(abs)) result.push(abs);
      }
    } catch {
      // A malformed package must not break every launch.
    }
  }

  providerExtensionCache.set(key, result);
  return result;
}

export function buildPiLaunch(
  ctx: RunnerLaunchContext,
  injectedProviderExtensions?: string[],
): LaunchPlan {
  const rawArgs: string[] = [
    "--session",
    ctx.sessionFile,
    "-e",
    ctx.subagentDonePath,
  ];

  applySandboxToParts(rawArgs, ctx.loadout, {
    artifactDir: ctx.artifactDir,
    name: ctx.displayName,
    escape: false,
    providerExtensions: injectedProviderExtensions,
    fallbackModel: ctx.model ?? ctx.parentModel,
  });

  const taskArg = buildTaskArg(ctx);
  for (const promptArg of buildPiPromptArgs({
    effectiveSkills: ctx.effectiveSkills,
    taskDelivery: ctx.taskDelivery,
    taskArg,
  })) {
    rawArgs.push(promptArg);
  }

  const env = buildCommonEnv(ctx);
  return {
    startArgs: rawArgs,
    env,
    prompt: null,
    fallbackCommand: renderPiFallbackCommand(ctx, rawArgs, env),
    scriptPreamble: [
      `# Subagent launch script for ${ctx.displayName}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${ctx.sessionFile}`,
    ],
  };
}

export const piAdapter: RunnerAdapter = {
  id: "pi",
  label: "Pi",
  aliases: [],
  resultMode: "native",
  idleCompletion: "never",
  nativeTranscriptFreshness: false,
  hasActivitySnapshots: true,
  supportsTurnInterrupt: true,
  supportsResume: true,
  supportsSessionStats: true,

  buildLaunch: buildPiLaunch,
  buildResume(ctx) {
    const command = buildPiResumeCommand(ctx);
    if (!command) return null;
    return {
      mode: "shell",
      command,
      cwd: ctx.cwd ?? ctx.loadout?.cwd ?? undefined,
    };
  },

  extractResult(ctx: RunnerResultContext) {
    try {
      const summary = readPiSession(ctx.sessionFile, ctx.afterLine ?? 0);
      if (!summary) return null;
      const sessionId = getSessionId(ctx.sessionFile);
      return sessionId ? { summary, sessionId } : { summary };
    } catch {
      // A partial JSONL line must not fail the whole turn; the caller falls
      // back to pane output.
      return null;
    }
  },
};
