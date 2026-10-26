/** Google Antigravity CLI adapter. */
import { readRunnerSession } from "../session.ts";
import { buildCommonEnv } from "./launch-env.ts";
import type { RunnerAdapter } from "./types.ts";

export const agyAdapter: RunnerAdapter = {
  id: "agy",
  label: "Antigravity",
  aliases: ["antigravity", "antigravity-cli"],
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
    if (ctx.thinking) args.push("--effort", ctx.thinking);
    return {
      startArgs: args,
      env: buildCommonEnv(ctx),
      prompt: ctx.task,
    };
  },

  extractResult(ctx) {
    const summary = readRunnerSession({
      runner: "agy",
      cwd: ctx.cwd,
      agentName: ctx.agentName,
      sessionId: ctx.sessionId,
      afterTimestamp: ctx.turnStartTime,
    });
    return summary ? { summary } : null;
  },
};
