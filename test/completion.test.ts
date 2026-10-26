import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  advanceCompletion,
  CompletionController,
  completionPolicyFor,
  createCompletionState,
  type CompletionObservation,
  type CompletionPolicy,
} from "../pi-extension/subagents/completion.ts";

const idlePolicy: CompletionPolicy = {
  mode: "idle-settle",
  idleSettleCount: 3,
  paneGraceMs: 1_000,
  stallAfterMs: 60_000,
  stallAction: "notify",
};

const sidecarPolicy: CompletionPolicy = { ...idlePolicy, mode: "sidecar" };

function observation(overrides: Partial<CompletionObservation> = {}): CompletionObservation {
  return {
    now: 0,
    pane: { kind: "present", status: "idle" },
    ...overrides,
  };
}

describe("completion.ts one-shot signals", () => {
  it("settles on an exit result before inspecting the pane", () => {
    const result = advanceCompletion(
      createCompletionState(0),
      observation({ exit: { reason: "error", exitCode: 1, errorMessage: "boom" } }),
      idlePolicy,
    );
    assert.deepEqual(result.result, { reason: "error", exitCode: 1, errorMessage: "boom" });
    assert.equal(result.state.settled, true);
  });

  it("settles on a parked signal only in sidecar mode", () => {
    assert.deepEqual(
      advanceCompletion(createCompletionState(0), observation({ parked: true }), sidecarPolicy).result,
      { reason: "done", exitCode: 0 },
    );
    assert.equal(
      advanceCompletion(createCompletionState(0), observation({ parked: true }), idlePolicy).result,
      null,
    );
  });

  it("settles on a sentinel file and a screen sentinel", () => {
    assert.deepEqual(
      advanceCompletion(createCompletionState(0), observation({ sentinel: true }), idlePolicy).result,
      { reason: "sentinel", exitCode: 0 },
    );
    assert.deepEqual(
      advanceCompletion(
        createCompletionState(0),
        observation({ screenTail: "noise\n__SUBAGENT_DONE_7__" }),
        idlePolicy,
      ).result,
      { reason: "sentinel", exitCode: 7 },
    );
  });

  it("ignores Herdr idle for sidecar (Pi) runners", () => {
    let state = createCompletionState(0);
    for (let i = 1; i <= 10; i++) {
      const step = advanceCompletion(
        state,
        observation({ now: i * 1_000, pane: { kind: "present", status: "idle" } }),
        sidecarPolicy,
      );
      state = step.state;
      assert.equal(step.result, null);
    }
  });
});

describe("completion.ts idle settle", () => {
  it("requires the settle count after observing work", () => {
    let state = createCompletionState(0);
    let step = advanceCompletion(
      state,
      observation({ now: 1_000, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    );
    state = step.state;
    assert.equal(step.result, null);

    for (let i = 1; i <= 2; i++) {
      step = advanceCompletion(
        state,
        observation({ now: 1_000 + i * 1_000, pane: { kind: "present", status: "idle" } }),
        idlePolicy,
      );
      state = step.state;
      assert.equal(step.result, null, `idle tick ${i} must not settle`);
    }

    step = advanceCompletion(
      state,
      observation({ now: 4_000, pane: { kind: "present", status: "idle" } }),
      idlePolicy,
    );
    assert.deepEqual(step.result, { reason: "done", exitCode: 0 });
  });

  it("resets the idle streak when the agent works again", () => {
    let state = createCompletionState(0);
    state = advanceCompletion(
      state,
      observation({ now: 1_000, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    ).state;
    state = advanceCompletion(
      state,
      observation({ now: 2_000, pane: { kind: "present", status: "idle" } }),
      idlePolicy,
    ).state;
    state = advanceCompletion(
      state,
      observation({ now: 3_000, pane: { kind: "present", status: "idle" } }),
      idlePolicy,
    ).state;
    state = advanceCompletion(
      state,
      observation({ now: 4_000, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    ).state;
    assert.equal(state.consecutiveIdle, 0);
  });

  it("does not settle on idle until work has been observed", () => {
    const result = advanceCompletion(
      createCompletionState(0),
      observation({ now: 10_000, pane: { kind: "present", status: "idle" } }),
      idlePolicy,
    );
    assert.equal(result.result, null);
  });

  it("keeps the streak alive while a native transcript is fresh", () => {
    let state = createCompletionState(0);
    state = advanceCompletion(
      state,
      observation({ now: 1_000, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    ).state;
    const result = advanceCompletion(
      state,
      observation({
        now: 2_000,
        pane: { kind: "present", status: "idle" },
        transcriptFresh: true,
      }),
      idlePolicy,
    );
    assert.equal(result.result, null);
    assert.equal(result.state.consecutiveIdle, 0);
  });
});

describe("completion.ts pane handling", () => {
  it("reports a missing pane after the grace window", () => {
    let state = createCompletionState(0);
    state = advanceCompletion(
      state,
      observation({ now: 500, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    ).state;

    const early = advanceCompletion(
      state,
      observation({ now: 900, pane: { kind: "missing" } }),
      idlePolicy,
    );
    assert.equal(early.result, null);

    const late = advanceCompletion(
      state,
      observation({ now: 1_100, pane: { kind: "missing" } }),
      idlePolicy,
    );
    assert.deepEqual(late.result, { reason: "done", exitCode: 0 });
  });

  it("never treats an unreadable pane as a stopped subagent", () => {
    let state = createCompletionState(0);
    state = advanceCompletion(
      state,
      observation({ now: 1_000, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    ).state;
    const result = advanceCompletion(
      state,
      observation({ now: 2_000, pane: { kind: "unavailable", error: "timeout" } }),
      idlePolicy,
    );
    assert.equal(result.result, null);
    assert.equal(result.state.paneUnavailableSince, 2_000);
  });
});

describe("completion.ts stall watchdog", () => {
  it("notifies once per quiet window without settling the turn", () => {
    let state = createCompletionState(0);
    state = advanceCompletion(
      state,
      observation({ now: 1_000, pane: { kind: "present", status: "working" } }),
      idlePolicy,
    ).state;
    state = advanceCompletion(
      state,
      observation({ now: 2_000, pane: { kind: "unavailable", error: "timeout" } }),
      idlePolicy,
    ).state;

    const first = advanceCompletion(
      state,
      observation({ now: 62_000, pane: { kind: "unavailable", error: "timeout" } }),
      idlePolicy,
    );
    assert.equal(first.stallNotice, true);
    assert.equal(first.result, null);
    state = first.state;

    const second = advanceCompletion(
      state,
      observation({ now: 63_000, pane: { kind: "unavailable", error: "timeout" } }),
      idlePolicy,
    );
    assert.equal(second.stallNotice, false);
    assert.equal(second.result, null);
  });

  it("settles as stalled only when the policy opts in", () => {
    const policy: CompletionPolicy = { ...idlePolicy, stallAction: "settle" };
    let state = createCompletionState(0);
    state = advanceCompletion(
      state,
      observation({ now: 1_000, pane: { kind: "present", status: "working" } }),
      policy,
    ).state;
    state = advanceCompletion(
      state,
      observation({ now: 2_000, pane: { kind: "unavailable", error: "timeout" } }),
      policy,
    ).state;
    const result = advanceCompletion(
      state,
      observation({ now: 62_000, pane: { kind: "unavailable", error: "timeout" } }),
      policy,
    );
    assert.equal(result.result?.reason, "stalled");
  });

  it("stalls on stale active activity but not on a waiting park", () => {
    const active = advanceCompletion(
      createCompletionState(0),
      observation({
        now: 60_000,
        pane: { kind: "present", status: "working" },
        activityPhase: "active",
        activityAgeMs: 60_000,
      }),
      idlePolicy,
    );
    assert.equal(active.stallNotice, true);

    const waiting = advanceCompletion(
      createCompletionState(0),
      observation({
        now: 60_000,
        pane: { kind: "present", status: "idle" },
        activityPhase: "waiting",
        activityAgeMs: 60_000,
      }),
      idlePolicy,
    );
    assert.equal(waiting.stallNotice, false);
  });
});

describe("completion.ts controller", () => {
  it("resolves through observe and rejects on abort", async () => {
    const controller = new CompletionController(idlePolicy, 0);
    controller.observe({
      now: 1_000,
      pane: { kind: "present", status: "working" },
    });
    controller.observe({ now: 2_000, pane: null, exit: { reason: "done", exitCode: 0 } });
    assert.deepEqual(await controller.result, { reason: "done", exitCode: 0 });

    const aborted = new CompletionController(idlePolicy, 0);
    aborted.abort();
    await assert.rejects(aborted.result, /Aborted while waiting/);
  });

  it("builds sidecar policy for Pi and idle policy for external runners", () => {
    assert.equal(
      completionPolicyFor({ idleCompletion: "never", nativeTranscriptFreshness: false }, { interactive: false }).mode,
      "sidecar",
    );
    assert.equal(
      completionPolicyFor({ idleCompletion: "settle", nativeTranscriptFreshness: true }, { interactive: false }).mode,
      "idle-settle",
    );
  });
});
