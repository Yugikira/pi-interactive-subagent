/**
 * Protocol-based runners (codex, grok, opencode).
 *
 * These CLIs have no stable transcript reader we can rely on, so the task
 * carries a small output protocol: the model appends one JSON line to a
 * per-agent record file, and the parent reads the last matching record.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalRunner } from "../runner-kinds.ts";
import { getSubagentRecordPath, readLastSessionRecord } from "../session.ts";
import { buildCommonEnv } from "./launch-env.ts";
import type { LaunchPlan, RunnerAdapter, RunnerLaunchContext, RunnerResultContext } from "./types.ts";

export function formatNonPiPrompt(task: string, recordFile: string, turn: number): string {
  const normPath = recordFile.replace(/\\/g, "/");
  return (
    `${task}\n\n` +
    `[Output Protocol]\n` +
    `When you have completed your task, append a single valid JSON line containing your final response to:\n` +
    `"${normPath}"\n` +
    `Format: {"turn": ${turn}, "timestamp": ${Date.now()}, "content": "<your complete final response text>"}`
  );
}

export function buildProtocolLaunch(ctx: RunnerLaunchContext): LaunchPlan {
  const recordFile = getSubagentRecordPath(ctx.cwd, ctx.herdrAgentName);
  mkdirSync(dirname(recordFile), { recursive: true });
  return {
    startArgs: [],
    env: buildCommonEnv(ctx),
    prompt: formatNonPiPrompt(ctx.task, recordFile, 1),
    recordFile,
  };
}

export function extractProtocolResult(
  ctx: RunnerResultContext,
): { summary: string } | null {
  if (!ctx.recordFile) return null;
  const summary = readLastSessionRecord(ctx.recordFile, ctx.turnStartTime);
  return summary ? { summary } : null;
}

/** Create an adapter for a CLI that uses the JSON-line output protocol. */
export function createProtocolAdapter(def: {
  id: CanonicalRunner;
  label: string;
  aliases?: readonly string[];
}): RunnerAdapter {
  return {
    id: def.id,
    label: def.label,
    aliases: def.aliases ?? [],
    resultMode: "protocol",
    idleCompletion: "settle",
    nativeTranscriptFreshness: false,
    hasActivitySnapshots: false,
    supportsTurnInterrupt: false,
    supportsResume: false,
    supportsSessionStats: false,
    buildLaunch: buildProtocolLaunch,
    extractResult: extractProtocolResult,
  };
}
