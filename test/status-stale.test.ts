import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SNAPSHOT_STALLED_AFTER_MS,
  classifyStatus,
  createStatusState,
  observeStatus,
} from "../pi-extension/subagents/status.ts";

function activeState(observedAt: number) {
  const state = createStatusState({ source: "pi", startTimeMs: 0 });
  return observeStatus(
    state,
    {
      snapshot: "present",
      updatedAt: observedAt,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activityLabel: "bash",
    },
    observedAt,
  );
}

describe("status.ts stale activity", () => {
  it("ages a present active snapshot into stalled", () => {
    const state = activeState(1_000);

    assert.equal(
      classifyStatus(state, 1_000 + SNAPSHOT_STALLED_AFTER_MS - 1).kind,
      "active",
    );

    const stale = classifyStatus(state, 1_000 + SNAPSHOT_STALLED_AFTER_MS);
    assert.equal(stale.kind, "stalled");
    assert.equal(stale.statusLabel, "stale activity");
  });

  it("keeps a freshly observed active snapshot healthy", () => {
    const state = activeState(50_000);
    assert.equal(classifyStatus(state, 51_000).kind, "active");
  });

  it("does not age a waiting snapshot into stalled", () => {
    const state = createStatusState({ source: "pi", startTimeMs: 0 });
    const waiting = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 1_000,
        sequence: 1,
        phase: "waiting",
      },
      1_000,
    );

    const snapshot = classifyStatus(waiting, 10 * SNAPSHOT_STALLED_AFTER_MS);
    assert.equal(snapshot.kind, "waiting");
  });
});
