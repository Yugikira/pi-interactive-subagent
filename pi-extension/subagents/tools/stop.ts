import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  artifactDirForContext,
  stopCompletedByName,
  terminateRunning,
} from "../controls.ts";
import { formatStopMessage } from "../format.ts";
import { updateWidget } from "../monitor-host.ts";
import { runningSubagents, type RunningSubagent } from "../runtime.ts";
import { toolResultText } from "./common.ts";

export function registerStopTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_stop",
    label: "Stop Subagent",
    description:
      "Stop a running subagent, abort its background watcher, dismiss its UI widget, and optionally close its pane in Herdr. " +
      "Use this when a subagent is no longer needed, was closed by the user, has errored or stalled, or needs to be terminated. " +
      "A completed keepOpen subagent can also be stopped by name: its leftover pane is resolved through the session's name registry.",
    promptSnippet:
      "Stop a running subagent by name (or a completed keepOpen one), dismiss its UI widget, and optionally close its pane.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Display name of the subagent to stop. If omitted and only one subagent is running, stops that subagent.",
        }),
      ),
      closePane: Type.Optional(
        Type.Boolean({
          description: "Whether to close the pane in Herdr. Defaults to true.",
        }),
      ),
    }),

    renderCall(args, theme) {
      const target = args.name ?? "(current)";
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — stop"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.stopped) {
        const label = theme.fg("toolTitle", theme.bold(details.name ?? "subagent"));
        return new Text(
          details.warning
            ? theme.fg("error", "⚠") + " " + label + theme.fg("error", " — pane still open")
            : theme.fg("success", "✓") + " " + label + theme.fg("dim", " — stopped"),
          0,
          0,
        );
      }
      const text = toolResultText(result);
      return new Text(theme.fg("dim", text), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx?.sessionManager?.getSessionId?.();
      const artifactDir = artifactDirForContext(ctx);
      const visible = Array.from(runningSubagents.values()).filter(
        (r) => !r.parentSessionId || r.parentSessionId === parentSessionId,
      );

      if (visible.length === 0) {
        // A keepOpen subagent that has finished is no longer in the running
        // map, but its pane still exists. The name registry is the only handle
        // left, and a named stop must be able to close it.
        if (params.name?.trim()) {
          const fallback = stopCompletedByName(
            params.name.trim(),
            artifactDir,
            params.closePane !== false,
          );
          if (fallback.handled) {
            return {
              content: [{ type: "text", text: fallback.message }],
              details: fallback.details ?? { stopped: false, reason: "registry" },
            };
          }
        }
        return {
          content: [{ type: "text", text: "No subagents are currently running." }],
          details: { stopped: false, reason: "none_running" },
        };
      }

      let target: RunningSubagent | undefined;
      if (params.name?.trim()) {
        const requested = params.name.trim().toLowerCase();
        target = visible.find((r) => r.name.toLowerCase() === requested);
        if (!target) {
          const fallback = stopCompletedByName(
            params.name.trim(),
            artifactDir,
            params.closePane !== false,
          );
          if (fallback.handled) {
            return {
              content: [{ type: "text", text: fallback.message }],
              details: fallback.details ?? { stopped: false, reason: "registry" },
            };
          }
          const names = visible.map((r) => r.name);
          return {
            content: [
              {
                type: "text",
                text: `No running subagent named "${params.name.trim()}". Currently running: ${names.join(", ")}.`,
              },
            ],
            details: { stopped: false, error: "not_found" },
          };
        }
      } else if (visible.length === 1) {
        target = visible[0];
      } else {
        const names = visible.map((r) => r.name);
        return {
          content: [
            {
              type: "text",
              text: `Multiple subagents are running (${names.join(", ")}). Please specify the name of the subagent to stop.`,
            },
          ],
          details: { stopped: false, error: "ambiguous" },
        };
      }

      const closePane = params.closePane !== false;
      const outcome = terminateRunning(target, closePane);
      target.abortController?.abort();
      runningSubagents.delete(target.id);
      updateWidget();

      // Report a pane that survived instead of claiming a clean stop. Scoped to
      // pi because it is the runner whose stop path was changed; every other
      // runner keeps its previous messaging.
      const failed = target.cli === "pi" && closePane && !outcome.ok && !outcome.paneClosed;
      const message = formatStopMessage(target.name, outcome);

      return {
        content: [
          {
            type: "text",
            text: failed ? message : `Sub-agent "${target.name}" stopped and dismissed.`,
          },
        ],
        details: {
          stopped: true,
          name: target.name,
          id: target.id,
          paneClosed: outcome.paneClosed,
          ...(failed ? { warning: message } : {}),
        },
      };
    },
  });
}
