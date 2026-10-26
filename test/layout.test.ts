import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chooseSplitTarget,
  parseSubagentLayout,
  resolveSubagentLayout,
} from "../pi-extension/subagents/layout.ts";
import {
  createSurface,
  parsePaneLayout,
  setHerdrExecDeps,
} from "../pi-extension/subagents/herdr.ts";

const layoutJson = JSON.stringify({
  result: {
    layout: {
      tab_id: "w1:t1",
      panes: [
        { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 120, height: 40 } },
        { pane_id: "w1:p2", rect: { x: 120, y: 0, width: 60, height: 20 } },
      ],
    },
  },
});

describe("layout.ts parsing", () => {
  it("keeps right split as the default", () => {
    assert.equal(parseSubagentLayout(undefined), "right");
    assert.equal(parseSubagentLayout(""), "right");
    assert.equal(parseSubagentLayout("right"), "right");
    assert.equal(parseSubagentLayout("split:right"), "right");
    assert.equal(parseSubagentLayout("unknown"), "right");
  });

  it("supports split, down, and tab modes", () => {
    assert.equal(parseSubagentLayout("split"), "smart");
    assert.equal(parseSubagentLayout("split:down"), "down");
    assert.equal(parseSubagentLayout("down"), "down");
    assert.equal(parseSubagentLayout("tab"), "tab");
    assert.equal(parseSubagentLayout(" TAB "), "tab");
    assert.equal(resolveSubagentLayout({ PI_SUBAGENT_LAYOUT: "split" }), "smart");
  });
});

describe("layout.ts tiling", () => {
  const panes = parsePaneLayout(layoutJson)!.panes;

  it("falls back to the caller when no owned pane is present", () => {
    assert.deepEqual(chooseSplitTarget("w1:p9", [], []), {
      target: "w1:p9",
      direction: "right",
    });
  });

  it("splits the largest owned pane and picks its long dimension", () => {
    assert.deepEqual(chooseSplitTarget("w1:p2", panes, ["w1:p2"]), {
      target: "w1:p2",
      direction: "right",
    });

    const tall = parsePaneLayout(
      JSON.stringify({
        result: {
          layout: {
            tab_id: "t",
            panes: [{ pane_id: "p1", rect: { x: 0, y: 0, width: 20, height: 60 } }],
          },
        },
      }),
    )!.panes;
    assert.deepEqual(chooseSplitTarget("p1", tall, []), {
      target: "p1",
      direction: "down",
    });
  });

  it("lets the caller win an area tie", () => {
    const tied = parsePaneLayout(
      JSON.stringify({
        result: {
          layout: {
            tab_id: "t",
            panes: [
              { pane_id: "p1", rect: { x: 0, y: 0, width: 40, height: 20 } },
              { pane_id: "p2", rect: { x: 40, y: 0, width: 40, height: 20 } },
            ],
          },
        },
      }),
    )!.panes;

    assert.equal(chooseSplitTarget("p1", tied, ["p2"]).target, "p1");
  });
});

describe("herdr.ts layout primitives", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("parses pane geometry", () => {
    assert.deepEqual(parsePaneLayout(layoutJson), {
      tabId: "w1:t1",
      panes: [
        { paneId: "w1:p1", width: 120, height: 40, x: 0, y: 0 },
        { paneId: "w1:p2", width: 60, height: 20, x: 120, y: 0 },
      ],
    });
    assert.equal(parsePaneLayout("nope"), null);
  });

  it("anchors a split to the caller pane instead of --current", () => {
    const previous = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w1:p1";
    const calls: string[][] = [];
    restore = setHerdrExecDeps({
      available: () => true,
      run: (args) => {
        calls.push(args);
        return JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } });
      },
    });

    try {
      createSurface("scout", { layout: "right" });
      const paneIndex = calls[0].indexOf("--pane");
      assert.ok(paneIndex >= 0, "expected --pane");
      assert.equal(calls[0][paneIndex + 1], "w1:p1");
      assert.equal(calls[0].includes("--current"), false);
    } finally {
      if (previous === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previous;
    }
  });

  it("creates a tab and returns its root pane", () => {
    const calls: string[][] = [];
    restore = setHerdrExecDeps({
      available: () => true,
      run: (args) => {
        calls.push(args);
        return JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" } } });
      },
    });

    const pane = createSurface("scout", { layout: "tab", cwd: "/tmp/work" });
    assert.equal(pane, "w1:p9");
    assert.deepEqual(calls[0].slice(0, 4), ["tab", "create", "--no-focus", "--cwd"]);
  });

  it("splits the requested pane in the requested direction", () => {
    const calls: string[][] = [];
    restore = setHerdrExecDeps({
      available: () => true,
      run: (args) => {
        calls.push(args);
        return JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } });
      },
    });

    const pane = createSurface("scout", {
      layout: "down",
      fromSurface: "w1:p1",
      cwd: "/tmp/work",
      env: { A: "1" },
    });
    assert.equal(pane, "w1:p3");
    assert.deepEqual(calls[0].slice(0, 7), [
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "down",
      "--no-focus",
    ]);
    assert.ok(calls[0].includes("A=1"));
  });
});
