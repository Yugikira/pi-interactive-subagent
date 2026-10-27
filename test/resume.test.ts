import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { setHerdrExecDeps } from "../pi-extension/subagents/herdr.ts";
import { stopMonitor } from "../pi-extension/subagents/monitor-host.ts";
import {
  readNameRegistry,
  registerName,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import { createFakeHerdr } from "./fake-herdr.ts";

interface MockApi {
  registeredTools: any[];
  sentMessages: any[];
  api: any;
}

function createMockApi(): MockApi {
  const registeredTools: any[] = [];
  const sentMessages: any[] = [];
  const api = {
    on() {},
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
    getAllTools() {
      return [];
    },
  };
  return { registeredTools, sentMessages, api };
}

const ENV_KEYS = ["PI_SUBAGENT_SHELL_READY_DELAY_MS", "PI_SUBAGENT_LAYOUT", "HERDR_PANE_ID"];

let dir: string;
let sessionDir: string;
let parentSessionId: string;
let artifactDir: string;
let world: ReturnType<typeof createFakeHerdr>;
let restoreHerdr: () => void;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resume-test-"));
  sessionDir = dir;
  parentSessionId = "parent-1";
  artifactDir = join(sessionDir, "artifacts", parentSessionId);
  mkdirSync(artifactDir, { recursive: true });

  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  process.env.PI_SUBAGENT_LAYOUT = "right";
  process.env.HERDR_PANE_ID = "caller-pane";

  world = createFakeHerdr({});
  restoreHerdr = setHerdrExecDeps(world.deps);
});

afterEach(async () => {
  const testApi = (subagentsModule as any).__test__;
  for (const running of testApi.runningSubagents.values()) {
    running.abortController?.abort();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  stopMonitor();
  testApi.runningSubagents.clear();
  testApi.reservedNames.clear();
  restoreHerdr();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function messageTool(mock: MockApi) {
  const tool = mock.registeredTools.find((candidate: any) => candidate.name === "subagent_message");
  assert.ok(tool, "expected subagent_message to be registered");
  return tool;
}

function context() {
  return {
    sessionManager: {
      getSessionFile: () => join(sessionDir, "parent.jsonl"),
      getSessionId: () => parentSessionId,
      getSessionDir: () => sessionDir,
    },
  };
}

async function resume(mock: MockApi, name: string, message: string) {
  const tool = messageTool(mock);
  return tool.execute("call-1", { name, message }, undefined, undefined, context());
}

function startCall() {
  return world.calls.find((args) => args[0] === "agent" && args[1] === "start");
}

describe("subagent_message resumes Claude and Agy", () => {
  it("relaunches Claude with --resume and the recorded argv", async () => {
    registerName(artifactDir, "claude-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: "claude-old",
      runner: "claude",
      cwd: dir,
      launchArgs: [
        "--dangerously-skip-permissions",
        "--model",
        "claude-sonnet-5-5",
      ],
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "claude-bot", "continue");

    assert.equal(result.details.status, "started");
    const start = startCall();
    assert.ok(start, "expected herdr agent start");
    assert.ok(start.includes("--resume"));
    assert.equal(start[start.indexOf("--resume") + 1], "claude-old");
    assert.equal(start[start.indexOf("--model") + 1], "claude-sonnet-5-5");
    assert.ok(start.includes("--dangerously-skip-permissions"));

    assert.deepEqual(world.prompts, [{ target: "claude-bot", text: "continue" }]);

    const entry = readNameRegistry(artifactDir)["claude-bot"];
    assert.equal(entry.surface, "pane-split-1");
    assert.match(entry.sessionId ?? "", /^claude-bot-session-/);

    const running = Array.from((subagentsModule as any).__test__.runningSubagents.values())[0] as any;
    assert.ok(running, "expected a running entry");
    assert.equal(running.cwd, dir);
    assert.equal(running.turnStartTime, running.startTime);
    assert.equal(running.sessionId, entry.sessionId);
    assert.equal(mock.registeredTools.length > 0, true);
  });

  it("relaunches Agy with --conversation and replayed model/effort", async () => {
    registerName(artifactDir, "agy-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: "conv-old",
      runner: "agy",
      cwd: dir,
      launchArgs: [
        "--dangerously-skip-permissions",
        "--model",
        "gemini-x",
        "--effort",
        "high",
      ],
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "agy-bot", "continue");

    assert.equal(result.details.status, "started");
    const start = startCall();
    assert.ok(start);
    assert.equal(start[start.indexOf("--conversation") + 1], "conv-old");
    assert.equal(start[start.indexOf("--model") + 1], "gemini-x");
    assert.equal(start[start.indexOf("--effort") + 1], "high");
    assert.deepEqual(world.prompts, [{ target: "agy-bot", text: "continue" }]);
  });

  it("refuses when the native session id was never recorded", async () => {
    registerName(artifactDir, "claude-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: null,
      runner: "claude",
      cwd: dir,
      launchArgs: ["--dangerously-skip-permissions"],
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "claude-bot", "continue");

    assert.match(result.content[0].text, /no recorded Claude Code session id/);
    assert.equal(world.calls.some((args) => args[0] === "pane" && args[1] === "split"), false);
  });

  it("refuses when the launch argv was never recorded", async () => {
    registerName(artifactDir, "claude-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: "claude-old",
      runner: "claude",
      cwd: dir,
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "claude-bot", "continue");
    assert.match(result.content[0].text, /no recorded launch arguments/);
  });

  it("refuses a runner with no resume contract", async () => {
    registerName(artifactDir, "codex-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: "codex-old",
      runner: "codex",
      cwd: dir,
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "codex-bot", "continue");
    assert.match(result.content[0].text, /cannot be resumed/);
  });

  it("steers a matching running entry instead of resuming", async () => {
    restoreHerdr();
    world = createFakeHerdr({ "pane-1": { agent: "claude-bot" } }, {
      agentNames: ["claude-bot"],
    });
    restoreHerdr = setHerdrExecDeps(world.deps);

    const testApi = (subagentsModule as any).__test__;
    testApi.runningSubagents.set("r1", {
      id: "r1",
      name: "claude-bot",
      herdrAgentName: "claude-bot",
      task: "first",
      cli: "claude",
      surface: "pane-1",
      startTime: Date.now(),
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "claude-bot", "steer me");

    assert.equal(result.details.status, "steered");
    assert.deepEqual(world.prompts, [{ target: "claude-bot", text: "steer me" }]);
    assert.equal(world.calls.some((args) => args[0] === "pane" && args[1] === "split"), false);
  });

  it("closes a leftover pane that still belongs to the recorded agent", async () => {
    restoreHerdr();
    world = createFakeHerdr({ "pane-old": { agent: "claude", sessionId: "claude-old" } });
    restoreHerdr = setHerdrExecDeps(world.deps);

    registerName(artifactDir, "claude-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: "claude-old",
      runner: "claude",
      cwd: dir,
      surface: "pane-old",
      herdrAgentName: "claude-bot",
      launchArgs: ["--dangerously-skip-permissions"],
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "claude-bot", "continue");

    assert.equal(result.details.status, "started");
    assert.ok(world.calls.some((args) => args[0] === "pane" && args[1] === "close" && args[2] === "pane-old"));
    assert.equal(readNameRegistry(artifactDir)["claude-bot"].surface, "pane-split-1");
  });

  it("reports a stop-first error when the agent name is still live in another pane", async () => {
    restoreHerdr();
    world = createFakeHerdr({
      "pane-other": { agent: "claude-bot", sessionId: "claude-old" },
    });
    restoreHerdr = setHerdrExecDeps(world.deps);

    registerName(artifactDir, "claude-bot", {
      sessionFile: join(sessionDir, "placeholder.jsonl"),
      sessionId: "claude-old",
      runner: "claude",
      cwd: dir,
      launchArgs: ["--dangerously-skip-permissions"],
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "claude-bot", "continue");

    assert.match(result.content[0].text, /Stop it first/);
    assert.equal(world.panes.has("pane-split-1"), false, "the failed pane must be closed");
  });

  it("keeps the Pi shell transport and scopes results to new entries", async () => {
    const sessionFile = join(sessionDir, "pi-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "pi-1" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [] } }),
      ].join("\n") + "\n",
      "utf8",
    );
    const loadout: SubagentLoadout = {
      agent: "scout",
      toolAllowlist: null,
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: dir,
      agentDir: null,
    };
    writeSubagentLoadout(sessionFile, loadout);
    registerName(artifactDir, "pi-bot", {
      sessionFile,
      sessionId: "pi-1",
      runner: "pi",
      cwd: dir,
    });
    const mock = createMockApi();
    (subagentsModule as any).default(mock.api);

    const result = await resume(mock, "pi-bot", "continue");

    assert.equal(result.details.status, "started");
    assert.equal(startCall(), undefined, "Pi resume must not use herdr agent start");
    assert.ok(world.runCommands.length > 0, "expected the shell command to be typed");
    const scriptPath = result.details.launchScriptFile;
    assert.ok(scriptPath, "expected a resume script");
    assert.match(readFileSync(scriptPath, "utf8"), /--session/);
    const running = Array.from((subagentsModule as any).__test__.runningSubagents.values())[0] as any;
    assert.equal(running.resumeFromLine, 2);
    assert.equal(running.sessionFile, sessionFile);
  });
});
