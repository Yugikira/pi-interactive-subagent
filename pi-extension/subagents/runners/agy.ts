/** Google Antigravity CLI adapter. */
import { readRunnerSession } from "../session.ts";
import { buildCommonEnv, buildResumeEnv } from "./launch-env.ts";
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
  supportsResume: true,
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

  buildResume(ctx) {
    if (!ctx.sessionId || !ctx.launchArgs) return null;
    return {
      mode: "agent",
      // Replay the original model/effort flags alongside the conversation.
      startArgs: ["--conversation", ctx.sessionId, ...ctx.launchArgs],
      env: buildResumeEnv(ctx),
      prompt: ctx.message,
      cwd: ctx.cwd ?? process.cwd(),
    };
  },

  extractResult(ctx) {
    const summary = readRunnerSession({
      runner: "agy",
      cwd: ctx.cwd,
      agentName: ctx.agentName,
      sessionId: ctx.sessionId,
      afterTimestamp: ctx.turnStartTime,
      brainDir: ctx.brainDir,
    });
    return summary ? { summary } : null;
  },
};
