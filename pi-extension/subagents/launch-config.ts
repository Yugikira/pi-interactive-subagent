/**
 * Pure-ish launch policy: resolving the runner/profile, cwd, session mode,
 * interactivity, parent-model inheritance, and the resume policy. No process
 * is started here; `launch.ts` consumes these decisions.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentConfigDir, loadAgentDefaults, type AgentDefaults, type SubagentSessionMode } from "./agents.ts";
import { formatParentModel } from "./model-config.ts";
import { normalizeRunner, type CanonicalRunner } from "./runners/registry.ts";

/** The subset of the spawn tool params the policy reads. */
export interface SpawnParams {
  task: string;
  agent?: string;
  cli?: string;
  name?: string;
  model?: string;
  cwd?: string;
  keepOpen?: boolean;
}

export function resolveSubagentPaths(
  params: Pick<SpawnParams, "cwd">,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd ? resolve(cwdBase, rawCwd) : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  _params: SpawnParams,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: SpawnParams,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `keepOpen` on the spawn.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
export function resolveEffectiveInteractive(
  params: Pick<SpawnParams, "keepOpen">,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.keepOpen != null) return params.keepOpen;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  // A runner-only spawn (`cli` with no agent profile) has nothing that opts
  // into a persistent session, so it follows the documented `keepOpen: false`
  // default: the pane auto-closes when the turn completes.
  if (!agentDefs) return false;
  return !(agentDefs.autoExit ?? false);
}

/**
 * Whether the Pi child process should auto-exit at the end of a completed
 * turn. `auto-exit` frontmatter is the default, but an effectively
 * interactive session (explicit `keepOpen` / `interactive: true`) overrides
 * it: the session must stay alive to be steered, matching how the agy/claude
 * CLIs keep their REPL open under `keepOpen`. A parked session's turn
 * completions are delivered via the child's `.parked` sidecar.
 */
export function resolveChildAutoExit(autoExit: boolean | undefined, interactive: boolean): boolean {
  return (autoExit ?? false) && !interactive;
}

/**
 * Only a Pi child can inherit the parent's active model: `ctx.model` is a Pi
 * catalog id (`provider/id`), which the other CLIs do not understand.
 */
export function parentModelForRunner(
  runner: CanonicalRunner,
  parentModel: { provider?: string; id?: string } | null | undefined,
): string | null {
  return runner === "pi" ? formatParentModel(parentModel) : null;
}

export function resolveRunnerAndAgent(params: {
  agent?: string;
  cli?: string;
}): {
  effectiveRunner: CanonicalRunner;
  agentName?: string;
  agentDefs: AgentDefaults | null;
} {
  let agentName = params.agent?.trim() || undefined;
  let rawCli = params.cli?.trim() || undefined;

  // If agent is specified without cli, check if agent is actually an alias for a known runner
  // when no matching markdown profile exists
  if (agentName && !rawCli) {
    const asRunner = normalizeRunner(agentName);
    if (asRunner) {
      const profile = loadAgentDefaults(agentName);
      if (!profile) {
        rawCli = asRunner;
        agentName = undefined;
      }
    }
  }

  const agentDefs = agentName ? loadAgentDefaults(agentName) : null;
  const effectiveRunner: CanonicalRunner =
    normalizeRunner(rawCli) ??
    normalizeRunner(agentDefs?.cli) ??
    "pi";

  return { effectiveRunner, agentName, agentDefs };
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
export function resolveResumeLaunchBehavior(keepOpen?: boolean): { autoExit: boolean; interactive: boolean } {
  if (keepOpen) {
    return { autoExit: false, interactive: true };
  }
  return { autoExit: true, interactive: false };
}
