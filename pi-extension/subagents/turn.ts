/**
 * The turn seam: wait for one turn to complete, extract its result, tear down
 * the pane when appropriate, and deliver exactly one result steer to the
 * parent. `watchAndDeliver` is the single delivery path used by spawn, steer,
 * and resume.
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completionPolicyFor, CompletionController, type CompletionResult } from "./completion.ts";
import { formatElapsed, resolveResultPresentation } from "./format.ts";
import {
  getAgentStateAsync,
  paneExistsAsync,
  readCapturedOutput,
  readCapturedOutputAsync,
  terminateSurface,
} from "./herdr.ts";
import { persistRunning } from "./name-registry.ts";
import { getRunner } from "./runners/registry.ts";
import {
  getLatestApi,
  getModuleAbortSignal,
  runningSubagents,
  type RunningSubagent,
  type SubagentResult,
} from "./runtime.ts";
import { countSessionEntryLines, getSessionId, summarizeSessionStats } from "./session.ts";
import type { AskSignal } from "./signals.ts";

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
export function deliverPendingQuestion(running: RunningSubagent, payload: AskSignal): void {
  if (!payload.question) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  getLatestApi()?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Claim the single result steer allowed for a completed turn. */
export function claimDelivery(running: RunningSubagent): boolean {
  const delivery = running.delivery;
  // No record means an error surfaced outside the per-turn watcher; deliver it.
  if (!delivery) return true;
  if (delivery.state !== "pending") return false;
  delivery.state = "delivered";
  return true;
}

/** Wake the parent once when a turn stops making progress. Never settles it. */
function notifyStall(running: RunningSubagent, elapsedMs: number): void {
  const line =
    `${running.name} no progress for ${Math.round(elapsedMs / 1000)}s — still running; ` +
    `steer with subagent_message or stop with subagent_stop.`;
  getLatestApi()?.sendMessage(
    {
      customType: "subagent_status",
      content: `Subagent ${line}`,
      display: true,
      details: { name: running.name, elapsedMs, lines: [line], overflow: 0 },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Clean up or re-arm pane and tracking state after a completed turn. */
async function finalizeTurnCleanup(
  running: RunningSubagent,
  surface: string,
  herdrAgentName: string,
): Promise<void> {
  if (!running.interactive) {
    await new Promise((r) => setTimeout(r, 500));
    terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    runningSubagents.delete(running.id);
  } else {
    // A keepOpen turn is over, but its pane is the only handle the user has.
    // Only a confirmed absence may discard the entry; an unreadable Herdr
    // inventory keeps it so subagent_stop can still close the pane.
    const stillThere = await paneExistsAsync(surface);
    if (stillThere === false) {
      runningSubagents.delete(running.id);
    } else {
      running.abortController = undefined;
      running.turn = (running.turn ?? 1) + 1;
      running.turnStartTime = Date.now();
      if (existsSync(running.sessionFile)) {
        running.resumeFromLine = countSessionEntryLines(running.sessionFile);
      }
    }
  }
}

export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, herdrAgentName, task, surface, startTime, sessionFile, cli } = running;
  const adapter = getRunner(cli) ?? getRunner("pi");
  if (!adapter) throw new Error(`Unknown runner adapter: ${cli}`);
  const deliveryTurn = running.turn ?? 1;
  const turnStart = running.turnStartTime ?? startTime;

  try {
    // The shared monitor feeds this controller once per tick; the controller
    // itself owns no timer.
    const controller = new CompletionController(
      completionPolicyFor(adapter, { interactive: running.interactive }),
      turnStart,
      (elapsedMs) => notifyStall(running, elapsedMs),
    );
    running.completion = controller;
    const combined = AbortSignal.any([signal, getModuleAbortSignal()]);
    const onAbort = () => controller.abort();
    combined.addEventListener("abort", onAbort, { once: true });
    if (combined.aborted) onAbort();

    let result: CompletionResult;
    try {
      result = await controller.result;
    } finally {
      combined.removeEventListener("abort", onAbort);
      running.completion = undefined;
    }

    const elapsed = Math.floor((Date.now() - turnStart) / 1000);

    // External runners (agy, claude, codex, grok, opencode)
    if (!adapter.supportsSessionStats) {
      let summary = "";

      // Resolve session ID from Herdr if not already known
      let sessionRefId = running.sessionId;
      if (!sessionRefId && running.herdrAgentName) {
        const stateInfo = await getAgentStateAsync(running.herdrAgentName);
        if (stateInfo?.sessionId) {
          sessionRefId = stateInfo.sessionId;
          running.sessionId = sessionRefId;
          // Cover short-lived agents that finish before the monitor's first
          // tick can persist the id.
          persistRunning(running);
        }
      }

      // 1. The adapter owns native-reader vs protocol-record dispatch.
      summary =
        adapter.extractResult({
          sessionFile,
          recordFile: running.recordFile,
          cwd: running.cwd ?? "",
          turnStartTime: running.turnStartTime ?? startTime,
          afterLine: running.resumeFromLine,
          sessionId: sessionRefId,
          agentName: herdrAgentName,
          readPane: (lines) => readCapturedOutput(surface, herdrAgentName, lines),
        })?.summary ?? "";

      // 2. Fallback to reading captured output via Herdr
      if (!summary) {
        summary = await readCapturedOutputAsync(surface, herdrAgentName, 1000);
      }

      if (!summary) {
        summary =
          result.exitCode !== 0
            ? `${cli} exited with code ${result.exitCode}`
            : `${cli} completed without output`;
      }

      await finalizeTurnCleanup(running, surface, herdrAgentName);

      running.delivery = { turn: deliveryTurn, state: "pending" };
      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        cli,
      };
    }

    // Pi subagent result extraction
    let summary = "";
    if (existsSync(sessionFile)) {
      summary =
        adapter.extractResult({
          sessionFile,
          recordFile: running.recordFile,
          cwd: running.cwd ?? "",
          turnStartTime: running.turnStartTime ?? startTime,
          afterLine: running.resumeFromLine,
          sessionId: running.sessionId,
          agentName: herdrAgentName,
          readPane: (lines) => readCapturedOutput(surface, herdrAgentName, lines),
        })?.summary ?? "";
    }

    if (!summary) {
      // Prefer the structured error over a pane scrape; the pane can contain
      // hundreds of lines of TUI chrome, so bound the fallback.
      summary =
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : (await readCapturedOutputAsync(surface, herdrAgentName, 50)) ||
            (result.exitCode !== 0
              ? `Sub-agent exited with code ${result.exitCode}`
              : "Sub-agent exited without output"));
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    await finalizeTurnCleanup(running, surface, herdrAgentName);

    running.delivery = { turn: deliveryTurn, state: "pending" };
    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      cli,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    if (getModuleAbortSignal().aborted && !signal.aborted) {
      running.delivery = { turn: deliveryTurn, state: "suppressed" };
      return {
        name,
        task,
        summary: "Subagent watcher paused for module reload.",
        exitCode: 0,
        elapsed: Math.floor((Date.now() - turnStart) / 1000),
        error: "reloaded",
        cli: running.cli,
      };
    }

    running.delivery = { turn: deliveryTurn, state: "pending" };

    if (!running.interactive) {
      runningSubagents.delete(running.id);
      terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    } else {
      // For keepOpen subagents, halt runaway execution but keep the pane for inspection
      terminateSurface(surface, { agentName: herdrAgentName, closePane: false });
      const stillThere = await paneExistsAsync(surface);
      if (stillThere === false) {
        runningSubagents.delete(running.id);
      } else {
        running.abortController = undefined;
      }
    }

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - turnStart) / 1000),
        error: "cancelled",
        sessionFile,
        cli: running.cli,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - turnStart) / 1000),
      error: err?.message ?? String(err),
      cli: running.cli,
    };
  }
}

export interface DeliverOptions {
  /** Herdr/extension API used to send the result steer. */
  pi: ExtensionAPI | null;
  /** Refresh the widget after the entry changes. */
  updateWidget(): void;
  /** Extra details merged into the result message (e.g. resume's session refs). */
  extraDetails?: Record<string, unknown>;
  /** Prefix for the catch-path error message. */
  errorPrefix?: string;
  /** Whether to include usage stats in the result details (spawn: true). */
  includeStats?: boolean;
  /** Whether the catch-path result details include `task` (spawn: true). */
  includeTaskInError?: boolean;
}

/**
 * Watch one turn and deliver exactly one result steer. This is the only
 * delivery path; spawn, steer re-arm, and resume all call it.
 */
export function watchAndDeliver(running: RunningSubagent, options: DeliverOptions): void {
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  watchSubagent(running, watcherAbort.signal)
    .then((result) => {
      if (!claimDelivery(running)) return;
      options.updateWidget();

      const presentation = resolveResultPresentation(result, running.name);

      options.pi?.sendMessage(
        {
          customType: "subagent_result",
          content: presentation,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            cli: running.cli,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
            ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
            ...(options.includeStats !== false && result.stats ? { stats: result.stats } : {}),
            ...options.extraDetails,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      if (!claimDelivery(running)) return;
      options.updateWidget();
      options.pi?.sendMessage(
        {
          customType: "subagent_result",
          content: `${options.errorPrefix ?? `Sub-agent "${running.name}" error:`} ${
            err?.message ?? String(err)
          }`,
          display: true,
          details: {
            name: running.name,
            ...(options.includeTaskInError !== false ? { task: running.task } : {}),
            error: err?.message,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });
}
