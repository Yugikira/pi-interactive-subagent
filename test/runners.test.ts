import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  describeRunnerChoices,
  getRunner,
  getRunnerOrDefault,
  isNativeSessionRunner,
  listRunners,
  normalizeRunner,
} from "../pi-extension/subagents/runners/registry.ts";
import { piAdapter } from "../pi-extension/subagents/runners/pi.ts";
import { agyAdapter } from "../pi-extension/subagents/runners/agy.ts";
import { claudeAdapter } from "../pi-extension/subagents/runners/claude.ts";
import type {
  RunnerLaunchContext,
  RunnerResultContext,
} from "../pi-extension/subagents/runners/types.ts";
import type { SubagentLoadout } from "../pi-extension/subagents/signals.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runners-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const emptyLoadout: SubagentLoadout = {
  agent: "scout",
  toolAllowlist: null,
  model: null,
  thinking: null,
  systemPromptMode: null,
  identity: null,
  spawnable: null,
  autoExit: false,
  cwd: null,
  agentDir: null,
};

function makeCtx(overrides: Partial<RunnerLaunchContext> = {}): RunnerLaunchContext {
  return {
    platform: "linux",
    id: "abc123",
    displayName: "scout",
    herdrAgentName: "scout",
    task: "do it",
    taskDelivery: "direct",
    cwd: "/tmp/work",
    model: null,
    thinking: null,
    agentName: "scout",
    agent: null,
    loadout: emptyLoadout,
    artifactDir: "/tmp/art",
    sessionFile: "/tmp/art/s.jsonl",
    activityFile: "/tmp/art/a.json",
    subagentDonePath: "/p/subagent-done.ts",
    autoExit: false,
    interactive: false,
    spawnable: null,
    agentDir: null,
    effectiveTools: undefined,
    effectiveSkills: undefined,
    grantSpawning: false,
    fullTask: "full task",
    ...overrides,
  };
}

function makeResultCtx(overrides: Partial<RunnerResultContext> = {}): RunnerResultContext {
  return {
    sessionFile: join(dir, "session.jsonl"),
    cwd: dir,
    turnStartTime: 0,
    agentName: "scout",
    readPane: () => "",
    ...overrides,
  };
}

describe("runner registry", () => {
  it("resolves canonical ids and aliases", () => {
    for (const id of ["pi", "agy", "claude", "codex", "grok", "opencode"]) {
      assert.equal(getRunner(id)?.id, id);
    }
    assert.equal(getRunner("antigravity")?.id, "agy");
    assert.equal(getRunner("claude-code")?.id, "claude");
    assert.equal(getRunner("openai-codex")?.id, "codex");
    assert.equal(getRunner("grok-cli")?.id, "grok");
    assert.equal(getRunner("open_code")?.id, "opencode");
    assert.equal(getRunner("nope"), undefined);
    assert.equal(getRunnerOrDefault("nope").id, "pi");
    assert.equal(normalizeRunner("  AGY  "), "agy");
  });

  it("advertises every canonical id and alias in the generated schema text", () => {
    const text = describeRunnerChoices();
    for (const adapter of listRunners()) {
      assert.ok(text.includes(`'${adapter.id}'`), `missing id ${adapter.id}`);
      for (const alias of adapter.aliases) {
        assert.ok(text.includes(alias), `missing alias ${alias}`);
      }
    }
  });

  it("declares capability flags per runner", () => {
    assert.equal(piAdapter.supportsTurnInterrupt, true);
    assert.equal(piAdapter.supportsResume, true);
    assert.equal(piAdapter.hasActivitySnapshots, true);
    assert.equal(piAdapter.idleCompletion, "never");

    assert.equal(agyAdapter.supportsTurnInterrupt, false);
    assert.equal(agyAdapter.idleCompletion, "settle");
    assert.equal(agyAdapter.nativeTranscriptFreshness, true);
    assert.equal(claudeAdapter.nativeTranscriptFreshness, true);

    assert.equal(isNativeSessionRunner("pi"), true);
    assert.equal(isNativeSessionRunner("agy"), true);
    assert.equal(isNativeSessionRunner("claude"), true);
    assert.equal(isNativeSessionRunner("codex"), false);
    assert.equal(isNativeSessionRunner("opencode"), false);
  });
});

describe("pi adapter launch plan", () => {
  it("builds raw argv for herdr agent start", () => {
    const plan = piAdapter.buildLaunch(
      makeCtx({ loadout: { ...emptyLoadout, model: "provider/model", thinking: "high" } }),
    );

    assert.deepEqual(plan.startArgs.slice(0, 4), [
      "--session",
      "/tmp/art/s.jsonl",
      "-e",
      "/p/subagent-done.ts",
    ]);
    assert.ok(plan.startArgs.includes("--model"));
    assert.ok(plan.startArgs.includes("provider/model:high"));
    assert.equal(plan.startArgs.at(-1), "full task");
    assert.equal(plan.prompt, null);
  });

  it("applies the default-deny sandbox and re-enables the spawning extension", () => {
    const plan = piAdapter.buildLaunch(
      makeCtx({ loadout: { ...emptyLoadout, toolAllowlist: "read,subagent" } }),
    );

    assert.ok(plan.startArgs.includes("--no-extensions"));
    assert.ok(plan.startArgs.includes("--tools"));
    assert.ok(plan.startArgs.includes("read,subagent"));
    // The spawning tools are backed by this extension's index.ts.
    assert.ok(
      plan.startArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("subagents/index.ts")),
      "expected the spawning-tool extension path",
    );
  });

  it("carries the spawn allowlist and agent dir in the pane env", () => {
    const plan = piAdapter.buildLaunch(
      makeCtx({ spawnable: ["scout", "researcher"], agentDir: "/agent/dir" }),
    );

    assert.equal(plan.env.PI_SUBAGENT_ALLOWED, "scout,researcher");
    assert.equal(plan.env.PI_CODING_AGENT_DIR, "/agent/dir");
    assert.equal(plan.env.PI_SUBAGENT_NAME, "scout");
    assert.equal(plan.env.PI_SUBAGENT_SESSION, "/tmp/art/s.jsonl");
    assert.equal(plan.env.PI_SUBAGENT_SURFACE, undefined);
  });

  it("omits PI_SUBAGENT_AUTO_EXIT when the effective child auto-exit is false", () => {
    const parked = piAdapter.buildLaunch(makeCtx({ autoExit: false }));
    assert.equal(parked.env.PI_SUBAGENT_AUTO_EXIT, undefined);

    const autoExit = piAdapter.buildLaunch(makeCtx({ autoExit: true }));
    assert.equal(autoExit.env.PI_SUBAGENT_AUTO_EXIT, "1");
  });

  it("renders a deterministic POSIX fallback command", () => {
    const plan = piAdapter.buildLaunch(makeCtx({ platform: "linux" }));
    assert.equal(
      plan.fallbackCommand,
      "cd '/tmp/work' && " +
        "PI_SUBAGENT_NAME='scout' PI_SUBAGENT_ID='abc123' " +
        "PI_SUBAGENT_SESSION='/tmp/art/s.jsonl' PI_SUBAGENT_ACTIVITY_FILE='/tmp/art/a.json' " +
        "PI_SUBAGENT_AGENT='scout' " +
        "pi '--session' '/tmp/art/s.jsonl' '-e' '/p/subagent-done.ts' 'full task'; " +
        "echo '__SUBAGENT_DONE_'$?'__'",
    );
  });

  it("renders a deterministic Windows fallback command", () => {
    const plan = piAdapter.buildLaunch(
      makeCtx({
        platform: "win32",
        cwd: "C:\\work",
        artifactDir: "C:\\art",
        sessionFile: "C:\\art\\s.jsonl",
        activityFile: "C:\\art\\a.json",
        subagentDonePath: "C:\\p\\subagent-done.ts",
      }),
    );
    assert.equal(
      plan.fallbackCommand,
      "Set-Location 'C:\\work'; " +
        "$env:PI_SUBAGENT_NAME='scout'; $env:PI_SUBAGENT_ID='abc123'; " +
        "$env:PI_SUBAGENT_SESSION='C:\\art\\s.jsonl'; " +
        "$env:PI_SUBAGENT_ACTIVITY_FILE='C:\\art\\a.json'; " +
        "$env:PI_SUBAGENT_AGENT='scout'; " +
        "& pi '--session' 'C:\\art\\s.jsonl' '-e' 'C:\\p\\subagent-done.ts' 'full task'; " +
        'echo "__SUBAGENT_DONE_$LASTEXITCODE__"',
    );
  });
});

describe("adapter result extraction", () => {
  it("extracts the last Pi assistant message", () => {
    const sessionFile = join(dir, "pi.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "p1" }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Pi done" }] },
        }),
      ].join("\n") + "\n",
    );

    assert.deepEqual(piAdapter.extractResult(makeResultCtx({ sessionFile })), {
      summary: "Pi done",
      sessionId: "p1",
    });
  });

  it("returns null for a missing Pi session", () => {
    assert.equal(piAdapter.extractResult(makeResultCtx()), null);
  });

  it("builds a protocol record prompt and reads the record back", () => {
    const recordFile = join(dir, ".pi", "temp", "subagent-records", "scout.jsonl");
    const ctx = makeCtx({ cwd: dir, herdrAgentName: "scout" });

    const protocolPlan = getRunner("codex")!.buildLaunch(ctx);
    assert.equal(protocolPlan.recordFile, recordFile);
    assert.match(protocolPlan.prompt ?? "", /\[Output Protocol\]/);
    assert.match(protocolPlan.prompt ?? "", /"turn": 1/);

    writeFileSync(
      recordFile,
      JSON.stringify({ turn: 1, timestamp: Date.now(), content: "codex done" }) + "\n",
    );
    assert.deepEqual(
      getRunner("codex")!.extractResult(
        makeResultCtx({ recordFile, turnStartTime: 0 }),
      ),
      { summary: "codex done" },
    );
  });
});
