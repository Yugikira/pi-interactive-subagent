import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAgentDefaults } from "./agents.ts";
import { artifactDirForContext, stopSubagentByName } from "./controls.ts";
import { RUNNER_KINDS, normalizeRunner } from "./runners/registry.ts";
import { runningSubagents } from "./runtime.ts";
import { classifyStatus } from "./status.ts";
import { formatElapsedMMSS } from "./widget.ts";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("subagent", {
    description: "Manage subagents: /subagent <agent|cli> [task] | /subagent stop [name] | /subagent status",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent|cli> [task] | /subagent stop [name] | /subagent status", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const target = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (target.toLowerCase() === "stop" || target.toLowerCase() === "kill") {
        const msg = stopSubagentByName(
          rest,
          ctx?.sessionManager?.getSessionId?.(),
          artifactDirForContext(ctx),
        );
        ctx.ui.notify(msg, msg.includes("No running") || msg.includes("Multiple") ? "warning" : "info");
        return;
      }

      if (target.toLowerCase() === "status" || target.toLowerCase() === "list") {
        if (runningSubagents.size === 0) {
          ctx.ui.notify("No subagents are currently running.", "info");
          return;
        }
        const lines = Array.from(runningSubagents.values()).map((r) => {
          const elapsed = formatElapsedMMSS(r.startTime);
          const snapshot = classifyStatus(r.statusState, Date.now());
          return `• ${r.name} [${r.cli}] (${elapsed}, ${snapshot.kind})`;
        });
        ctx.ui.notify(`Running subagents:\n${lines.join("\n")}`, "info");
        return;
      }

      const runner = normalizeRunner(target);
      if (runner) {
        const taskText = rest || `You are the ${runner} agent. Wait for instructions.`;
        const displayName = runner[0].toUpperCase() + runner.slice(1);
        const toolCall = `Use subagent with cli: "${runner}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
        pi.sendUserMessage(toolCall);
        return;
      }

      const defs = loadAgentDefaults(target);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${target}" not found in ~/.pi/agent/agents/ or .pi/agents/ (supported runners: ${RUNNER_KINDS.join(", ")})`,
          "error",
        );
        return;
      }

      const taskText = rest || `You are the ${target} agent. Wait for instructions.`;
      const displayName = target[0].toUpperCase() + target.slice(1);
      const toolCall = `Use subagent with agent: "${target}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent:stop command — convenience command to stop a running subagent
  pi.registerCommand("subagent:stop", {
    description: "Stop a running subagent: /subagent:stop [name|all]",
    handler: async (args, ctx) => {
      const msg = stopSubagentByName(
        args,
        ctx?.sessionManager?.getSessionId?.(),
        artifactDirForContext(ctx),
      );
      ctx.ui.notify(msg, msg.includes("No running") || msg.includes("Multiple") ? "warning" : "info");
    },
  });

  // /subagents command — list currently running subagents
  pi.registerCommand("subagents", {
    description: "List currently running subagents: /subagents",
    handler: async (_args, ctx) => {
      if (runningSubagents.size === 0) {
        ctx.ui.notify("No subagents are currently running.", "info");
        return;
      }
      const lines = Array.from(runningSubagents.values()).map((r) => {
        const elapsed = formatElapsedMMSS(r.startTime);
        const snapshot = classifyStatus(r.statusState, Date.now());
        return `• ${r.name} [${r.cli}] (${elapsed}, ${snapshot.kind})`;
      });
      ctx.ui.notify(`Running subagents:\n${lines.join("\n")}`, "info");
    },
  });
}
