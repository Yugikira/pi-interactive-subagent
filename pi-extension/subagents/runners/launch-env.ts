/**
 * The pane environment every runner starts with.
 *
 * Building it once here fixes two launch-path bugs: the Pi child's
 * `PI_SUBAGENT_AUTO_EXIT` now follows the effective (keepOpen-aware) value
 * instead of the raw frontmatter, and `PI_SUBAGENT_ALLOWED` /
 * `PI_CODING_AGENT_DIR` are present on the normal `startAgent` path, not just
 * the shell fallback and resume scripts.
 */
import type { RunnerLaunchContext } from "./types.ts";

export interface SignalEnvInput {
  displayName: string;
  id: string;
  sessionFile: string;
  activityFile: string;
  agentName?: string | null;
  autoExit: boolean;
  agentDir?: string | null;
  spawnable?: readonly string[] | null;
}

/** Environment variables the child extension reads. */
export function buildSignalEnv(input: SignalEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PI_SUBAGENT_NAME: input.displayName,
    PI_SUBAGENT_ID: input.id,
    PI_SUBAGENT_SESSION: input.sessionFile,
    PI_SUBAGENT_ACTIVITY_FILE: input.activityFile,
  };
  if (input.agentName) env.PI_SUBAGENT_AGENT = input.agentName;
  if (input.autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
  if (input.agentDir) env.PI_CODING_AGENT_DIR = input.agentDir;
  if (input.spawnable && input.spawnable.length > 0) {
    env.PI_SUBAGENT_ALLOWED = input.spawnable.join(",");
  }
  return env;
}

export function buildCommonEnv(ctx: RunnerLaunchContext): Record<string, string> {
  return buildSignalEnv({
    displayName: ctx.displayName,
    id: ctx.id,
    sessionFile: ctx.sessionFile,
    activityFile: ctx.activityFile,
    agentName: ctx.agentName,
    autoExit: ctx.autoExit,
    agentDir: ctx.agentDir,
    spawnable: ctx.spawnable,
  });
}
