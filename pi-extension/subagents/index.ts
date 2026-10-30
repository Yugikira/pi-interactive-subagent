/**
 * Extension entrypoint and composition root.
 *
 * The lifecycle seams live in their own modules: `launch.ts` (start/resume),
 * `turn.ts` (watch/deliver), `controls.ts` (steer/interrupt/stop),
 * `monitor-host.ts` (the 1 Hz ticker and widget), and `tools/*` (registration).
 * This file wires them together, owns the `/reload` cleanup, and exposes the
 * internal test surface.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { terminateSurface, sanitizeAgentName, setHerdrLogSink } from "./herdr.ts";
import { isKnownRunner, normalizeRunner, RUNNER_KINDS } from "./runners/registry.ts";
import {
  applySandboxToParts,
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
} from "./runners/pi.ts";
import { formatNonPiPrompt } from "./runners/protocol.ts";
import { discoverAgentDefinitions, loadAgentDefaults } from "./agents.ts";
import { getToolExtensionPath } from "./tool-extensions.ts";
import {
  MONITOR_KEY,
  POLL_ABORT_KEY,
  reservedNames,
  runningSubagents,
  setLatestApi,
  setLatestContext,
  STATUS_INTERVAL_KEY,
  trackedSurfaces,
  WIDGET_INTERVAL_KEY,
} from "./runtime.ts";
import {
  contextWindowFor,
  formatContextUsage,
  formatElapsed,
  formatStopMessage,
  formatTokens,
  formatUsageSegments,
  formatWidgetRightLabel,
  resolveResultPresentation,
} from "./format.ts";
import {
  borderLine,
  renderSubagentWidgetLines,
  widgetIcon,
} from "./widget.ts";
import {
  getShellReadyDelayMs,
  parentModelForRunner,
  resolveChildAutoExit,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveResumeLaunchBehavior,
  resolveRunnerAndAgent,
} from "./launch-config.ts";
import { launchSubagent, paneShowsAgent } from "./launch.ts";
import { claimDelivery } from "./turn.ts";
import {
  defaultInterrupt,
  handleSubagentInterrupt,
  handleSubagentSteer,
  resolveRunningByName,
  steerSubagent,
  stopCompletedByName,
  stopSubagentByName,
  terminateRunning,
  uniqueRunningName,
} from "./controls.ts";
import { ensureMonitorStarted, stopMonitor } from "./monitor-host.ts";
import type { Ticker } from "./monitor.ts";
import { registerSubagentTool } from "./tools/spawn.ts";
import { registerListTool } from "./tools/list.ts";
import { registerMessageTool } from "./tools/message.ts";
import { registerInterruptTool } from "./tools/interrupt.ts";
import { registerStopTool } from "./tools/stop.ts";
import { registerCommands } from "./commands.ts";
import { registerMessageRenderers } from "./renderers.ts";

export { registerToolExtension } from "./tool-extensions.ts";
export { paneShowsAgent } from "./launch.ts";

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevMonitor = (globalThis as any)[MONITOR_KEY] as Ticker | null;
  prevMonitor?.stop();
  (globalThis as any)[MONITOR_KEY] = null;
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort && runningSubagents.size === 0) {
    prevAbort.abort();
    (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
  } else if (!prevAbort) {
    (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
  }
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveRunnerAndAgent,
  parentModelForRunner,
  paneShowsAgent,
  normalizeRunner,
  isKnownRunner,
  RUNNER_KINDS,
  sanitizeAgentName,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  resolveChildAutoExit,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  getToolExtensionPath,
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  handleSubagentInterrupt,
  defaultInterrupt,
  claimDelivery,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
  stopSubagentByName,
  stopCompletedByName,
  terminateRunning,
  formatStopMessage,
  terminateSurface,
  formatNonPiPrompt,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  launchSubagent,
};

export default function subagentsExtension(pi: ExtensionAPI) {
  setLatestApi(pi);
  if (runningSubagents.size > 0) {
    ensureMonitorStarted();
  }

  // Opt-in termination diagnostics. Stop failures used to be invisible (every
  // herdr error was swallowed and the tool always reported success), so when a
  // stop misbehaves this log is the only way to see which probe lied.
  if (process.env.PI_SUBAGENT_DEBUG === "1") {
    const logFile = process.env.PI_SUBAGENT_DEBUG_FILE ?? join(tmpdir(), "pi-subagents-herdr.log");
    try {
      setHerdrLogSink((message) => {
        appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
      });
      appendFileSync(
        logFile,
        `\n${new Date().toISOString()} ── extension loaded (pid ${process.pid}, cwd ${process.cwd()}) ──\n`,
      );
    } catch {
      // Never let diagnostics break extension loading.
    }
  }

  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    setLatestContext(ctx);
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown. Pi can host multiple sessions in one
  // process, so only clear the subagents this session spawned; another
  // session's panes and watchers must survive.
  pi.on("session_shutdown", (_event, ctx) => {
    const shutdownSessionId = ctx?.sessionManager?.getSessionId?.();
    for (const [id, agent] of runningSubagents) {
      if (shutdownSessionId && agent.parentSessionId && agent.parentSessionId !== shutdownSessionId) {
        continue;
      }
      terminateSurface(agent.surface, { agentName: agent.herdrAgentName, closePane: true });
      agent.abortController?.abort();
      runningSubagents.delete(id);
    }
    if (runningSubagents.size === 0) {
      stopMonitor();
      trackedSurfaces.clear();
      const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
      if (moduleAbort) moduleAbort.abort();
    }
  });

  // The spawning tools are always registered. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launch.ts.
  registerSubagentTool(pi);
  registerListTool(pi);
  registerMessageTool(pi);
  registerInterruptTool(pi);
  registerStopTool(pi);
  registerCommands(pi);
  registerMessageRenderers(pi);
}
