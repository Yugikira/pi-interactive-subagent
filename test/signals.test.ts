import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  askSignalPath,
  consumeAskSignal,
  consumeExitSignal,
  consumeJson,
  consumeParkedSignal,
  exitSignalPath,
  interpretExitSignal,
  isFreshSignal,
  loadoutPath,
  parkedSignalPath,
  readLoadout,
  readNameRegistry,
  writeAskSignal,
  writeExitSignal,
  writeJsonAtomic,
  writeLoadout,
  writeNameRegistry,
  writeParkedSignal,
  type SubagentLoadout,
} from "../pi-extension/subagents/signals.ts";
import { updateNameRegistryEntry } from "../pi-extension/subagents/session.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "signals-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sessionPath(name = "session"): string {
  return join(dir, `${name}.jsonl`);
}

function listTemps(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("name registry patches", () => {
  it("merges fields without dropping resume metadata", () => {
    writeNameRegistry(dir, {
      scout: {
        sessionFile: "/s.jsonl",
        sessionId: "native-1",
        runner: "claude",
        launchArgs: ["--dangerously-skip-permissions"],
        cwd: "/work",
      },
    });

    updateNameRegistryEntry(dir, "scout", { surface: "pane-2" });

    const entry = readNameRegistry(dir).scout;
    assert.equal(entry.surface, "pane-2");
    assert.deepEqual(entry.launchArgs, ["--dangerously-skip-permissions"]);
    assert.equal(entry.cwd, "/work");
    assert.equal(entry.sessionId, "native-1");
  });

  it("never creates a half-populated entry", () => {
    updateNameRegistryEntry(dir, "missing", { surface: "pane-3" });
    assert.equal(readNameRegistry(dir).missing, undefined);
  });
});

describe("signals.ts atomic writes", () => {
  it("writes complete JSON and leaves no temp files", () => {
    const path = join(dir, "payload.json");
    writeJsonAtomic(path, { hello: "world" });

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { hello: "world" });
    assert.deepEqual(listTemps(), []);
  });

  it("overwrites an existing payload without exposing a partial file", () => {
    const path = join(dir, "payload.json");
    writeJsonAtomic(path, { n: 1 });
    writeJsonAtomic(path, { n: 2 });

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { n: 2 });
    assert.deepEqual(listTemps(), []);
  });
});

describe("signals.ts consumeJson", () => {
  it("returns null and keeps a fresh partial payload for retry", () => {
    const path = join(dir, "partial.json");
    writeFileSync(path, '{"question":');

    const result = consumeJson(path, (value) => value as { question: string });

    assert.equal(result, null);
    assert.equal(existsSync(path), true, "partial payload must survive for the next tick");
  });

  it("consumes the payload once it becomes valid", () => {
    const path = join(dir, "partial.json");
    writeFileSync(path, '{"question":');

    assert.equal(consumeJson(path, (value) => value as { question: string }), null);
    writeFileSync(path, '{"question":"why?"}');

    assert.deepEqual(
      consumeJson(path, (value) => value as { question: string }),
      { question: "why?" },
    );
    assert.equal(existsSync(path), false);
  });

  it("reaps a malformed payload once it is older than the retry window", () => {
    const path = join(dir, "poison.json");
    writeFileSync(path, "{not json");
    utimesSync(path, new Date(0), new Date(0));

    const result = consumeJson(path, (value) => value as object, {
      maxInvalidAgeMs: 1_000,
      now: Date.now(),
    });

    assert.equal(result, null);
    assert.equal(existsSync(path), false, "a permanently malformed payload must not wedge polling");
  });

  it("keeps a malformed payload that is still inside the retry window", () => {
    const path = join(dir, "poison.json");
    writeFileSync(path, "{not json");

    const result = consumeJson(path, (value) => value as object, {
      maxInvalidAgeMs: 60_000,
      now: Date.now(),
    });

    assert.equal(result, null);
    assert.equal(existsSync(path), true);
  });
});

describe("signals.ts exit / parked / ask codecs", () => {
  it("interprets error payloads and treats unknown payloads as done", () => {
    assert.deepEqual(interpretExitSignal({ type: "error", errorMessage: "boom" }), {
      reason: "error",
      exitCode: 1,
      errorMessage: "boom",
    });
    assert.deepEqual(interpretExitSignal({ type: "done" }), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSignal({}), { reason: "done", exitCode: 0 });
  });

  it("accepts a fresh exit signal and consumes it once", () => {
    const file = sessionPath();
    writeExitSignal(file, { errorMessage: "overloaded", stopReason: "error" });

    const result = consumeExitSignal(file, 0);
    assert.equal(result?.reason, "error");
    assert.equal(result?.errorMessage, "overloaded");
    assert.equal(existsSync(exitSignalPath(file)), false);
    assert.equal(consumeExitSignal(file, 0), null);
  });

  it("drops a stale exit signal from a previous turn", () => {
    const file = sessionPath();
    writeJsonAtomic(exitSignalPath(file), {
      type: "error",
      errorMessage: "old",
      writtenAt: 100,
    });

    assert.equal(consumeExitSignal(file, 200), null);
    assert.equal(existsSync(exitSignalPath(file)), false);
  });

  it("accepts legacy exit payloads without writtenAt", () => {
    const file = sessionPath();
    writeJsonAtomic(exitSignalPath(file), { type: "done" });

    assert.deepEqual(consumeExitSignal(file, Date.now()), { reason: "done", exitCode: 0 });
  });

  it("accepts a fresh parked signal and drops a stale one", () => {
    const file = sessionPath();
    writeParkedSignal(file, { name: "scout", agent: "scout" });

    assert.deepEqual(consumeParkedSignal(file, 0), { reason: "done", exitCode: 0 });

    writeJsonAtomic(parkedSignalPath(file), { parkedAt: 100, name: "scout" });
    assert.equal(consumeParkedSignal(file, 200), null);
    assert.equal(existsSync(parkedSignalPath(file)), false);
  });

  it("consumes an ask signal exactly once and ignores empty questions", () => {
    const file = sessionPath();
    writeAskSignal(file, { name: "worker", question: "which branch?" });

    const ask = consumeAskSignal(file);
    assert.equal(ask?.name, "worker");
    assert.equal(ask?.question, "which branch?");
    assert.equal(typeof ask?.writtenAt, "number");
    assert.equal(consumeAskSignal(file), null);

    writeJsonAtomic(askSignalPath(file), { question: "   " });
    assert.equal(consumeAskSignal(file), null);
    assert.equal(existsSync(askSignalPath(file)), true, "invalid payload is retried");
  });

  it("isFreshSignal accepts the turn start boundary", () => {
    assert.equal(isFreshSignal(100, 100), true);
    assert.equal(isFreshSignal(99, 100), false);
  });
});

describe("signals.ts loadout and registry", () => {
  const loadout: SubagentLoadout = {
    agent: "worker",
    toolAllowlist: "read,write",
    model: "provider/model",
    thinking: "high",
    systemPromptMode: "append",
    identity: "identity",
    spawnable: ["scout"],
    autoExit: true,
    cwd: "/tmp/project",
    agentDir: null,
  };

  it("round-trips a loadout and leaves no temp files", () => {
    const file = sessionPath();
    writeLoadout(file, loadout);

    assert.deepEqual(readLoadout(file), loadout);
    assert.equal(loadoutPath(file), `${file}.loadout.json`);
    assert.deepEqual(listTemps(), []);
  });

  it("returns null for a missing or corrupt loadout", () => {
    const file = sessionPath();
    assert.equal(readLoadout(file), null);

    writeFileSync(loadoutPath(file), "{broken");
    assert.equal(readLoadout(file), null);
  });

  it("reads a missing registry as empty and persists entries atomically", () => {
    assert.deepEqual(readNameRegistry(dir), {});

    writeNameRegistry(dir, {
      scout: { sessionFile: "/tmp/scout.jsonl", sessionId: "s1", runner: "pi" },
    });

    assert.deepEqual(readNameRegistry(dir), {
      scout: { sessionFile: "/tmp/scout.jsonl", sessionId: "s1", runner: "pi" },
    });
    assert.deepEqual(listTemps(), []);
  });
});
