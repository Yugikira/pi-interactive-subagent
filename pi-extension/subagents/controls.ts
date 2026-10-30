/**
 * The name-addressed control plane: steer, interrupt, and stop a subagent by
 * name. One resolver checks the live book; the stop fallback checks the
 * persistent registry. Tool handlers stay thin.
 */
import { formatStopMessage } from "./format.ts";
import {
  isHerdrAvailable,
  listPanes,
  promptAgent,
  sendAgentKeys,
  sendCommand,
  sendPaneKeys,
  terminateSurface,
  type TerminateOutcome,
} from "./herdr.ts";
import { paneShowsAgent } from "./launch.ts";
import { updateWidget } from "./monitor-host.ts";
import { getArtifactDir } from "./paths.ts";
import { formatNonPiPrompt } from "./runners/protocol.ts";
import { getRunner, isNativeSessionRunner } from "./runners/registry.ts";
import {
  getLatestApi,
  reservedNames,
  runningSubagents,
  type RunningSubagent,
} from "./runtime.ts";
import { readNameRegistry } from "./session.ts";
import { forceStatusAfterInterrupt } from "./status.ts";
import { watchAndDeliver } from "./turn.ts";

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 */
export function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function resolveRunningByName(name: string, parentSessionId?: string):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const visible = Array.from(runningSubagents.values()).filter(
    (running) => !parentSessionId || !running.parentSessionId || running.parentSessionId === parentSessionId,
  );
  const matches = visible.filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = visible.map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
export function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  try {
    const nextTurn = running.turn ?? 1;
    const now = Date.now();
    running.turnStartTime = now;
    running.completion?.resetTurn(now);

    if (
      running.herdrAgentName &&
      isHerdrAvailable() &&
      send === sendCommand
    ) {
      const promptText =
        running.recordFile && !isNativeSessionRunner(running.cli)
          ? formatNonPiPrompt(message, running.recordFile, nextTurn)
          : message;
      try {
        promptAgent(running.herdrAgentName, promptText);
        return { ok: true };
      } catch {
        // Fallback to sending command to surface directly
      }
    }
    const flattened = message.replace(/\s*\n\s*/g, " ").trim();
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via Herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

export function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
  parentSessionId?: string,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "", parentSessionId);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  // If the previous turn's watcher has completed (or was aborted), re-arm the
  // watcher so the orchestrator receives the response for this new turn.
  if (running.interactive && send === sendCommand && getLatestApi() && (!running.abortController || running.abortController.signal.aborted)) {
    watchAndDeliver(running, { pi: getLatestApi(), updateWidget });
  }

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

/** Send Escape to the active turn without closing the pane or session. */
export function defaultInterrupt(running: RunningSubagent): void {
  try {
    sendPaneKeys(running.surface, ["Escape"]);
  } catch {
    // The agent registration can outlive the pane id in rare reload states.
    sendAgentKeys(running.herdrAgentName, ["Escape"]);
  }
}

export function handleSubagentInterrupt(
  params: { name?: string },
  interrupt: (running: RunningSubagent) => void = defaultInterrupt,
  parentSessionId?: string,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
  const resolved = resolveRunningByName(params.name ?? "", parentSessionId);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const adapter = getRunner(running.cli) ?? getRunner("pi");
  if (!adapter?.supportsTurnInterrupt) {
    const err =
      `Turn interrupt is only supported for Pi subagents; ` +
      `"${running.name}" runs with the "${running.cli}" CLI.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name },
    };
  }

  try {
    interrupt(running);
  } catch (error: any) {
    const err =
      `Failed to send Escape to subagent "${running.name}" via Herdr: ` +
      `${error?.message ?? String(error)}`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, Date.now());
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Interrupt requested for subagent "${running.name}". Its pane and session stay open; ` +
        `send subagent_message to continue, or subagent_stop to close it.`,
    }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

/** Stop a subagent and return an honest outcome. */
export function terminateRunning(
  running: RunningSubagent,
  closePane = true,
): TerminateOutcome {
  return terminateSurface(running.surface, {
    agentName: running.herdrAgentName,
    closePane,
  });
}

/**
 * Stop a subagent that has already completed but whose keepOpen pane still
 * exists. The running entry is gone by then, so the persistent name registry
 * is the only handle left. Never closes a pane that now belongs to another
 * agent, and never claims success when Herdr cannot verify the inventory.
 */
export function stopCompletedByName(
  name: string,
  artifactDir: string | null | undefined,
  closePane: boolean,
): { handled: boolean; message: string; details?: Record<string, unknown> } {
  if (!artifactDir) return { handled: false, message: "" };
  const registry = readNameRegistry(artifactDir);
  const key = Object.keys(registry).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (!key) return { handled: false, message: "" };
  const entry = registry[key];
  const displayName = key;

  if (!entry.surface) {
    return {
      handled: true,
      message:
        `Subagent "${displayName}" has already finished; there is no running pane to stop.` +
        (entry.sessionFile ? ` Its session is ${entry.sessionFile}.` : ""),
      details: { stopped: false, reason: "already_finished", name: displayName },
    };
  }

  const panes = listPanes();
  if (panes === null) {
    return {
      handled: true,
      message:
        `Subagent "${displayName}" is not in the running list, and Herdr could not report ` +
        `the state of pane ${entry.surface}; the stop could not be verified.`,
      details: { stopped: false, reason: "unverified", name: displayName },
    };
  }

  const pane = panes.find((candidate) => candidate.paneId === entry.surface);
  if (!pane) {
    return {
      handled: true,
      message: `Subagent "${displayName}" had already exited; pane ${entry.surface} is gone.`,
      details: { stopped: false, reason: "pane_gone", name: displayName },
    };
  }
  // Herdr reports the runner *kind* in the pane inventory, not the custom
  // name. Match either before calling the pane reused.
  if (
    pane.agent &&
    entry.herdrAgentName &&
    !paneShowsAgent(pane, entry.herdrAgentName, entry.runner ?? "pi")
  ) {
    return {
      handled: true,
      message:
        `Subagent "${displayName}" had finished, but pane ${entry.surface} now belongs to ` +
        `"${pane.agent}"; it was left alone.`,
      details: { stopped: false, reason: "pane_reused", name: displayName },
    };
  }

  const outcome = terminateSurface(entry.surface, {
    agentName: entry.herdrAgentName,
    closePane,
  });
  const stopped = outcome.ok || outcome.paneClosed;
  return {
    handled: true,
    message: formatStopMessage(displayName, outcome),
    details: {
      stopped,
      name: displayName,
      paneClosed: outcome.paneClosed,
      reason: "registry",
      ...(stopped ? {} : { warning: formatStopMessage(displayName, outcome) }),
    },
  };
}

/** The caller session's artifact directory (name registry), when available. */
export function artifactDirForContext(ctx: any): string | null {
  try {
    if (!ctx?.sessionManager?.getSessionFile?.()) return null;
    return getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  } catch {
    return null;
  }
}

export function stopSubagentByName(
  targetName?: string,
  parentSessionId?: string,
  artifactDir?: string | null,
): string {
  const visible = () =>
    Array.from(runningSubagents.values()).filter(
      (running) =>
        !parentSessionId ||
        !running.parentSessionId ||
        running.parentSessionId === parentSessionId,
    );

  const trimmed = targetName?.trim();
  if (trimmed === "all") {
    const all = visible();
    if (all.length === 0) {
      return "No subagents are currently running.";
    }
    const count = all.length;
    const stuck: string[] = [];
    for (const running of all) {
      const outcome = terminateRunning(running);
      running.abortController?.abort();
      runningSubagents.delete(running.id);
      if (!outcome.ok && !outcome.paneClosed) {
        stuck.push(`${running.name} (${running.surface})`);
      }
    }
    updateWidget();
    if (stuck.length === 0) {
      return `All subagents stopped (${count} stopped).`;
    }
    return (
      `Stopped ${count - stuck.length} of ${count} subagents. Still running: ${stuck.join(", ")}. ` +
      `Their panes were left open.`
    );
  }
  if (trimmed) {
    const match = visible().find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
    if (!match) {
      const fallback = stopCompletedByName(trimmed, artifactDir, true);
      if (fallback.handled) return fallback.message;
      const names = visible().map((r) => r.name);
      return `No running subagent named "${trimmed}". Currently running: ${names.join(", ") || "none"}.`;
    }
    const outcome = terminateRunning(match);
    match.abortController?.abort();
    runningSubagents.delete(match.id);
    updateWidget();
    return formatStopMessage(match.name, outcome);
  }
  const all = visible();
  if (all.length === 0) {
    return "No subagents are currently running.";
  }
  if (all.length === 1) {
    const only = all[0];
    const outcome = terminateRunning(only);
    only.abortController?.abort();
    runningSubagents.delete(only.id);
    updateWidget();
    return formatStopMessage(only.name, outcome);
  }
  const names = all.map((r) => r.name);
  return `Multiple subagents running: ${names.join(", ")}. Use /subagent:stop <name> or /subagent:stop all.`;
}
