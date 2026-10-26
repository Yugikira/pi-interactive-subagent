/**
 * Pi runner adapter: argv/env construction, sandbox replay, and result
 * extraction. This is the only place that knows how a Pi child is launched.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    return `${cd}${envParts.join(" ")} & pi ${escapedArgs}; echo "__SUBAGENT_DONE_$LASTEXITCODE__"`;
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
export function buildPiResumeCommand(ctx: RunnerResumeContext): string {
  const args: string[] = [
    "--session",
    ctx.sessionFile,
    "-e",
    ctx.subagentDonePath,
  ];
  applySandboxToParts(args, ctx.loadout, {
    artifactDir: ctx.artifactDir,
    name: ctx.name,
    platform: ctx.platform,
  });
  if (ctx.messageFile) args.push(`@${ctx.messageFile}`);

  const env = buildSignalEnv({
    displayName: ctx.name,
    id: ctx.id,
    sessionFile: ctx.sessionFile,
    activityFile: ctx.activityFile,
    agentName: ctx.loadout.agent,
    autoExit: ctx.autoExit,
    agentDir: ctx.agentDir,
    spawnable: ctx.spawnable,
  });
  return renderPiCommand(ctx.platform, ctx.cwd ?? ctx.loadout.cwd, env, args);
}

export function buildPiLaunch(ctx: RunnerLaunchContext): LaunchPlan {
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
  buildResume: buildPiResumeCommand,

  extractResult(ctx: RunnerResultContext) {
    try {
      const summary = readPiSession(ctx.sessionFile, 0);
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
