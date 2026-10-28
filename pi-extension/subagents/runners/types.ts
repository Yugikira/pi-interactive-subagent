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
  /** Parent session model (provider/id), used to find provider extensions. */
  parentModel?: string | null;
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
  /** Pi only: ignore entries at or before this line (resume scoping). */
  afterLine?: number;
  sessionId?: string;
  agentName: string;
  readPane: (lines: number) => string;
  brainDir?: string;
  projectsDir?: string;
}

export interface RunnerResumeContext {
  platform: NodeJS.Platform;
  /** Pi's transcript path; a placeholder for other runners. */
  sessionFile: string;
  /** Pi header id / Claude UUID / Agy conversation id. */
  sessionId: string | null;
  /** Original non-Pi launch argv, replayed to preserve model/permissions/identity. */
  launchArgs: string[] | null;
  name: string;
  id: string;
  /** Follow-up text for agent-mode runners. */
  message: string;
  /** File containing the follow-up message, appended as `@<path>` (Pi). */
  messageFile: string | null;
  /** Pi only; null for runners that do not need a sandbox snapshot. */
  loadout: SubagentLoadout | null;
  autoExit: boolean;
  agentDir: string | null;
  spawnable: string[] | null;
  cwd: string | null;
  artifactDir: string;
  activityFile: string;
  subagentDonePath: string;
}

/**
 * How a resumed runner is transported.
 *
 * - `shell`: type a complete command into the new pane (Pi's verified path).
 * - `agent`: register the agent with Herdr and deliver the follow-up prompt.
 */
export type RunnerResumePlan =
  | {
      mode: "shell";
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      scriptPreamble?: string[];
    }
  | {
      mode: "agent";
      startArgs: string[];
      env: Record<string, string>;
      prompt: string | null;
      cwd: string;
    };

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
  buildResume?(ctx: RunnerResumeContext): RunnerResumePlan | null;
  extractResult(ctx: RunnerResultContext): { summary: string; sessionId?: string } | null;
}
