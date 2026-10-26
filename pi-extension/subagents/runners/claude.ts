/** Anthropic Claude Code CLI adapter. */
import { readRunnerSession } from "../session.ts";
import { buildCommonEnv } from "./launch-env.ts";
import type { RunnerAdapter } from "./types.ts";

export const claudeAdapter: RunnerAdapter = {
  id: "claude",
  label: "Claude Code",
  aliases: ["claude-code"],
  resultMode: "native",
  idleCompletion: "settle",
  nativeTranscriptFreshness: true,
  hasActivitySnapshots: false,
  supportsTurnInterrupt: false,
  supportsResume: false,
  supportsSessionStats: false,

  buildLaunch(ctx) {
    const args: string[] = ["--dangerously-skip-permissions"];
    if (ctx.model) args.push("--model", ctx.model);
    if (ctx.agent?.body) args.push("--append-system-prompt", ctx.agent.body);
    return {
      startArgs: args,
      env: buildCommonEnv(ctx),
      prompt: ctx.task,
    };
  },

  extractResult(ctx) {
    const summary = readRunnerSession({
      runner: "claude",
      cwd: ctx.cwd,
      agentName: ctx.agentName,
      sessionId: ctx.sessionId,
      sentinelFile: ctx.sentinelFile,
      afterTimestamp: ctx.turnStartTime,
    });
    return summary ? { summary } : null;
  },
};
