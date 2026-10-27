/** TypeBox schemas for the subagent tools. */
import { Type } from "@sinclair/typebox";
import { describeRunnerChoices } from "../runners/registry.ts";

export const SubagentParams = Type.Object({
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Which agent role profile to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
        "fixed profile — its model, tool loadout, and system prompt. Optional if `cli` is specified.",
    }),
  ),
  cli: Type.Optional(
    Type.String({
      description:
        describeRunnerChoices() +
        " When a non-pi CLI is specified, the subagent runs with that agent CLI in Herdr.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent profile or runner name. " +
        "Has no effect on which agent runs — use `agent` or `cli` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local configuration.",
    }),
  ),
  keepOpen: Type.Optional(
    Type.Boolean({
      description:
        "When true, the subagent pane stays open in Herdr after the task is completed instead of auto-closing. Useful when you or the user want to inspect the output or interact with the subagent directly.",
    }),
  ),
});
