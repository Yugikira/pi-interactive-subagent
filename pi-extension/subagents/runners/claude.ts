/** Anthropic Claude Code CLI adapter. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRunnerSession } from "../session.ts";
import { buildCommonEnv, buildResumeEnv } from "./launch-env.ts";
import type { RunnerAdapter } from "./types.ts";

/**
 * A resume that replays a system-prompt file must not launch against a file
 * that has been removed since the spawn; the CLI would fail after opening a
 * pane. Refuse and let the caller report "spawn fresh".
 */
function hasMissingPromptFile(args: string[]): boolean {
  const fileFlags = new Set(["--append-system-prompt-file", "--system-prompt-file"]);
  for (let i = 0; i < args.length; i++) {
    if (!fileFlags.has(args[i])) continue;
    const value = args[i + 1];
    if (!value || !existsSync(value)) return true;
    i++;
  }
  return false;
}

export const claudeAdapter: RunnerAdapter = {
  id: "claude",
  label: "Claude Code",
  aliases: ["claude-code"],
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

  buildResume(ctx) {
    if (!ctx.sessionId || !ctx.launchArgs) return null;
    if (hasMissingPromptFile(ctx.launchArgs)) return null;
    return {
      mode: "agent",
      // The recorded argv replays the model, permissions, and identity file.
      // `--resume` restores the conversation; Claude's system-prompt snapshot
      // keeps the identity recorded by the first request.
      startArgs: ["--resume", ctx.sessionId, ...ctx.launchArgs],
      env: buildResumeEnv(ctx),
      prompt: ctx.message,
      cwd: ctx.cwd ?? process.cwd(),
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
      projectsDir: ctx.projectsDir,
    });
    return summary ? { summary } : null;
  },
};
