/**
 * The runner seam.
 *
 * Everything a CLI runner contributes — its ids and aliases, launch argv/env,
 * completion policy, and result extraction — lives behind this interface. The
 * rest of the extension asks the registry for an adapter and never branches on
 * a CLI name.
 */
import type { SubagentLoadout } from "../signals.ts";
import type { CanonicalRunner } from "../runner-kinds.ts";

export { RUNNER_KINDS, type CanonicalRunner } from "../runner-kinds.ts";

/** How a runner's final assistant output is extracted. */
export type RunnerResultMode = "native" | "protocol";

/** Whether Herdr "idle" may mean the turn completed. */
export type IdleCompletionMode = "never" | "settle";

/** Agent profile fields a launch may consume. */
export interface RunnerAgentProfile {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: "standalone" | "lineage-only" | "fork";
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface RunnerLaunchContext {
  platform: NodeJS.Platform;
  id: string;
  displayName: string;
  herdrAgentName: string;
  task: string;
  taskDelivery: "direct" | "artifact";
  cwd: string;
  model: string | null;
  thinking: string | null;
  agentName: string | null;
  agent: RunnerAgentProfile | null;
  loadout: SubagentLoadout;
  artifactDir: string;
  sessionFile: string;
  activityFile: string;
  subagentDonePath: string;
  /** Effective pi child auto-exit (already accounts for keepOpen/interactive). */
  autoExit: boolean;
  interactive: boolean;
  /** Agents this child may spawn (PI_SUBAGENT_ALLOWED), or null. */
  spawnable: string[] | null;
  /** PI_CODING_AGENT_DIR the child should resolve, or null. */
  agentDir: string | null;
  effectiveTools: string | undefined;
  effectiveSkills: string | undefined;
  grantSpawning: boolean;
  /** Text prepended to the task (identity + mode/summary instructions). */
  fullTask: string;
}

export interface LaunchPlan {
  /** Raw argv for `herdr agent start <kind> ... -- <args>`. */
  startArgs: string[];
  /** Complete pane environment; passed to `createSurface` before launch. */
  env: Record<string, string>;
  /** Initial prompt for CLIs that take the task as a separate prompt. */
  prompt: string | null;
  /** Shell fallback for Pi if `herdr agent start` fails. */
  fallbackCommand?: string;
  scriptPreamble?: string[];
  recordFile?: string;
}

export interface RunnerResultContext {
  sessionFile: string;
  recordFile?: string;
  sentinelFile?: string;
  cwd: string;
  turnStartTime: number;
  sessionId?: string;
  agentName: string;
  readPane: (lines: number) => string;
}

export interface RunnerResumeContext {
  platform: NodeJS.Platform;
  sessionFile: string;
  name: string;
  id: string;
  activityFile: string;
  artifactDir: string;
  subagentDonePath: string;
  /** File containing the follow-up message, appended as `@<path>`. */
  messageFile: string | null;
  loadout: SubagentLoadout;
  autoExit: boolean;
  agentDir: string | null;
  spawnable: string[] | null;
  cwd: string | null;
}

export interface RunnerAdapter {
  readonly id: CanonicalRunner;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly resultMode: RunnerResultMode;
  readonly idleCompletion: IdleCompletionMode;
  /** Whether Agy/Claude transcript mtime can suppress an idle completion. */
  readonly nativeTranscriptFreshness: boolean;
  readonly hasActivitySnapshots: boolean;
  readonly supportsTurnInterrupt: boolean;
  readonly supportsResume: boolean;
  /** Pi sessions carry usage stats and a canonical session id for follow-ups. */
  readonly supportsSessionStats: boolean;
  buildLaunch(ctx: RunnerLaunchContext): LaunchPlan;
  buildResume?(ctx: RunnerResumeContext): string | null;
  extractResult(ctx: RunnerResultContext): { summary: string; sessionId?: string } | null;
}
