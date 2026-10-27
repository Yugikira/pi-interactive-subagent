/**
 * Shared runtime state for the subagents extension.
 *
 * This module is the single owner of the live-agent book and of the
 * `/reload`-visible globals. Everything else imports these bindings (or the
 * accessors) instead of declaring a second copy; that is what keeps a reloaded
 * module and its old closures looking at the same map.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompletionController } from "./completion.ts";
import type { CanonicalRunner } from "./runner-kinds.ts";
import type { SessionStats } from "./session.ts";
import type { SubagentStatusState } from "./status.ts";

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Runner-native session id (Pi header id / Claude UUID / Agy conversation id). */
  sessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  cli?: CanonicalRunner;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
  id: string;
  name: string;
  /** Session that spawned this subagent; shutdown only clears its own. */
  parentSessionId?: string;
  herdrAgentName: string;
  task: string;
  agent?: string;
  cli: CanonicalRunner;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  abortController?: AbortController;
  recordFile?: string;
  /** Spawner artifact dir; lets the monitor/watcher persist registry facts. */
  artifactDir?: string;
  /** Original non-Pi launch argv, replayed on resume. */
  launchArgs?: string[];
  cwd?: string;
  /** Runner-native session id (Pi header id / Claude UUID / Agy conversation id). */
  sessionId?: string;
  /** Pi resume: only entries after this line belong to the new turn. */
  resumeFromLine?: number;
  turn?: number;
  turnStartTime?: number;
  statusState: SubagentStatusState;
  /** Per-turn completion controller fed by the shared monitor. */
  completion?: CompletionController;
  /** One result steer per turn, even if watchers overlap. */
  delivery?: { turn: number; state: "pending" | "delivered" | "suppressed" };
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
export const runningSubagents = new Map<string, RunningSubagent>();

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel spawns run their synchronous prefix before any
 * of them finishes, so without this they would all pick the same name.
 */
export const reservedNames = new Set<string>();

/** Panes created by this extension, used for smart tiling. */
export const trackedSurfaces = new Set<string>();

let latestPi: ExtensionAPI | null = null;
let latestCtx: ExtensionContext | null = null;

export function setLatestApi(pi: ExtensionAPI | null): void {
  latestPi = pi;
}

export function getLatestApi(): ExtensionAPI | null {
  return latestPi;
}

export function setLatestContext(ctx: ExtensionContext | null): void {
  latestCtx = ctx;
}

export function getLatestContext(): ExtensionContext | null {
  return latestCtx;
}

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports the entrypoint, giving fresh module-level state, but closures
// from the old module keep running.
export const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
export const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
export const MONITOR_KEY = Symbol.for("pi-subagents/monitor");
export const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

export function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share.
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;
