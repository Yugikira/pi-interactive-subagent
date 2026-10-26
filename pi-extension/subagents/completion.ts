/**
 * Turn completion as a pure reducer.
 *
 * `advanceCompletion` receives one observation at a time from the monitor and
 * decides whether the current turn is over. It owns no timer and performs no
 * I/O, so the whole matrix (idle settle, Pi's parked signal, pane loss,
 * deadline) is table-testable.
 *
 * A stall is a *notification*, not a completion, by default: settling a turn
 * on a false stall would lose the result that arrives seconds later.
 */

export type PaneStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type PaneInspection =
  | { kind: "present"; status: PaneStatus; sessionId?: string }
  | { kind: "missing" }
  | { kind: "unavailable"; error: string };

export type CompletionReason = "done" | "sentinel" | "error" | "stalled";

export interface CompletionResult {
  reason: CompletionReason;
  exitCode: number;
  errorMessage?: string;
}

export interface CompletionPolicy {
  /** `sidecar`: the child announces turn end (Pi). `idle-settle`: Herdr idle. */
  mode: "sidecar" | "idle-settle";
  idleSettleCount: number;
  paneGraceMs: number;
  stallAfterMs: number;
  stallAction: "notify" | "settle";
}

export interface CompletionObservation {
  now: number;
  pane: PaneInspection | null;
  screenTail?: string;
  exit?: CompletionResult | null;
  parked?: boolean;
  sentinel?: boolean;
  transcriptFresh?: boolean;
  /** Age of the child's activity snapshot, when one exists. */
  activityAgeMs?: number | null;
  /** Last activity phase (`active`/`waiting`/...) for stall gating. */
  activityPhase?: string | null;
}

export interface CompletionState {
  startedAt: number;
  hasObservedWorking: boolean;
  consecutiveIdle: number;
  lastProgressAt: number;
  paneUnavailableSince: number | null;
  lastStallNoticeAt: number | null;
  settled: boolean;
}

export function createCompletionState(startedAt: number): CompletionState {
  return {
    startedAt,
    hasObservedWorking: false,
    consecutiveIdle: 0,
    lastProgressAt: startedAt,
    paneUnavailableSince: null,
    lastStallNoticeAt: null,
    settled: false,
  };
}

const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

function settle(
  state: CompletionState,
  result: CompletionResult,
): { state: CompletionState; result: CompletionResult; stallNotice: false } {
  return { state: { ...state, settled: true }, result, stallNotice: false };
}

export function advanceCompletion(
  state: CompletionState,
  observation: CompletionObservation,
  policy: CompletionPolicy,
): { state: CompletionState; result: CompletionResult | null; stallNotice: boolean } {
  if (state.settled) return { state, result: null, stallNotice: false };

  // 1. One-shot signals win over everything else.
  if (observation.exit) return settle(state, observation.exit);
  if (policy.mode === "sidecar" && observation.parked) {
    return settle(state, { reason: "done", exitCode: 0 });
  }
  if (observation.sentinel) {
    return settle(state, { reason: "sentinel", exitCode: 0 });
  }

  let next: CompletionState = state;
  let paneUnavailableSince = state.paneUnavailableSince;

  if (observation.pane) {
    if (observation.pane.kind === "missing") {
      if (observation.now - state.startedAt >= policy.paneGraceMs) {
        return state.hasObservedWorking
          ? settle(state, { reason: "done", exitCode: 0 })
          : settle(state, {
              reason: "error",
              exitCode: 1,
              errorMessage: "Subagent pane was closed.",
            });
      }
    } else if (observation.pane.kind === "unavailable") {
      paneUnavailableSince = state.paneUnavailableSince ?? observation.now;
    } else {
      paneUnavailableSince = null;
      const status = observation.pane.status;
      if (status === "working") {
        next = {
          ...next,
          hasObservedWorking: true,
          consecutiveIdle: 0,
          lastProgressAt: observation.now,
        };
      } else if (status === "done") {
        return settle(state, { reason: "done", exitCode: 0 });
      } else if (status === "idle" && policy.mode === "idle-settle" && state.hasObservedWorking) {
        if (observation.transcriptFresh) {
          next = { ...next, consecutiveIdle: 0, lastProgressAt: observation.now };
        } else {
          const consecutiveIdle = state.consecutiveIdle + 1;
          next = { ...next, consecutiveIdle };
          if (consecutiveIdle >= policy.idleSettleCount) {
            return settle(state, { reason: "done", exitCode: 0 });
          }
        }
      }
    }
  } else {
    // No inspection this tick: treat it like a read failure, never as "gone".
    paneUnavailableSince = state.paneUnavailableSince ?? observation.now;
  }

  // 2. Terminal sentinel on the screen (fallback when signals are unavailable).
  const sentinelMatch = observation.screenTail?.match(TERMINAL_SENTINEL);
  if (sentinelMatch) {
    return settle(state, {
      reason: "sentinel",
      exitCode: Number.parseInt(sentinelMatch[1], 10),
    });
  }

  // 3. Stall detection. Only a working turn can be stalled; a waiting session
  // (ask_question reply, kept-open park) is legitimately quiet.
  const stallAfterMs = policy.stallAfterMs;
  if (stallAfterMs > 0) {
    const paneQuietMs =
      paneUnavailableSince == null ? 0 : observation.now - paneUnavailableSince;
    const activityQuiet =
      observation.activityPhase === "active" &&
      observation.activityAgeMs != null &&
      observation.activityAgeMs >= stallAfterMs;
    const quiet = paneQuietMs >= stallAfterMs || activityQuiet;

    if (quiet) {
      if (policy.stallAction === "settle") {
        return settle(state, {
          reason: "stalled",
          exitCode: 1,
          errorMessage: `Subagent produced no progress for ${Math.round(stallAfterMs / 1000)}s.`,
        });
      }
      const due =
        state.lastStallNoticeAt == null ||
        observation.now - state.lastStallNoticeAt >= stallAfterMs;
      if (due) {
        return {
          state: {
            ...next,
            paneUnavailableSince,
            lastStallNoticeAt: observation.now,
          },
          result: null,
          stallNotice: true,
        };
      }
    }
  }

  return {
    state: { ...next, paneUnavailableSince },
    result: null,
    stallNotice: false,
  };
}

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";

/**
 * Promise wrapper around the reducer. The monitor calls `observe` once per
 * tick; the watcher awaits `result`. There is no timer in this class.
 */
export class CompletionController {
  private state: CompletionState;
  private readonly promise: Promise<CompletionResult>;
  private resolvePromise!: (result: CompletionResult) => void;
  private rejectPromise!: (error: Error) => void;
  private finished = false;
  private readonly policy: CompletionPolicy;
  private readonly turnStartTime: number;
  private readonly onStall?: (elapsedMs: number) => void;

  constructor(
    policy: CompletionPolicy,
    turnStartTime: number,
    onStall?: (elapsedMs: number) => void,
  ) {
    this.policy = policy;
    this.turnStartTime = turnStartTime;
    this.onStall = onStall;
    this.state = createCompletionState(turnStartTime);
    this.promise = new Promise<CompletionResult>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    // Avoid an unhandled rejection if the caller aborts before awaiting.
    this.promise.catch(() => {});
  }

  get result(): Promise<CompletionResult> {
    return this.promise;
  }

  observe(observation: Omit<CompletionObservation, "now"> & { now?: number }): void {
    if (this.finished) return;
    const now = observation.now ?? Date.now();
    const { state, result, stallNotice } = advanceCompletion(
      this.state,
      { ...observation, now },
      this.policy,
    );
    this.state = state;
    if (stallNotice) this.onStall?.(now - this.turnStartTime);
    if (result) {
      this.finished = true;
      this.resolvePromise(result);
    }
  }

  abort(message = ABORT_MESSAGE): void {
    if (this.finished) return;
    this.finished = true;
    this.rejectPromise(new Error(message));
  }
}

/** Completion policy for an adapter; Pi uses sidecars, everyone else idle. */
export function completionPolicyFor(
  adapter: {
    idleCompletion: "never" | "settle";
    nativeTranscriptFreshness: boolean;
  },
  opts: { interactive: boolean },
): CompletionPolicy {
  return {
    mode: adapter.idleCompletion === "never" ? "sidecar" : "idle-settle",
    idleSettleCount: 3,
    paneGraceMs: 1_000,
    // Interactive sessions are user-driven; stall pings would be noise.
    stallAfterMs: opts.interactive ? 0 : 60_000,
    stallAction: "notify",
  };
}
