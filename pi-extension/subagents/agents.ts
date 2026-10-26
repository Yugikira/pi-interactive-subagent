/**
 * Agent profile discovery and frontmatter parsing.
 *
 * A profile is a Markdown file with a `---` frontmatter block. Discovery is
 * intentionally small and pure: callers pass the directories (or rely on the
 * defaults), so tests can point at temp dirs without touching the real home
 * directory.
 *
 * Priority:
 *   project `.pi/agents` > global `$PI_CODING_AGENT_DIR/agents` > bundled `agents/`
 *
 * Within one directory the last file for a name wins during discovery (project
 * overrides global overrides bundled); direct loading walks the same order and
 * stops at the first hit.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PACKAGE_ROOT } from "./paths.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "package" | "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

export interface AgentDirs {
  projectDir: string;
  globalDir: string;
  packageDir: string;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** The profiles bundled with this package (`<package>/agents`). */
export function getBundledAgentsDir(): string {
  return join(PACKAGE_ROOT, "agents");
}

export function getAgentDirs(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): AgentDirs {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  return {
    projectDir: join(cwd, ".pi", "agents"),
    globalDir: join(getAgentConfigDir(env), "agents"),
    packageDir: getBundledAgentsDir(),
  };
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
export function getSubagentAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

export function discoverAgentDefinitions(options?: {
  dirs?: AgentDirs;
  allowlist?: Set<string> | null;
}): ListedAgentDefinition[] {
  const dirs = options?.dirs ?? getAgentDirs();
  const allowlist = options?.allowlist !== undefined ? options.allowlist : getSubagentAllowlist();
  const agents = new Map<string, ListedAgentDefinition>();
  const search: Array<{ path: string; source: AgentSource }> = [
    { path: dirs.packageDir, source: "package" },
    { path: dirs.globalDir, source: "global" },
    { path: dirs.projectDir, source: "project" },
  ];

  for (const { path: dir, source } of search) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  const all = [...agents.values()];
  return allowlist ? all.filter((agent) => allowlist.has(agent.name)) : all;
}

export function loadAgentDefaults(
  agentName: string,
  options?: { dirs?: AgentDirs },
): AgentDefinition | null {
  const dirs = options?.dirs ?? getAgentDirs();
  const paths = [
    join(dirs.projectDir, `${agentName}.md`),
    join(dirs.globalDir, `${agentName}.md`),
    join(dirs.packageDir, `${agentName}.md`),
  ];

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = parseAgentDefinition(readFileSync(path, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}
