import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { defaultInterrupt, handleSubagentInterrupt } from "../controls.ts";
import { toolResultText } from "./common.ts";

export function registerInterruptTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description:
      "Send Escape to the active turn of a running Pi subagent. The pane, session, and watcher stay alive; " +
      "the subagent remains steerable with subagent_message and can be closed with subagent_stop.",
    promptSnippet:
      "Send Escape to the active turn of a running Pi subagent. The pane, session, and watcher stay alive; " +
      "the subagent remains steerable with subagent_message and can be closed with subagent_stop.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact running subagent display name" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleSubagentInterrupt(
        params,
        defaultInterrupt,
        ctx?.sessionManager?.getSessionId?.(),
      );
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(args.name ?? "(unknown)")) +
          theme.fg("dim", " — interrupt turn"),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "interrupt_requested") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
            theme.fg("dim", " — interrupt requested"),
          0,
          0,
        );
      }
      const text = toolResultText(result);
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}
