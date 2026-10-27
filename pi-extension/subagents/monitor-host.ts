/**
 * The monitor host: owns the single 1 Hz ticker, builds its dependencies, and
 * repaints the widget. The monitor itself (`monitor.ts`) stays pure and
 * I/O-injected; this module is the only place its singleton lives.
 */
import { existsSync, statSync } from "node:fs";
import { readSubagentActivityFileAsync } from "./activity.ts";
import { getStatusConfig } from "./format.ts";
import {
  listPanesAsync,
  readScreenAsync,
} from "./herdr.ts";
import { createTicker, type MonitorDeps, type MonitorEntry, type Ticker } from "./monitor.ts";
import { persistRunning } from "./name-registry.ts";
import {
  getLatestApi,
  getLatestContext,
  MONITOR_KEY,
  runningSubagents,
  type RunningSubagent,
} from "./runtime.ts";
import { getNativeSessionFile } from "./session.ts";
import {
  consumeAskSignal,
  consumeExitSignal,
  consumeParkedSignal,
} from "./signals.ts";
import {
  capStatusLines,
  formatStatusAggregate,
  formatTransitionLine,
} from "./status.ts";
import { deliverPendingQuestion } from "./turn.ts";
import { renderSubagentWidgetLines } from "./widget.ts";

let monitor: Ticker | null = null;

export function updateWidget(): void {
  const ctx = getLatestContext();
  if (!ctx?.hasUI) return;

  if (runningSubagents.size === 0) {
    ctx.ui.setWidget("subagent-status", undefined);
    stopMonitor();
    return;
  }

  ctx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

export function isTranscriptFresh(
  adapter: { id: string; nativeTranscriptFreshness: boolean },
  entry: MonitorEntry,
  pane: { kind: string; sessionId?: string },
): boolean | undefined {
  if (!adapter.nativeTranscriptFreshness) return undefined;
  const sessionId = pane.kind === "present" ? pane.sessionId : entry.sessionId;
  const file = getNativeSessionFile({ runner: adapter.id, sessionId, cwd: entry.cwd });
  if (!file || !existsSync(file)) return false;
  try {
    return Date.now() - statSync(file).mtimeMs < 3_000;
  } catch {
    return false;
  }
}

export function createMonitorDeps(): MonitorDeps {
  return {
    now: () => Date.now(),
    listPanes: () => listPanesAsync(),
    readActivity: (file, id) => readSubagentActivityFileAsync(file, id),
    readScreen: (surface, lines) => readScreenAsync(surface, lines),
    consumeExit: (entry) =>
      consumeExitSignal(entry.sessionFile, entry.turnStartTime ?? entry.startTime),
    consumeParked: (entry) =>
      consumeParkedSignal(entry.sessionFile, entry.turnStartTime ?? entry.startTime),
    consumeAsk: (entry) => consumeAskSignal(entry.sessionFile),
    isTranscriptFresh: (adapter, entry, pane) => isTranscriptFresh(adapter, entry, pane),
    deliverQuestion: (entry, ask) => deliverPendingQuestion(entry as RunningSubagent, ask),
    onTransitions: (transitions) => {
      const lines = transitions
        .filter(({ entry }) => !entry.interactive)
        .map(({ entry, snapshot, transition }) =>
          formatTransitionLine(entry.name, snapshot, transition),
        );
      if (lines.length === 0) return;
      const capped = capStatusLines(lines, getStatusConfig().lineLimit);
      getLatestApi()?.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(lines, getStatusConfig().lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    onSessionId: (entry, sessionId) => {
      // Persist a late-discovered native id while the pane is still open. The
      // registry update is merge-only, so it never creates a partial entry.
      if (entry.cli === "pi") return;
      const running = entry as RunningSubagent;
      running.sessionId = sessionId;
      persistRunning(running);
    },
    onWidgetDirty: () => updateWidget(),
    statusEnabled: () => getStatusConfig().enabled,
  };
}

export function ensureMonitorStarted(): void {
  // The ticker stops itself when there is nothing to observe; the object can
  // outlive its timer, so check `running` rather than mere existence.
  if (monitor?.running) return;
  monitor?.stop();
  monitor = createTicker(() => Array.from(runningSubagents.values()), createMonitorDeps(), 1_000);
  monitor.start();
  (globalThis as any)[MONITOR_KEY] = monitor;
}

export function stopMonitor(): void {
  monitor?.stop();
  monitor = null;
  (globalThis as any)[MONITOR_KEY] = null;
}
