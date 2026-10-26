/**
 * Pane layout policy.
 *
 * `PI_SUBAGENT_LAYOUT` is opt-in: leaving it unset preserves the historical
 * right split off the caller's pane. `split` enables smart tiling (split the
 * largest pane in the caller's tab), `split:down` always splits down, and
 * `tab` gives each subagent its own tab.
 */
import type { PaneRect } from "./herdr.ts";

export type SubagentLayoutMode = "right" | "down" | "tab" | "smart";

export function parseSubagentLayout(raw?: string | null): SubagentLayoutMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "tab") return "tab";
  if (value === "down" || value === "split:down") return "down";
  if (value === "split") return "smart";
  // Unset, "right", "split:right", and unknown values keep the current
  // behavior: a right split off the caller's pane.
  return "right";
}

export function resolveSubagentLayout(env: NodeJS.ProcessEnv = process.env): SubagentLayoutMode {
  return parseSubagentLayout(env.PI_SUBAGENT_LAYOUT);
}

export interface SplitChoice {
  target: string | null;
  direction: "right" | "down";
}

/** Split the longest dimension of the largest owned pane. */
export function chooseSplitTarget(
  callerPaneId: string | null,
  panes: PaneRect[],
  trackedPanes: Iterable<string> = [],
): SplitChoice {
  const ownedIds = new Set<string>();
  if (callerPaneId) ownedIds.add(callerPaneId);
  for (const id of trackedPanes) ownedIds.add(id);

  const owned = panes.filter((pane) => ownedIds.has(pane.paneId));
  if (owned.length === 0) {
    return { target: callerPaneId, direction: "right" };
  }

  let best = owned[0];
  for (const pane of owned) {
    if (pane.width * pane.height > best.width * best.height) best = pane;
  }
  // The caller wins ties so repeated spawns stay anchored to its pane.
  const caller = callerPaneId ? owned.find((pane) => pane.paneId === callerPaneId) : undefined;
  if (caller && caller.width * caller.height === best.width * best.height) {
    best = caller;
  }

  return {
    target: best.paneId,
    direction: best.width >= best.height ? "right" : "down",
  };
}
