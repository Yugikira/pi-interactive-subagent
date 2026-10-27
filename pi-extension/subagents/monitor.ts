/**
 * The single 1 Hz observation loop.
 *
 * One tick reads the pane inventory once, then observes every running
 * subagent in parallel: pane state, activity snapshot, completion signals,
 * questions, and status transitions. All I/O is injected, so the tick is
 * testable without Herdr and the extension host never runs `execFileSync` on
 * this path.
 */
import type { ActivityReadResult, SubagentActivityState } from "./activity.ts";
import type { CompletionController, CompletionResult, PaneInspection, PaneStatus } from "./completion.ts";
import type { AskSignal } from "./signals.ts";
import {
  advanceStatusState,
  observeStatus,
  type StatusObservation,
  type StatusSnapshot,
  type SubagentStatusState,
  type SubagentStatusTransition,
} from "./status.ts";
import type { PaneSummary } from "./herdr.ts";
import { getRunner } from "./runners/registry.ts";
import type { RunnerAdapter } from "./runners/types.ts";

export interface MonitorEntry {
  id: string;
  name: string;
  agent?: string;
  cli: string;
  herdrAgentName: string;
  surface: string;
  sessionFile: string;
  activityFile?: string;
  cwd?: string;
  sessionId?: string;
  startTime: number;
  turnStartTime?: number;
  interactive: boolean;
  statusState: SubagentStatusState;
  completion?: CompletionController;
}

export interface MonitorDeps {
  now(): number;
  listPanes(): Promise<PaneSummary[] | null>;
  readActivity(file: string, runningChildId: string): Promise<ActivityReadResult>;
  readScreen(surface: string, lines: number): Promise<string>;
  consumeExit(entry: MonitorEntry): CompletionResult | null;
  consumeParked(entry: MonitorEntry): CompletionResult | null;
  consumeAsk(entry: MonitorEntry): AskSignal | null;
  isTranscriptFresh(
    adapter: RunnerAdapter,
    entry: MonitorEntry,
    pane: PaneInspection,
  ): boolean | undefined;
  deliverQuestion(entry: MonitorEntry, ask: AskSignal): void;
  /** A pane reported a new or changed native session id. */
  onSessionId?(entry: MonitorEntry, sessionId: string, previous: string | undefined): void;
  /** Batched so one tick produces at most one aggregate status message. */
  onTransitions(
    transitions: Array<{
      entry: MonitorEntry;
      snapshot: StatusSnapshot;
      transition: Exclude<SubagentStatusTransition, null>;
    }>,
  ): void;
  onWidgetDirty(): void;
  statusEnabled(): boolean;
}

export function normalizePaneStatus(raw: string | undefined): PaneStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return raw!.toLowerCase() as PaneStatus;
    default:
      return "unknown";
  }
}

/** Map the shared pane inventory to one entry's inspection. */
export function inspectEntry(
  entry: MonitorEntry,
  panes: PaneSummary[] | null,
): PaneInspection {
  if (panes === null) {
    return { kind: "unavailable", error: "pane inventory unavailable" };
  }
  // The surface id is the entry's identity. Do NOT match by agent name: Herdr
  // reports the runner *kind* ("pi", "claude") for every pane of that runner,
  // so a child named "pi" would otherwise inspect the orchestrator's pane and
  // read the wrong completion/output. A just-created pane is already present in
  // the inventory with its pane id, so the "agent not listed yet" window is
  // still handled.
  const pane = panes.find((candidate) => candidate.paneId === entry.surface);
  if (!pane) return { kind: "missing" };
  return {
    kind: "present",
    status: pane.agent ? normalizePaneStatus(pane.agentStatus) : "unknown",
    sessionId: pane.agentSessionValue,
  };
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  return activity.activeScope ?? activity.latestEvent ?? activity.toolName ?? "active";
}

function activityObservation(activity: SubagentActivityState): StatusObservation {
  return {
    snapshot: "present",
    updatedAt: activity.updatedAt,
    sequence: activity.sequence,
    phase: activity.phase,
    active: activity.phase === "active",
    activeScope: activity.activeScope,
    activeSince: activity.activeSince,
    waitingSince: activity.waitingSince,
    latestEvent: activity.latestEvent,
    activityLabel: activityLabel(activity),
  };
}

/** Build the status observation for an entry from its runner's signals. */
export function observeEntry(
  entry: MonitorEntry,
  adapter: RunnerAdapter,
  pane: PaneInspection,
  activityRead: ActivityReadResult | undefined,
  now: number,
): void {
  if (adapter.hasActivitySnapshots) {
    if (activityRead?.ok) {
      entry.statusState = observeStatus(entry.statusState, activityObservation(activityRead.activity), now);
    } else if (activityRead && activityRead.ok === false) {
      entry.statusState = observeStatus(entry.statusState, {
        snapshot: activityRead.reason,
        snapshotError: activityRead.error,
      }, now);
    }
    return;
  }

  if (pane.kind === "present") {
    const isWorking = pane.status === "working";
    const isBlocked = pane.status === "blocked";
    entry.statusState = observeStatus(entry.statusState, {
      snapshot: "present",
      updatedAt: now,
      sequence: 1,
      phase: isWorking ? "active" : "waiting",
      active: isWorking,
      activeScope: isWorking ? "provider" : undefined,
      activityLabel: isBlocked ? "blocked" : isWorking ? "working" : undefined,
    }, now);
    return;
  }

  entry.statusState = observeStatus(entry.statusState, {
    snapshot: "missing",
    snapshotError: pane.kind === "unavailable" ? pane.error : undefined,
  }, now);
}

/**
 * One observation tick. Returns false when there was nothing to observe (the
 * caller can stop its timer).
 */
export async function runMonitorTick(
  entries: MonitorEntry[],
  deps: MonitorDeps,
): Promise<boolean> {
  if (entries.length === 0) return false;

  const now = deps.now();
  const panes = await deps.listPanes();
  const transitions: Array<{
    entry: MonitorEntry;
    snapshot: StatusSnapshot;
    transition: Exclude<SubagentStatusTransition, null>;
  }> = [];

  await Promise.all(
    entries.map(async (entry) => {
      const adapter = getRunner(entry.cli) ?? getRunner("pi");
      if (!adapter) return;

      const pane = inspectEntry(entry, panes);
      // The pane inventory already carries the runner's native session id.
      // Cache it now so result extraction does not depend on a separate
      // `agent get` that can time out while Herdr is busy. Non-Pi ids may
      // change on resume (`--fork-session`), so update those on change too;
      // Pi keeps its canonical header id.
      if (pane.kind === "present" && pane.sessionId) {
        const previous = entry.sessionId;
        const changed = pane.sessionId !== previous;
        if (!previous || (adapter.id !== "pi" && changed)) {
          entry.sessionId = pane.sessionId;
          if (changed) deps.onSessionId?.(entry, pane.sessionId, previous);
        }
      }
      const activityRead = entry.activityFile
        ? await deps.readActivity(entry.activityFile, entry.id)
        : undefined;

      observeEntry(entry, adapter, pane, activityRead, now);
      const advanced = advanceStatusState(entry.statusState, now);
      entry.statusState = advanced.nextState;
      if (advanced.transition) {
        transitions.push({
          entry,
          snapshot: advanced.snapshot,
          transition: advanced.transition,
        });
      }

      if (entry.completion) {
        // Consume one-shot signals only for live watchers.
        const exit = deps.consumeExit(entry);
        const parked = adapter.idleCompletion === "never" ? deps.consumeParked(entry) : null;
        const screenTail = pane.kind === "present"
          ? await deps.readScreen(entry.surface, 5)
          : undefined;
        entry.completion.observe({
          now,
          pane,
          screenTail,
          exit,
          parked: parked != null,
          transcriptFresh: deps.isTranscriptFresh(adapter, entry, pane),
          activityAgeMs: activityRead?.ok
            ? now - activityRead.activity.updatedAt
            : activityRead
              ? now
              : null,
          activityPhase: activityRead?.ok ? activityRead.activity.phase : null,
        });
      }

      const ask = deps.consumeAsk(entry);
      if (ask) deps.deliverQuestion(entry, ask);
    }),
  );

  if (deps.statusEnabled() && transitions.length > 0) {
    deps.onTransitions(transitions);
  }
  deps.onWidgetDirty();
  return true;
}

export interface Ticker {
  start(): void;
  stop(): void;
  tick(): Promise<boolean>;
  readonly running: boolean;
  readonly skippedTicks: number;
}

/** Interval wrapper with an in-flight guard. */
export function createTicker(
  getEntries: () => MonitorEntry[],
  deps: MonitorDeps,
  intervalMs = 1_000,
): Ticker {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let inFlight = false;
  let skipped = 0;

  const tick = async (): Promise<boolean> => {
    if (inFlight) {
      skipped++;
      return true;
    }
    inFlight = true;
    try {
      return await runMonitorTick(getEntries(), deps);
    } finally {
      inFlight = false;
    }
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
  };

  return {
    start() {
      if (timer) return;
      running = true;
      timer = setInterval(() => {
        void tick()
          .then((hasEntries) => {
            if (!hasEntries) stopTimer();
          })
          .catch(() => {
            // Observation failures are transient; the next tick retries.
          });
      }, intervalMs);
      timer.unref?.();
    },
    stop: stopTimer,
    tick,
    get running() {
      return running;
    },
    get skippedTicks() {
      return skipped;
    },
  };
}
