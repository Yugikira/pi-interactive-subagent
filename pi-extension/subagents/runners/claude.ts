/** Anthropic Claude Code CLI adapter. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    if (ctx.agent?.body) {
      // Herdr encodes `agent start` arguments for the target shell and rejects
      // multi-line values (`invalid_agent_argument`). Agent identities are
      // markdown documents, so pass the body by file, exactly like the Pi
      // adapter does for its system prompt.
      const dir = join(ctx.artifactDir, "context");
      mkdirSync(dir, { recursive: true });
      const promptFile = join(dir, `claude-sysprompt-${ctx.id}.md`);
      writeFileSync(promptFile, ctx.agent.body, "utf8");
      args.push("--append-system-prompt-file", promptFile);
    }
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
