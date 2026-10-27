import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompletionController, type CompletionPolicy } from "../pi-extension/subagents/completion.ts";
import {
  createTicker,
  inspectEntry,
  runMonitorTick,
  type MonitorDeps,
  type MonitorEntry,
} from "../pi-extension/subagents/monitor.ts";
import { createStatusState, observeStatus } from "../pi-extension/subagents/status.ts";
import type { PaneSummary } from "../pi-extension/subagents/herdr.ts";

const sidecarPolicy: CompletionPolicy = {
  mode: "sidecar",
  idleSettleCount: 3,
  paneGraceMs: 1_000,
  stallAfterMs: 60_000,
  stallAction: "notify",
};

function makeEntry(overrides: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    id: "a1",
    name: "scout",
    cli: "pi",
    herdrAgentName: "scout",
    surface: "w1:p1",
    sessionFile: "/tmp/session.jsonl",
    startTime: 0,
    interactive: false,
    statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    now: () => 1_000,
    listPanes: async () => [],
    readActivity: async () => ({ ok: false, reason: "missing" }),
    readScreen: async () => "",
    consumeExit: () => null,
    consumeParked: () => null,
    consumeAsk: () => null,
    isTranscriptFresh: () => undefined,
    deliverQuestion: () => {},
    onTransitions: () => {},
    onWidgetDirty: () => {},
    statusEnabled: () => true,
    ...overrides,
  };
}

describe("monitor.ts pane mapping", () => {
  it("maps an unreadable inventory to unavailable, not gone", () => {
    assert.deepEqual(inspectEntry(makeEntry(), null), {
      kind: "unavailable",
      error: "pane inventory unavailable",
    });
  });

  it("identifies a pane by its surface even when another pane shares the runner kind", () => {
    const entry = makeEntry({ herdrAgentName: "pi", surface: "w1:p2" });
    const panes: PaneSummary[] = [
      { paneId: "w1:p1", agent: "pi", agentStatus: "idle", agentSessionValue: "parent" },
      { paneId: "w1:p2", agent: "pi", agentStatus: "working", agentSessionValue: "child" },
    ];

    assert.deepEqual(inspectEntry(entry, panes), {
      kind: "present",
      status: "working",
      sessionId: "child",
    });
  });

  it("maps a missing agent to missing and a present one to its status", () => {
    assert.deepEqual(inspectEntry(makeEntry(), []), { kind: "missing" });

    const panes: PaneSummary[] = [
      { paneId: "w1:p1", agent: "scout", agentStatus: "working", agentSessionValue: "s1" },
    ];
    assert.deepEqual(inspectEntry(makeEntry(), panes), {
      kind: "present",
      status: "working",
      sessionId: "s1",
    });

    // A pane that exists before Herdr registers its agent is not "gone".
    assert.deepEqual(inspectEntry(makeEntry(), [{ paneId: "w1:p1" }]), {
      kind: "present",
      status: "unknown",
      sessionId: undefined,
    });
  });
});

describe("monitor.ts tick", () => {
  it("feeds a completion controller and resolves on a signal", async () => {
    const controller = new CompletionController(sidecarPolicy, 0);
    const entry = makeEntry({ completion: controller });
    const deps = makeDeps({
      consumeExit: () => ({ reason: "error", exitCode: 1, errorMessage: "boom" }),
    });

    await runMonitorTick([entry], deps);

    assert.deepEqual(await controller.result, {
      reason: "error",
      exitCode: 1,
      errorMessage: "boom",
    });
  });

  it("caches the pane's native session id on the entry", async () => {
    const entry = makeEntry();
    const deps = makeDeps({
      listPanes: async () => [
        {
          paneId: "w1:p1",
          agent: "scout",
          agentStatus: "working",
          agentSessionValue: "native-session-1",
        },
      ],
    });

    await runMonitorTick([entry], deps);

    assert.equal(entry.sessionId, "native-session-1");
  });

  it("reports a new or changed native session id for non-Pi runners", async () => {
    const seen: Array<{ id: string; previous: string | undefined }> = [];
    const entry = makeEntry({ cli: "claude", sessionId: "native-1" });
    const deps = makeDeps({
      listPanes: async () => [
        {
          paneId: "w1:p1",
          agent: "scout",
          agentStatus: "working",
          agentSessionValue: "native-1",
        },
      ],
      onSessionId: (_entry, id, previous) => seen.push({ id, previous }),
    });

    await runMonitorTick([entry], deps);
    assert.deepEqual(seen, [], "an unchanged id must not fire the callback");

    deps.listPanes = async () => [
      {
        paneId: "w1:p1",
        agent: "scout",
        agentStatus: "working",
        agentSessionValue: "native-2",
      },
    ];
    await runMonitorTick([entry], deps);

    assert.deepEqual(seen, [{ id: "native-2", previous: "native-1" }]);
    assert.equal(entry.sessionId, "native-2");
  });

  it("does not overwrite a Pi header id with a changed pane value", async () => {
    const entry = makeEntry({ cli: "pi", sessionId: "header-id" });
    const deps = makeDeps({
      listPanes: async () => [
        {
          paneId: "w1:p1",
          agent: "scout",
          agentStatus: "working",
          agentSessionValue: "other-value",
        },
      ],
    });

    await runMonitorTick([entry], deps);
    assert.equal(entry.sessionId, "header-id");
  });

  it("does not settle a child when a same-kind sibling pane is done", async () => {
    const controller = new CompletionController(sidecarPolicy, 0);
    const entry = makeEntry({
      cli: "pi",
      herdrAgentName: "pi",
      surface: "w1:p2",
      completion: controller,
    });
    const deps = makeDeps({
      listPanes: async () => [
        { paneId: "w1:p1", agent: "pi", agentStatus: "done" },
        { paneId: "w1:p2", agent: "pi", agentStatus: "working" },
      ],
    });

    await runMonitorTick([entry], deps);

    let settled = false;
    controller.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, "the child's own working pane must win");
  });

  it("delivers a question exactly once", async () => {
    let delivered = 0;
    let pending = true;
    const entry = makeEntry();
    const deps = makeDeps({
      consumeAsk: () => {
        if (!pending) return null;
        pending = false;
        return { question: "which branch?" };
      },
      deliverQuestion: () => {
        delivered++;
      },
    });

    await runMonitorTick([entry], deps);
    await runMonitorTick([entry], deps);

    assert.equal(delivered, 1);
  });

  it("batches stalled transitions", async () => {
    let now = 0;
    let transitions: Parameters<MonitorDeps["onTransitions"]>[0] = [];
    const state = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 0,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
      },
      0,
    );
    const entry = makeEntry({ statusState: state });
    const deps = makeDeps({
      now: () => now,
      listPanes: async () => [],
      onTransitions: (items) => {
        transitions = items;
      },
    });

    now = 1_000;
    await runMonitorTick([entry], deps);
    assert.equal(transitions.length, 0);

    now = 62_000;
    await runMonitorTick([entry], deps);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].transition, "stalled");
    assert.equal(transitions[0].entry.name, "scout");
  });

  it("returns false when there is nothing to observe", async () => {
    assert.equal(await runMonitorTick([], makeDeps()), false);
  });
});

describe("monitor.ts ticker", () => {
  it("drops overlapping ticks instead of piling them up", async () => {
    let resolvePanes!: (panes: PaneSummary[] | null) => void;
    let calls = 0;
    const deps = makeDeps({
      listPanes: () => {
        calls++;
        return new Promise<PaneSummary[] | null>((resolve) => {
          resolvePanes = resolve;
        });
      },
    });
    const ticker = createTicker(() => [makeEntry()], deps, 10);

    const first = ticker.tick();
    const second = await ticker.tick();
    assert.equal(second, true, "the overlapping tick is skipped");
    assert.equal(ticker.skippedTicks, 1);

    resolvePanes([]);
    await first;
    assert.equal(calls, 1, "only one observation ran");
    ticker.stop();
  });

  it("stops its timer", () => {
    const ticker = createTicker(() => [makeEntry()], makeDeps(), 10);
    ticker.start();
    ticker.stop();
    assert.equal(ticker.skippedTicks, 0);
  });

  it("exposes a running flag and restarts after stopping", () => {
    const ticker = createTicker(() => [makeEntry()], makeDeps(), 10);
    assert.equal(ticker.running, false);
    ticker.start();
    assert.equal(ticker.running, true);
    ticker.stop();
    assert.equal(ticker.running, false);
    ticker.start();
    assert.equal(ticker.running, true);
    ticker.stop();
  });

  it("marks itself stopped when there is nothing to observe", async () => {
    const ticker = createTicker(() => [], makeDeps(), 10);
    ticker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ticker.running, false);
    ticker.stop();
  });
});
