import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgentDefinitions, getSubagentAllowlist } from "../agents.ts";
import { uniqueRunningName } from "../controls.ts";
import { isMuxAvailable } from "../herdr.ts";
import { launchSubagent } from "../launch.ts";
import { resolveRunnerAndAgent } from "../launch-config.ts";
import { ensureMonitorStarted, updateWidget } from "../monitor-host.ts";
import { persistRunning } from "../name-registry.ts";
import { getArtifactDir } from "../paths.ts";
import { isKnownRunner, RUNNER_KINDS } from "../runner-kinds.ts";
import { reservedNames } from "../runtime.ts";
import { readNameRegistry } from "../session.ts";
import { watchAndDeliver } from "../turn.ts";
import { muxUnavailableResult, toolResultText } from "./common.ts";
import { SubagentParams } from "./schemas.ts";

export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (params.cli && !isKnownRunner(params.cli)) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown runner CLI "${params.cli}". Supported runners: ${RUNNER_KINDS.join(", ")}.`,
              },
            ],
            details: { error: "unknown runner cli" },
          };
        }

        const { effectiveRunner, agentName, agentDefs } = resolveRunnerAndAgent(params);

        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (effectiveRunner === "pi" && agentName && currentAgent && agentName === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        const allowlist = getSubagentAllowlist();
        const permittedAgents = allowlist
          ? [...allowlist]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        // Strict whitelist at every depth.
        if (allowlist !== null) {
          if (!agentName) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `You are restricted to spawning specific agents via the "agent" field: ${permittedList}. ` +
                    `Direct CLI runner launches are not permitted.`,
                },
              ],
              details: { error: "agent required by allowlist" },
            };
          }
          if (!permittedSet.has(agentName)) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `You may not spawn the "${agentName}" agent — it is not ` +
                    `in your allowlist. Available agents: ${permittedList}.`,
                },
              ],
              details: { error: "agent not in allowlist" },
            };
          }
        } else if (agentName) {
          if (!permittedSet.has(agentName)) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `You may not spawn the "${agentName}" agent — it is not ` +
                    `a known agent. Available agents: ${permittedList}.`,
                },
              ],
              details: { error: "unknown agent" },
            };
          }
        } else if (!params.cli && !params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        }

        // Validate prerequisites (need Herdr + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Names are unique across the whole session: dedupe explicit labels as
        // well as defaulted ones, against running subagents, in-flight
        // reservations, and every name already in the registry. Reserve the
        // chosen name synchronously (before any await) so parallel spawns
        // don't collide.
        const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
        const requestedBase = params.name?.trim() || agentName || effectiveRunner;
        params.name = uniqueRunningName(requestedBase, registryNames);
        const reservedName: string = params.name;
        reservedNames.add(reservedName);

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        let running;
        try {
          running = await launchSubagent(params, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
        }

        // Persist name → session so subagent_message({ name }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        persistRunning(running, { create: true });

        // Start widget refresh and status supervision when the first agent launches
        ensureMonitorStarted();

        // Fire-and-forget: watch this turn and deliver one result steer.
        watchAndDeliver(running, { pi, updateWidget });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: running.agent,
            cli: running.cli,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const cliName =
          typeof partialArgs.cli === "string" && partialArgs.cli ? partialArgs.cli : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || cliName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agentTag =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const runnerTag =
          cliName && cliName !== "pi" ? theme.fg("accent", ` [${cliName}]`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agentTag +
          runnerTag +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = toolResultText(result);
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });
}
