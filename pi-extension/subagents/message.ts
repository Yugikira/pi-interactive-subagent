/**
 * The `subagent_message` policy: steer a running subagent, otherwise resume a
 * finished one by name against its persisted native session. Tool registration
 * stays thin; this module owns the decision and the follow-up delivery.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSubagentSteer } from "./controls.ts";
import { sendCommand } from "./herdr.ts";
import { resumeSubagent } from "./launch.ts";
import { ensureMonitorStarted, updateWidget } from "./monitor-host.ts";
import { getArtifactDir } from "./paths.ts";
import { runningSubagents } from "./runtime.ts";
import { readNameRegistry, resolveNameInRegistry } from "./session.ts";
import { watchAndDeliver } from "./turn.ts";

export interface MessageContext {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  pi: ExtensionAPI;
}

function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: { error: text, ...details } };
}

export async function handleSubagentMessage(
  params: { name?: string; message?: string },
  ctx: MessageContext,
) {
  const requestedName = params.name?.trim();
  if (!requestedName) {
    return errorResult("Provide the subagent's `name` to steer (if running) or resume (if finished).");
  }

  const message = params.message;
  if (!message?.trim()) {
    return errorResult("`message` is required to steer or resume a subagent.");
  }

  const parentSessionId = ctx.sessionManager.getSessionId();

  // ── Steer a running subagent ──
  // A name that matches a currently-running subagent always steers it.
  const runningMatch = Array.from(runningSubagents.values()).find(
    (running) =>
      running.name === requestedName &&
      (!running.parentSessionId || running.parentSessionId === parentSessionId),
  );
  if (runningMatch) {
    return handleSubagentSteer(
      { name: requestedName, message },
      sendCommand,
      parentSessionId,
    );
  }

  // ── Resume a finished session by name ──
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    parentSessionId,
  );
  const entry = resolveNameInRegistry(artifactDir, requestedName);
  if (!entry) {
    const known = Object.keys(readNameRegistry(artifactDir));
    const err =
      `No subagent named "${requestedName}" in this session. ` +
      (known.length > 0
        ? `Known subagents: ${known.join(", ")}.`
        : "No subagents have been spawned in this session yet.");
    return errorResult(err);
  }

  const outcome = await resumeSubagent({
    name: requestedName,
    message,
    parentSessionId,
    artifactDir,
    entry,
  });

  if ("error" in outcome) {
    return errorResult(outcome.error, { code: outcome.code });
  }

  ensureMonitorStarted();
  watchAndDeliver(outcome.running, {
    pi: ctx.pi,
    updateWidget,
    extraDetails: {
      sessionFile: outcome.running.sessionFile,
      ...(outcome.running.sessionId ? { sessionId: outcome.running.sessionId } : {}),
    },
    errorPrefix: "Resume error:",
    // Pre-refactor Pi resume did not surface usage stats or `task` in the
    // result details.
    includeStats: false,
    includeTaskInError: false,
  });

  return {
    content: [{ type: "text" as const, text: `Session "${requestedName}" resumed.` }],
    details: {
      id: outcome.running.id,
      name: outcome.running.name,
      sessionId: outcome.running.sessionId,
      sessionFile: outcome.running.sessionFile,
      launchScriptFile: outcome.running.launchScriptFile,
      status: "started",
    },
  };
}
