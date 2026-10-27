import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgentDefinitions } from "../agents.ts";
import { getSubagentConfig } from "../config.ts";
import { parentModelForRunner } from "../launch-config.ts";
import { resolveModel } from "../model-config.ts";
import { normalizeRunner, RUNNER_KINDS } from "../runners/registry.ts";

export function registerListTool(pi: ExtensionAPI): void {
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const config = getSubagentConfig();
        const list = discoverAgentDefinitions()
          .filter((agent) => !agent.disableModelInvocation)
          .map((agent) => {
            const runner = normalizeRunner(agent.cli) ?? "pi";
            return {
              ...agent,
              resolvedModel: resolveModel({
                agentName: agent.name,
                agentModel: agent.model,
                config: config.models,
                env: process.env,
                parentModel: parentModelForRunner(runner, ctx?.model) ?? undefined,
              }).model,
            };
          });

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.resolvedModel ? ` [${a.resolvedModel}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        lines.push("");
        lines.push(`Supported CLI runners: ${RUNNER_KINDS.join(", ")} (specify via cli parameter)`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list, runners: RUNNER_KINDS },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const shownModel = a.resolvedModel ?? a.model;
          const model = shownModel ? theme.fg("dim", ` [${shownModel}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });
}
