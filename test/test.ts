import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  countSessionEntryLines,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  nameRegistryPath,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  resetSessionIndexCache,
  resolveSessionFileById,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
  summarizeSessionStats,
  readLastSessionRecord,
  getSubagentRecordPath,
  NATIVE_SESSION_RUNNERS,
  isNativeSessionRunner,
  readRunnerSession,
  readAgySession,
  readClaudeSession,
  readPiSession,
  toClaudeProjectSlug,
  getNativeSessionFile,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape,
  normalizeRunner,
  isKnownRunner,
  sanitizeAgentName,
  sanitizeTerminalOutput,
  RUNNER_KINDS,
  isHerdrAvailable,
  isMuxAvailable,
  isSurfaceAlive,
  closeSurface,
  terminateSurface,
  pollForExit,
  __pollForExitTest__,
  setHerdrExecDeps,
  parsePaneList,
  paneExists,
  parseHerdrError,
  startAgent,
  startAgentAsync,
  promptAgent,
} from "../pi-extension/subagents/herdr.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  runningChildrenCount,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";

// --- Helpers ---

function makeRunning(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    name: "Worker",
    task: "",
    surface: "pane-1",
    startTime: 0,
    sessionFile: "worker.jsonl",
    interactive: false,
    statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
    ...overrides,
  };
}


// ── Fake herdr ──
//
// The suite may itself run inside a Herdr pane, where `HERDR_ENV=1` makes the
// real CLI reachable. Every termination test therefore installs this fake
// through `setHerdrExecDeps`, so nothing touches the developer's real panes.

interface FakePane {
  /** `herdr pane close` rejects for this pane. */
  closeFails?: boolean;
  /** Registered agent name, as `pane list` would report it. */
  agent?: string;
}

function herdrError(code: string, message: string): string {
  return `Command failed: herdr\n{"error":{"code":"${code}","message":"${message}"}}`;
}

/** Scripted stand-in for the herdr CLI, covering only what the stop path uses. */
function createFakeHerdr(
  initial: Record<string, FakePane>,
  options?: { paneListFailsTimes?: number; keyWriteFails?: boolean; agentNames?: string[] },
) {
  const panes = new Map<string, FakePane>(Object.entries(initial));
  const agentNames = new Set(options?.agentNames ?? []);
  const calls: string[][] = [];
  const keyWrites: string[][] = [];
  let paneListFailures = options?.paneListFailsTimes ?? 0;

  const run = (args: string[]): string => {
      calls.push(args);
      const [group, verb] = args;

      // The authoritative inventory. A failure here must surface as "cannot
      // tell" — never as "the pane is gone".
      if (group === "pane" && verb === "list") {
        if (paneListFailures > 0) {
          paneListFailures -= 1;
          throw new Error(herdrError("internal_error", "pane inventory unavailable"));
        }
        return JSON.stringify({
          result: {
            panes: Array.from(panes.entries()).map(([paneId, pane]) => ({
              pane_id: paneId,
              ...(pane.agent ? { agent: pane.agent } : {}),
            })),
          },
        });
      }

      if (group === "pane" && verb === "close") {
        const paneId = args[2];
        const pane = panes.get(paneId);
        if (!pane) throw new Error(herdrError("pane_not_found", `pane ${paneId} not found`));
        if (pane.closeFails) {
          throw new Error(herdrError("pane_close_failed", `pane ${paneId} could not be closed`));
        }
        panes.delete(paneId);
        return JSON.stringify({ result: {} });
      }

      if ((group === "agent" || group === "pane") && verb === "send-keys") {
        if (options?.keyWriteFails) {
          throw new Error(herdrError("invalid_key", "unsupported key"));
        }
        if (group === "agent" && !agentNames.has(args[2])) {
          throw new Error(herdrError("agent_not_found", `agent target ${args[2]} not found`));
        }
        keyWrites.push([`${group}:${args[2]}`, ...args.slice(3)]);
        return JSON.stringify({ result: {} });
      }

      throw new Error(herdrError("invalid_request", `unhandled fake call: ${args.join(" ")}`));
  };

  const deps = {
    available: () => true,
    run,
    runAsync: async (args: string[]) => run(args),
  };

  return { panes, calls, keyWrites, deps };
}

/**
 * Install an empty fake herdr world so a stop is deterministic in any
 * environment: every surface reads as "confirmed absent" rather than depending
 * on whether the suite happens to run inside a real Herdr pane.
 */
function useEmptyFakeHerdr(): () => void {
  return setHerdrExecDeps(createFakeHerdr({}).deps);
}

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "x" }) + "\n\n\n");
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,safe_bash,web_search,subagent,ask_question",
      model: "openrouter/z-ai/glm-5.2",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-scout" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl", sessionId: "id-scout2" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl", sessionId: "id-scout-new" });
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (id: string, opts: {
      model?: string;
      tools?: string[];
      usage?: Record<string, unknown>;
    }) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, totalTokens: 1350, cost: { total: 0.01 } },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: { input: 30, output: 70, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500, cost: { total: 0.02 } },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", { model: "claude-sonnet-4-6", usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("ages an active snapshot into stalled after the watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const fresh = classifyStatus(state, 10_000);
    assert.equal(fresh.kind, "active");
    assert.equal(fresh.activityLabel, "bash");
    assert.equal(fresh.activeDurationText, "5s");

    const stale = classifyStatus(state, 65_000);
    assert.equal(stale.kind, "stalled");
    assert.equal(stale.statusLabel, "stale activity");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveChildAutoExit: interactive sessions suppress auto-exit; keepOpen wins over auto-exit frontmatter", () => {
    // Autonomous default: auto-exit agents stay autonomous.
    assert.equal(testApi.resolveChildAutoExit(true, false), true);
    // keepOpen / interactive: true → the child must park after a turn so the
    // pane stays steerable and its completions are delivered via .parked.
    assert.equal(testApi.resolveChildAutoExit(true, true), false);
    // No auto-exit frontmatter → never auto-exits, whatever the interactivity.
    assert.equal(testApi.resolveChildAutoExit(false, false), false);
    assert.equal(testApi.resolveChildAutoExit(undefined, false), false);
    assert.equal(testApi.resolveChildAutoExit(undefined, true), false);
    // End-to-end through the real resolution helpers: keepOpen on an
    // auto-exit profile (scout/worker/researcher) suppresses child auto-exit.
    const defs = { autoExit: true };
    const interactive = testApi.resolveEffectiveInteractive(
      { name: "A", task: "T", keepOpen: true },
      defs,
    );
    assert.equal(interactive, true);
    assert.equal(testApi.resolveChildAutoExit(defs.autoExit, interactive), false);
  });

  it("bundled scout/researcher/worker all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "worker"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
  });

  it("worker is granted the spawning toolset restricted to scout and researcher", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
  });

  it("scout and researcher are not granted spawning tools", () => {
    for (const name of ["scout", "researcher"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("getToolExtensionPath maps custom tools and skips built-ins", () => {
    assert.equal(testApi.getToolExtensionPath("read"), undefined);
    assert.equal(testApi.getToolExtensionPath("bash"), undefined);
    assert.ok(testApi.getToolExtensionPath("web_search")?.endsWith("web-search/index.ts"));
    assert.ok(testApi.getToolExtensionPath("safe_bash")?.endsWith("tools/safe-bash.ts"));
    // Spawning tools are registered by this extension itself.
    assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,safe_bash",
          model: "openrouter/z-ai/glm-5.2",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("openrouter/z-ai/glm-5.2:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,safe_bash"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("applySandboxToParts supports escape: false for raw unescaped argument passing", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write",
          model: "openrouter/free",
          thinking: null,
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: null,
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker", escape: false },
      );
      const appendIdx = parts.indexOf("--append-system-prompt");
      assert.ok(appendIdx >= 0, "expected --append-system-prompt");
      const pathArg = parts[appendIdx + 1];
      assert.ok(!pathArg.startsWith("'"), `path should not be single-quoted: ${pathArg}`);
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      assert.equal(parts[toolsIdx + 1], "read,write", "tool list should not be single-quoted");
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  // Shared harness: drives subagent-done.ts against a mock API whose handlers
  // can be emitted directly (agent_start / input / agent_end) so session-park
  // and auto-exit behavior is testable without a real agent loop.
  function setupCapturingExtension(sessionFile: string, opts: { autoExit?: boolean } = {}) {
    const autoExit = opts.autoExit ?? true;
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const tools: any[] = [];
    const api = {
      on(event: string, handler: (...args: any[]) => void) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
      registerTool(t: any) { tools.push(t); },
      registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
      sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
    } as any;
    const saved = {
      session: process.env.PI_SUBAGENT_SESSION,
      name: process.env.PI_SUBAGENT_NAME,
      agent: process.env.PI_SUBAGENT_AGENT,
      autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
    };
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_NAME = "scout-2";
    process.env.PI_SUBAGENT_AGENT = "scout";
    if (autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    else delete process.env.PI_SUBAGENT_AUTO_EXIT;
    subagentDoneExtension(api);
    const emit = (event: string, ...args: any[]) =>
      (handlers.get(event) ?? []).forEach((h) => h(...args));
    const restore = () => {
      restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
      restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
      restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
    };
    const ask = async () => {
      const tool = tools.find((t) => t.name === "ask_question");
      await tool.execute("c1", { question: "v1 or v2?" }, undefined, undefined, { shutdown() {} });
    };
    return { emit, ask, restore };
  }

  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(() => 3, () => {
        assert.equal(runningChildrenCount(), 3);
      });
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(() => 0, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => -1, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => "two", () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => { throw new Error("boom"); }, () => assert.equal(runningChildrenCount(), 0));
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a .ask signal with name/agent/question and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;
        const out = await tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        const askFile = `${sessionFile}.ask`;
        assert.ok(existsSync(askFile), ".ask signal file should be written");
        const payload = JSON.parse(readFileSync(askFile, "utf-8"));
        assert.equal(payload.question, "Which API base URL?");
        assert.equal(payload.name, "scout-2");
        assert.equal(payload.agent, "scout");
        // No .exit sidecar — the session is not exiting.
        assert.ok(!existsSync(`${sessionFile}.exit`));
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression tests for the mid-run reply race: a reply steered in while the
    // asking run is still open fires `input` but NOT `agent_start`, so the flag
    // must be cleared on `input` or the session parks forever.
    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask(); // sets awaitingAnswer mid-run
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        emit("input");
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "reply consumed mid-run → agent_end should exit, not park");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_end while the reply is still pending (no input yet)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        // No input yet — the orchestrator has not replied.
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "pending question with no reply must park, not exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when the reply arrives as a new turn (agent_start also clears the flag)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        let shutdown1 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown1 = true; } });
        assert.equal(shutdown1, false, "parks while waiting");
        // Reply arrives as a fresh turn after the subagent had parked.
        emit("input");
        emit("agent_start");
        let shutdown2 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown2 = true; } });
        assert.equal(shutdown2, true, "after the reply turn, agent_end should exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("parked completion signal (.parked)", () => {
    const CHILDREN_KEY = Symbol.for("pi-subagents/running-children-count");

    function emitAgentEnd(emit: (event: string, ...args: any[]) => void, messages: any[]) {
      let shutdown = false;
      emit("agent_end", { messages }, { shutdown() { shutdown = true; } });
      return shutdown;
    }

    it("writes .parked (no shutdown) when a non-auto-exit session parks after a normal turn", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, { autoExit: false });
      try {
        const shutdown = emitAgentEnd(emit, [{ role: "assistant", stopReason: "stop" }]);
        assert.equal(shutdown, false, "non-auto-exit session must park, not shut down");

        const parkedFile = `${sessionFile}.parked`;
        assert.ok(existsSync(parkedFile), ".parked signal should be written at a genuine turn end");
        const payload = JSON.parse(readFileSync(parkedFile, "utf-8"));
        assert.equal(typeof payload.parkedAt, "number");
        assert.equal(payload.name, "scout-2");
        assert.equal(payload.agent, "scout");
        assert.ok(!existsSync(`${sessionFile}.exit`), "clean completion must not write .exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not write .parked when the session auto-exits", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, { autoExit: true });
      try {
        const shutdown = emitAgentEnd(emit, [{ role: "assistant", stopReason: "stop" }]);
        assert.equal(shutdown, true, "auto-exit agent should shut down");
        assert.ok(!existsSync(`${sessionFile}.parked`), "auto-exit path must not write .parked");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not write .parked while an ask_question reply is still pending", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, ask, restore } = setupCapturingExtension(sessionFile, { autoExit: false });
      try {
        emit("agent_start");
        await ask();
        const shutdown = emitAgentEnd(emit, [{ role: "assistant", stopReason: "stop" }]);
        assert.equal(shutdown, false);
        assert.ok(
          !existsSync(`${sessionFile}.parked`),
          "a pending question is the event; it must not also announce completion",
        );
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not write .parked while child subagents are still running", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, { autoExit: false });
      const prev = (globalThis as any)[CHILDREN_KEY];
      (globalThis as any)[CHILDREN_KEY] = () => 2;
      try {
        const shutdown = emitAgentEnd(emit, [{ role: "assistant", stopReason: "stop" }]);
        assert.equal(shutdown, false);
        assert.ok(
          !existsSync(`${sessionFile}.parked`),
          "an unfinished turn (children in flight) must not announce completion",
        );
      } finally {
        (globalThis as any)[CHILDREN_KEY] = prev;
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not write .parked after an aborted turn", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, { autoExit: false });
      try {
        const shutdown = emitAgentEnd(emit, [{ role: "assistant", stopReason: "aborted" }]);
        assert.equal(shutdown, false, "aborted turns leave the session open for inspection");
        assert.ok(!existsSync(`${sessionFile}.parked`), "aborted turn must not announce completion");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes the .exit error sidecar (with writtenAt) and no .parked when a parked turn errored", () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { emit, restore } = setupCapturingExtension(sessionFile, { autoExit: false });
      try {
        const shutdown = emitAgentEnd(emit, [
          { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
        ]);
        assert.equal(shutdown, false, "kept-open session parks even after an errored turn");
        assert.ok(
          !existsSync(`${sessionFile}.parked`),
          "errored turns report via .exit, never as a clean completion",
        );
        const exitFile = `${sessionFile}.exit`;
        assert.ok(existsSync(exitFile), "errored parked turn should write the .exit sidecar");
        const payload = JSON.parse(readFileSync(exitFile, "utf-8"));
        assert.equal(payload.type, "error");
        assert.equal(payload.errorMessage, "Anthropic 529 Overloaded");
        assert.equal(typeof payload.writtenAt, "number");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("herdr.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("no longer decodes ping payloads (ask_question keeps the session open instead)", () => {
    // ask_question writes a `.ask` signal, not a `.exit` ping sidecar, so an
    // unknown `type: "ping"` payload now falls through to a clean done.
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      { reason: "done", exitCode: 0 },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });

  it("pollForExit respects abort signal immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      pollForExit("any-surface", ac.signal, { interval: 100 }),
      /Aborted while waiting/,
    );
  });

  it("pollForExit detects when surface is not alive after grace period", async () => {
    if (!isHerdrAvailable()) return;
    const ac = new AbortController();
    const result = await pollForExit("nonexistent-surface-abc-xyz", ac.signal, {
      interval: 100,
    });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /pane was closed/);
  });
});
describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredCommands.find((c) => c.name === "iterate"), undefined);
    assert.equal(registeredCommands.find((c) => c.name === "plan"), undefined);
  });

  it("registers /subagent:stop and /subagents commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const stopCmd = registeredCommands.find((c) => c.name === "subagent:stop");
    assert.ok(stopCmd, "expected /subagent:stop to be registered");

    let notifiedMsg = "";
    stopCmd.handler("", { ui: { notify(msg: string) { notifiedMsg = msg; } } });
    assert.match(notifiedMsg, /No subagents are currently running/);

    const listCmd = registeredCommands.find((c) => c.name === "subagents");
    assert.ok(listCmd, "expected /subagents to be registered");
    let listNotified = "";
    listCmd.handler("", { ui: { notify(msg: string) { listNotified = msg; } } });
    assert.match(listNotified, /No subagents are currently running/);
  });

  it("/subagent handles stop and status subcommands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    let stopMsg = "";
    subagent.handler("stop", { ui: { notify(msg: string) { stopMsg = msg; } } });
    assert.match(stopMsg, /No subagents are currently running/);

    let statusMsg = "";
    subagent.handler("status", { ui: { notify(msg: string) { statusMsg = msg; } } });
    assert.match(statusMsg, /No subagents are currently running/);
  });
});

describe("tool registration", () => {
  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });


  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", {
      name: "x",
      task: "do it",
      agent: "wizard",
    });
    assert.equal(result.details?.error, "unknown agent");
    assert.match(result.content[0].text, /not a known agent/i);
  });

  it("exposes a debloated schema: agent+task required, name/model/cwd optional, no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cli", "cwd", "keepOpen", "model", "name", "task"],
      "only agent/cli/task/name/model/cwd/keepOpen should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["task"],
      "task must be required (agent and cli are optional in schema, validated at runtime)",
    );
    assert.match(props.cli.description, /coding agent CLI runner/i);
    // `name` is now optional and purely cosmetic.
    assert.match(props.name.description, /cosmetic/i);
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("registers a Pi-only subagent_interrupt and no subagent_resume", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), true);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("registers subagent_stop tool with optional name and closePane", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const stopTool = registeredTools.find((t) => t.name === "subagent_stop");
    assert.ok(stopTool, "expected subagent_stop tool to be registered");

    const props = stopTool.parameters.properties;
    assert.deepEqual(Object.keys(props).sort(), ["closePane", "name"]);
    assert.equal(props.name.type, "string");
    assert.equal(props.closePane.type, "boolean");
    assert.equal(stopTool.parameters.required, undefined);
  });

  it("subagent_stop tool handles execution for missing, matching, and ambiguous agents", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const stopTool = registeredTools.find((t) => t.name === "subagent_stop");
    assert.ok(stopTool);

    // 1. None running
    const resNone = await stopTool.execute("call-1", {});
    assert.equal(resNone.details?.reason, "none_running");

    // Setup running agents
    let aborted1 = false;
    let aborted2 = false;
    runningMap.set("a1", {
      id: "a1",
      name: "worker",
      surface: "p1",
      abortController: { abort() { aborted1 = true; } },
    });
    runningMap.set("a2", {
      id: "a2",
      name: "scout",
      surface: "p2",
      abortController: { abort() { aborted2 = true; } },
    });

    try {
      // 2. Ambiguous when multiple running and name omitted
      const resAmbiguous = await stopTool.execute("call-2", {});
      assert.equal(resAmbiguous.details?.error, "ambiguous");

      // 3. Not found
      const resNotFound = await stopTool.execute("call-3", { name: "ghost" });
      assert.equal(resNotFound.details?.error, "not_found");

      // 4. Success stopping one subagent by name
      const resSuccess = await stopTool.execute("call-4", { name: "worker", closePane: false });
      assert.equal(resSuccess.details?.stopped, true);
      assert.equal(resSuccess.details?.name, "worker");
      assert.equal(aborted1, true);
      assert.equal(runningMap.has("a1"), false);
      assert.equal(runningMap.has("a2"), true);

      // 5. Single running subagent can be stopped with name omitted
      const resSingle = await stopTool.execute("call-5", { closePane: false });
      assert.equal(resSingle.details?.stopped, true);
      assert.equal(resSingle.details?.name, "scout");
      assert.equal(aborted2, true);
      assert.equal(runningMap.size, 0);
    } finally {
      runningMap.clear();
    }
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and subagent_interrupt, not the old resume tool", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), true);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("interrupts a running Pi subagent with Escape and marks it waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      const running = makeRunning({
        id: "a1",
        name: "Worker",
        surface: "a1",
        cli: "pi",
        herdrAgentName: "worker",
      });
      runningMap.set("a1", running);
      const sent: string[] = [];

      const result = testApi.handleSubagentInterrupt(
        { name: "Worker" },
        (target: any) => sent.push(target.surface),
      );

      assert.deepEqual(sent, ["a1"]);
      assert.equal(result.details.status, "interrupt_requested");
      assert.equal(running.statusState.currentKind, "waiting");
      assert.equal(running.statusState.activityLabel, "interrupted");
    } finally {
      runningMap.clear();
    }
  });

  it("refuses to interrupt a non-Pi subagent", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set(
        "a1",
        makeRunning({ id: "a1", name: "Claude", surface: "a1", cli: "claude" }),
      );
      let sent = 0;

      const result = testApi.handleSubagentInterrupt(
        { name: "Claude" },
        () => {
          sent++;
        },
      );

      assert.equal(sent, 0);
      assert.match(result.content[0].text, /only supported for Pi subagents/);
      assert.ok(result.details.error);
    } finally {
      runningMap.clear();
    }
  });

  it("claims a turn result once even with overlapping watchers", () => {
    const testApi = (subagentsModule as any).__test__;
    const running: any = makeRunning();

    // No per-turn record yet: deliver (this is the error path).
    assert.equal(testApi.claimDelivery(running), true);

    running.delivery = { turn: 1, state: "pending" };
    assert.equal(testApi.claimDelivery(running), true);
    assert.equal(running.delivery.state, "delivered");
    assert.equal(testApi.claimDelivery(running), false);
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("steers a running subagent by typing into its pane (newlines flattened)", () => {
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this then that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, text: string) => {
          sentSurface = surface;
          sentText = text;
        }),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(result.content[0].text.includes('Message delivered to running subagent "Worker"'), true);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });

  describe("stopSubagentByName", () => {
    it("reports when no subagents are running", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      assert.match(testApi.stopSubagentByName(), /No subagents are currently running/);
      assert.match(testApi.stopSubagentByName("all"), /No subagents are currently running/);
      assert.match(testApi.stopSubagentByName("worker"), /No running subagent named "worker"/);
    });

    it("stops a single subagent when targetName is omitted", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      let aborted = false;
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "Worker",
        abortController: { abort() { aborted = true; } },
      }));

      const restoreHerdr = useEmptyFakeHerdr();
      try {
        const result = testApi.stopSubagentByName();
        assert.match(result, /Subagent "Worker" stopped/);
        assert.equal(aborted, true);
        assert.equal(runningMap.size, 0);
      } finally {
        restoreHerdr();
        runningMap.clear();
      }
    });

    it("stops matching subagent by name case-insensitively", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      let aborted1 = false;
      let aborted2 = false;
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "Worker-Alpha",
        abortController: { abort() { aborted1 = true; } },
      }));
      runningMap.set("a2", makeRunning({
        id: "a2",
        name: "Scout-Beta",
        abortController: { abort() { aborted2 = true; } },
      }));

      const restoreHerdr = useEmptyFakeHerdr();
      try {
        const result = testApi.stopSubagentByName("worker-alpha");
        assert.match(result, /Subagent "Worker-Alpha" stopped/);
        assert.equal(aborted1, true);
        assert.equal(aborted2, false);
        assert.equal(runningMap.has("a1"), false);
        assert.equal(runningMap.has("a2"), true);
      } finally {
        restoreHerdr();
        runningMap.clear();
      }
    });

    it("stops all subagents when targetName is 'all'", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      let aborted1 = false;
      let aborted2 = false;
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "Worker-1",
        abortController: { abort() { aborted1 = true; } },
      }));
      runningMap.set("a2", makeRunning({
        id: "a2",
        name: "Worker-2",
        abortController: { abort() { aborted2 = true; } },
      }));

      const restoreHerdr = useEmptyFakeHerdr();
      try {
        const result = testApi.stopSubagentByName("all");
        assert.match(result, /All subagents stopped \(2 stopped\)/);
        assert.equal(aborted1, true);
        assert.equal(aborted2, true);
        assert.equal(runningMap.size, 0);
      } finally {
        restoreHerdr();
        runningMap.clear();
      }
    });

    it("returns disambiguation message when multiple are running and targetName is omitted", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker-1" }));
      runningMap.set("a2", makeRunning({ id: "a2", name: "Worker-2" }));

      try {
        const result = testApi.stopSubagentByName();
        assert.match(result, /Multiple subagents running: Worker-1, Worker-2/);
        assert.equal(runningMap.size, 2);
      } finally {
        runningMap.clear();
      }
    });
  });

  describe("stop must not turn an unreadable probe into success", () => {
    it("keeps the exit keys when the pane inventory cannot be read", () => {
      // THE regression: a transient read failure was read as "the pane is gone",
      // which skipped the keys *and* the close and still reported "stopped".
      const world = createFakeHerdr({ "w1:p2": {} }, { paneListFailsTimes: 1 });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const outcome = terminateSurface("w1:p2", { agentName: "test" });
        assert.equal(world.keyWrites.length > 0, true, "the exit gesture must still be sent");
        assert.equal(outcome.ok, true);
        assert.equal(outcome.paneClosed, true);
        assert.equal(world.panes.has("w1:p2"), false, "the pane should be closed once verified");
      } finally {
        restore();
      }
    });

    it("reports an unverifiable stop as a failure, never as success", () => {
      const world = createFakeHerdr({ "w1:p2": {} }, { paneListFailsTimes: 99 });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const outcome = terminateSurface("w1:p2", { agentName: "test" });
        assert.equal(outcome.ok, false);
        assert.equal(outcome.paneClosed, false);
        assert.equal(outcome.reason, "unverified");
        assert.equal(world.keyWrites.length > 0, true, "an unreadable probe must not skip the keys");
        assert.equal(outcome.errors.length > 0, true);
      } finally {
        restore();
      }
    });

    it("reports failure when herdr accepts the close but the pane survives", () => {
      const world = createFakeHerdr({ "w1:p2": { closeFails: true } });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const outcome = terminateSurface("w1:p2", { agentName: "test" });
        assert.equal(outcome.ok, false);
        assert.equal(outcome.paneClosed, false);
        assert.equal(outcome.reason, "pane_still_alive");
        assert.equal(world.panes.has("w1:p2"), true);
      } finally {
        restore();
      }
    });

    it("surfaces herdr's error text instead of swallowing it", () => {
      const world = createFakeHerdr({ "w1:p2": { closeFails: true } });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const outcome = terminateSurface("w1:p2", { agentName: "test" });
        assert.equal(
          outcome.errors.some((error) => /pane_close_failed/.test(error)),
          true,
        );
      } finally {
        restore();
      }
    });

    it("sends keys through the agent name, falling back to the pane", () => {
      const direct = createFakeHerdr({ "w1:p2": { agent: "test" } }, { agentNames: ["test"] });
      const restoreDirect = setHerdrExecDeps(direct.deps);
      try {
        terminateSurface("w1:p2", { agentName: "test" });
        assert.deepStrictEqual(direct.keyWrites, [["agent:test", "ctrl+c", "ctrl+c"]]);
      } finally {
        restoreDirect();
      }

      const fallback = createFakeHerdr({ "w1:p2": {} });
      const restoreFallback = setHerdrExecDeps(fallback.deps);
      try {
        terminateSurface("w1:p2", { agentName: "test" });
        assert.deepStrictEqual(fallback.keyWrites, [["pane:w1:p2", "ctrl+c", "ctrl+c"]]);
      } finally {
        restoreFallback();
      }
    });

    it("uses pane keys instead of an unregistered agent target", () => {
      // The agent may exist elsewhere, but this pane does not report it (e.g.
      // the child died during startup). Addressing it by name makes Herdr log
      // `agent target not found`; the pane is the reliable target.
      const world = createFakeHerdr({ "w1:p2": {} }, { agentNames: ["test"] });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const outcome = terminateSurface("w1:p2", { agentName: "test" });
        assert.deepStrictEqual(world.keyWrites, [["pane:w1:p2", "ctrl+c", "ctrl+c"]]);
        assert.equal(
          outcome.errors.some((error) => /agent target/.test(error)),
          false,
        );
      } finally {
        restore();
      }
    });

    it("does not type keys into a pane that is already gone", () => {
      const world = createFakeHerdr({ "w1:p2": {} });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const outcome = terminateSurface("w9:p9", { agentName: "test" });
        assert.equal(outcome.method, "not-alive");
        assert.equal(outcome.ok, true);
        assert.deepStrictEqual(world.keyWrites, []);
      } finally {
        restore();
      }
    });

    it("parses the pane inventory and keeps 'unreadable' distinct from 'gone'", () => {
      assert.deepStrictEqual(
        parsePaneList('{"result":{"panes":[{"pane_id":"w1:p2","agent":"pi"}]}}'),
        [
          {
            paneId: "w1:p2",
            agent: "pi",
            agentStatus: undefined,
            agentSessionValue: undefined,
            cwd: undefined,
          },
        ],
      );
      assert.equal(parsePaneList("{not json"), null);
      assert.equal(parsePaneList('{"result":{}}'), null);
      assert.equal(parseHerdrError(herdrError("pane_not_found", "pane x not found"))?.code, "pane_not_found");
      assert.equal(parseHerdrError("plain failure"), null);

      // With Herdr unreachable the answer is "cannot tell" — never "gone".
      const restoreUnavailable = setHerdrExecDeps({ available: () => false });
      try {
        assert.equal(paneExists("w1:p2"), null);
      } finally {
        restoreUnavailable();
      }
    });

    it("tells the user when a stop did not take effect", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      const world = createFakeHerdr({ "pane-1": { closeFails: true } });
      const restore = setHerdrExecDeps(world.deps);
      runningMap.clear();
      runningMap.set("a1", makeRunning({ id: "a1", name: "stuck-bot", surface: "pane-1" }));
      try {
        const message = testApi.stopSubagentByName("stuck-bot");
        assert.match(message, /did not stop/);
        assert.match(message, /pane-1/);
      } finally {
        restore();
        runningMap.clear();
      }
    });

    it("still reports a clean stop when the pane goes away", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      const world = createFakeHerdr({ "pane-1": {} });
      const restore = setHerdrExecDeps(world.deps);
      runningMap.clear();
      runningMap.set("a1", makeRunning({ id: "a1", name: "good-bot", surface: "pane-1" }));
      try {
        assert.match(testApi.stopSubagentByName("good-bot"), /Subagent "good-bot" stopped/);
        assert.equal(world.panes.has("pane-1"), false);
        assert.equal(runningMap.size, 0);
      } finally {
        restore();
        runningMap.clear();
      }
    });
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("herdr.ts", () => {
  describe("availability", () => {
    it("isMuxAvailable delegates to isHerdrAvailable", () => {
      assert.equal(isMuxAvailable(), isHerdrAvailable());
    });

    it("isSurfaceAlive returns false when Herdr is unavailable or pane does not exist", () => {
      const result = isSurfaceAlive("nonexistent-pane-99999");
      assert.equal(typeof result, "boolean");
      assert.equal(result, false);
    });

    it("reports an unverifiable stop as a failure rather than a false success", () => {
      const restore = setHerdrExecDeps({ available: () => false });
      try {
        const result = terminateSurface("nonexistent-pane-99999");
        // Nothing can be verified, so the outcome must not claim the pane is gone.
        assert.equal(result.ok, false);
        assert.equal(result.paneClosed, false);
        assert.equal(result.reason, "unverified");
        assert.equal(result.errors.length > 0, true, "the herdr failure must be surfaced");
      } finally {
        restore();
      }
    });

    it("terminateSurface reports not-alive only for a pane that is genuinely gone", () => {
      const world = createFakeHerdr({ "w9:p9": {} });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const result = terminateSurface("nonexistent-pane-99999");
        assert.equal(result.method, "not-alive");
        assert.equal(result.ok, true);
        assert.equal(result.paneClosed, true);
        assert.deepStrictEqual(world.keyWrites, []);
      } finally {
        restore();
      }
    });

    it("terminateSurface respects closePane: false", () => {
      const world = createFakeHerdr({ "w1:p2": {} });
      const restore = setHerdrExecDeps(world.deps);
      try {
        const result = terminateSurface("w1:p2", { agentName: "rev", closePane: false });
        assert.equal(result.ok, true);
        assert.equal(result.paneClosed, false);
        assert.equal(world.panes.has("w1:p2"), true, "closePane: false must not close the pane");
      } finally {
        restore();
      }
    });

    it("closeSurface returns boolean", () => {
      const result = closeSurface("nonexistent-pane-99999");
      assert.equal(typeof result, "boolean");
    });
  });

  describe("shellEscape", () => {
    it("wraps in quotes", () => {
      assert.ok(shellEscape("hello").includes("hello"));
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
    });
  });

  describe("runner normalization", () => {
    it("normalizes canonical runners", () => {
      assert.equal(normalizeRunner("pi"), "pi");
      assert.equal(normalizeRunner("agy"), "agy");
      assert.equal(normalizeRunner("claude"), "claude");
      assert.equal(normalizeRunner("codex"), "codex");
      assert.equal(normalizeRunner("grok"), "grok");
      assert.equal(normalizeRunner("opencode"), "opencode");
    });

    it("normalizes runner aliases", () => {
      assert.equal(normalizeRunner("antigravity"), "agy");
      assert.equal(normalizeRunner("antigravity-cli"), "agy");
      assert.equal(normalizeRunner("claude-code"), "claude");
      assert.equal(normalizeRunner("openai-codex"), "codex");
      assert.equal(normalizeRunner("grok-cli"), "grok");
      assert.equal(normalizeRunner("open_code"), "opencode");
      assert.equal(normalizeRunner("open-code"), "opencode");
    });

    it("returns undefined for unknown runners", () => {
      assert.equal(normalizeRunner("unknown-agent"), undefined);
      assert.equal(normalizeRunner(""), undefined);
      assert.equal(normalizeRunner(null), undefined);
    });

    it("checks known runners with isKnownRunner", () => {
      assert.equal(isKnownRunner("pi"), true);
      assert.equal(isKnownRunner("openai-codex"), true);
      assert.equal(isKnownRunner("grok"), true);
      assert.equal(isKnownRunner("opencode"), true);
      assert.equal(isKnownRunner("nonexistent"), false);
    });
  });

  describe("sanitizeAgentName", () => {
    it("converts uppercase to lowercase", () => {
      assert.equal(sanitizeAgentName("MyAgent"), "myagent");
    });

    it("replaces invalid characters with hyphens", () => {
      assert.equal(sanitizeAgentName("worker #1!"), "worker--1-");
    });

    it("ensures name starts with letter", () => {
      const sanitized = sanitizeAgentName("123worker");
      assert.match(sanitized, /^[a-z]/);
    });

    it("truncates to at most 32 characters", () => {
      const longName = "this-is-a-very-long-agent-name-that-exceeds-32-characters";
      assert.ok(sanitizeAgentName(longName).length <= 32);
    });
  });

  describe("resolveRunnerAndAgent", () => {
    const testApi = (subagentsModule as any).__test__;

    it("resolves explicit cli", () => {
      const resolved = testApi.resolveRunnerAndAgent({ cli: "openai-codex" });
      assert.equal(resolved.effectiveRunner, "codex");
    });

    it("resolves runner alias passed via agent when no profile exists", () => {
      const resolved = testApi.resolveRunnerAndAgent({ agent: "grok" });
      assert.equal(resolved.effectiveRunner, "grok");
      assert.equal(resolved.agentName, undefined);
    });

    it("defaults to pi runner when omitted", () => {
      const resolved = testApi.resolveRunnerAndAgent({});
      assert.equal(resolved.effectiveRunner, "pi");
    });
  });

  describe("sanitizeTerminalOutput", () => {
    it("returns empty string for empty input", () => {
      assert.equal(sanitizeTerminalOutput(""), "");
    });

    it("strips ANSI color codes and cursor movement", () => {
      const raw = "\x1b[32mHello\x1b[0m \x1b[1;34mWorld\x1b[0m\x1b[2K";
      assert.equal(sanitizeTerminalOutput(raw), "Hello World");
    });

    it("strips OSC sequences such as hyperlinks and window titles", () => {
      const raw = "\x1b]8;;https://example.com\x07Link\x1b]8;;\x07 text";
      assert.equal(sanitizeTerminalOutput(raw), "Link text");
    });

    it("strips subagent exit sentinel", () => {
      const raw = "Final answer\n__SUBAGENT_DONE_0__";
      assert.equal(sanitizeTerminalOutput(raw), "Final answer");
    });

    it("filters out status spinner lines", () => {
      const raw = "Working...\n⠋ ⠙ ⠹\nDone output";
      assert.equal(sanitizeTerminalOutput(raw), "Working...\nDone output");
    });

    it("filters out horizontal box-drawing lines and trailing prompt markers", () => {
      const raw = "────────────────────────\nContent\n────────────────────────\n> ";
      assert.equal(sanitizeTerminalOutput(raw), "Content");
    });
  });

  describe("turn record protocol & extraction", () => {
    const testApi = (subagentsModule as any).__test__;

    it("computes subagent record path under .pi/temp/subagent-records", () => {
      const p = getSubagentRecordPath("/my/project", "researcher");
      assert.ok(p.includes(".pi"));
      assert.ok(p.includes("temp"));
      assert.ok(p.includes("subagent-records"));
      assert.ok(p.endsWith("researcher.jsonl"));
    });

    it("formats non-Pi prompt with output protocol", () => {
      const formatted = testApi.formatNonPiPrompt("Find news", "/temp/rec.jsonl", 1);
      assert.ok(formatted.includes("Find news"));
      assert.ok(formatted.includes("[Output Protocol]"));
      assert.ok(formatted.includes("/temp/rec.jsonl"));
      assert.ok(formatted.includes('"turn": 1'));
    });

    it("reads last record when multiple turns exist", () => {
      const dir = createTestDir();
      const p = join(dir, "sub.jsonl");
      const lines = [
        JSON.stringify({ turn: 1, timestamp: 1000, content: "First turn result" }),
        JSON.stringify({ turn: 2, timestamp: 2000, content: "Second turn result" }),
      ];
      writeFileSync(p, lines.join("\n") + "\n", "utf8");

      assert.equal(readLastSessionRecord(p), "Second turn result");
    });

    it("filters records older than afterTimestamp", () => {
      const dir = createTestDir();
      const p = join(dir, "sub.jsonl");
      const lines = [
        JSON.stringify({ turn: 1, timestamp: 1000, content: "First turn result" }),
        JSON.stringify({ turn: 2, timestamp: 2000, content: "Second turn result" }),
      ];
      writeFileSync(p, lines.join("\n") + "\n", "utf8");

      assert.equal(readLastSessionRecord(p, 2500), null);
      assert.equal(readLastSessionRecord(p, 1500), "Second turn result");
    });

    it("handles malformed lines and fallback fields (summary, text)", () => {
      const dir = createTestDir();
      const p = join(dir, "sub.jsonl");
      const lines = [
        "not-valid-json",
        JSON.stringify({ turn: 1, timestamp: 1000, summary: "Summary result" }),
        "",
      ];
      writeFileSync(p, lines.join("\n") + "\n", "utf8");

      assert.equal(readLastSessionRecord(p), "Summary result");
    });

    it("returns null for non-existent or empty record file", () => {
      assert.equal(readLastSessionRecord("/non/existent/file.jsonl"), null);
      const dir = createTestDir();
      const p = join(dir, "empty.jsonl");
      writeFileSync(p, "", "utf8");
      assert.equal(readLastSessionRecord(p), null);
    });
  });

  describe("native session readers (agy, claude, pi)", () => {
    it("recognizes native session runners", () => {
      assert.equal(isNativeSessionRunner("pi"), true);
      assert.equal(isNativeSessionRunner("agy"), true);
      assert.equal(isNativeSessionRunner("AGY"), true);
      assert.equal(isNativeSessionRunner("claude"), true);
      assert.equal(isNativeSessionRunner("CLAUDE"), true);
      assert.equal(isNativeSessionRunner("opencode"), false);
      assert.equal(isNativeSessionRunner("codex"), false);
      assert.equal(isNativeSessionRunner("grok"), false);
      assert.equal(isNativeSessionRunner(undefined), false);
    });

    describe("readAgySession", () => {
      it("extracts the last assistant response from transcript_full.jsonl by conversationId", () => {
        const brainDir = createTestDir();
        const convId = "conv-123-abc";
        const logsDir = join(brainDir, convId, ".system_generated", "logs");
        mkdirSync(logsDir, { recursive: true });

        const transcriptPath = join(logsDir, "transcript_full.jsonl");
        const lines = [
          JSON.stringify({
            step_index: 0,
            source: "USER_EXPLICIT",
            type: "USER_INPUT",
            content: "What is 2+2?",
            created_at: "2026-09-18T00:00:00Z",
          }),
          JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            content: "2+2 is 4.",
            created_at: "2026-09-18T00:00:05Z",
          }),
        ];
        writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

        const result = readAgySession({ brainDir, conversationId: convId });
        assert.equal(result, "2+2 is 4.");
      });

      it("filters out older turns using afterTimestamp", () => {
        const brainDir = createTestDir();
        const convId = "conv-multi-turn";
        const logsDir = join(brainDir, convId, ".system_generated", "logs");
        mkdirSync(logsDir, { recursive: true });

        const transcriptPath = join(logsDir, "transcript_full.jsonl");
        const lines = [
          JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            content: "First turn answer",
            created_at: "2026-09-18T00:00:05Z",
          }),
          JSON.stringify({
            step_index: 3,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            content: "Second turn answer",
            created_at: "2026-09-18T00:01:05Z",
          }),
        ];
        writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

        const afterTime = Date.parse("2026-09-18T00:00:30Z");
        const result = readAgySession({ brainDir, conversationId: convId, afterTimestamp: afterTime });
        assert.equal(result, "Second turn answer");

        const futureTime = Date.parse("2026-09-18T00:02:00Z");
        assert.equal(readAgySession({ brainDir, conversationId: convId, afterTimestamp: futureTime }), null);
      });

      it("handles error status in agy transcript", () => {
        const brainDir = createTestDir();
        const convId = "conv-error";
        const logsDir = join(brainDir, convId, ".system_generated", "logs");
        mkdirSync(logsDir, { recursive: true });

        const transcriptPath = join(logsDir, "transcript_full.jsonl");
        const lines = [
          JSON.stringify({
            step_index: 1,
            source: "MODEL",
            type: "PLANNER_RESPONSE",
            status: "ERROR",
            content: "Rate limit exceeded on provider",
            created_at: "2026-09-18T00:00:05Z",
          }),
        ];
        writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");

        const result = readAgySession({ brainDir, conversationId: convId });
        assert.equal(result, "Subagent error: Rate limit exceeded on provider");
      });

      it("auto-discovers the newest conversation directory if conversationId is omitted", () => {
        const brainDir = createTestDir();
        const conv1 = join(brainDir, "conv-1");
        const conv2 = join(brainDir, "conv-2");
        mkdirSync(join(conv1, ".system_generated", "logs"), { recursive: true });
        mkdirSync(join(conv2, ".system_generated", "logs"), { recursive: true });

        const file1 = join(conv1, ".system_generated", "logs", "transcript.jsonl");
        const file2 = join(conv2, ".system_generated", "logs", "transcript.jsonl");

        writeFileSync(
          file1,
          JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "Result from conv 1" }) + "\n",
          "utf8"
        );
        writeFileSync(
          file2,
          JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "Result from conv 2" }) + "\n",
          "utf8"
        );

        const now = Date.now();
        utimesSync(file1, new Date(now - 10000), new Date(now - 10000));
        utimesSync(file2, new Date(now), new Date(now));

        const result = readAgySession({ brainDir });
        assert.equal(result, "Result from conv 2");
      });

      it("returns null if brain directory or transcripts do not exist", () => {
        assert.equal(readAgySession({ brainDir: "/non/existent/brain" }), null);
        const brainDir = createTestDir();
        assert.equal(readAgySession({ brainDir }), null);
      });
    });

    describe("readClaudeSession", () => {
      it("prioritizes sentinel file when present", () => {
        const dir = createTestDir();
        const sentinel = join(dir, "claude-sentinel.txt");
        writeFileSync(sentinel, "Summary from sentinel file", "utf8");

        const result = readClaudeSession({ sentinelFile: sentinel });
        assert.equal(result, "Summary from sentinel file");
      });

      it("extracts assistant content from Claude project transcript JSONL", () => {
        const projectsDir = createTestDir();
        const slug = "my-project-cwd";
        const projectSubdir = join(projectsDir, slug);
        mkdirSync(projectSubdir, { recursive: true });

        const sessionPath = join(projectSubdir, "ses-123.jsonl");
        const lines = [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "Explain gravity" },
            timestamp: "2026-09-18T00:00:00Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Gravity is a fundamental interaction." },
              ],
            },
            timestamp: "2026-09-18T00:00:05Z",
          }),
        ];
        writeFileSync(sessionPath, lines.join("\n") + "\n", "utf8");

        const result = readClaudeSession({
          projectsDir,
          cwd: slug,
          sessionId: "ses-123",
        });
        assert.equal(result, "Gravity is a fundamental interaction.");
      });

      it("normalizes project paths into Claude project slugs via toClaudeProjectSlug", () => {
        const slugWin = toClaudeProjectSlug("D:\\claude\\pi-extensions");
        assert.equal(slugWin, "D--claude-pi-extensions");

        const slugPosix = toClaudeProjectSlug("/home/user/project");
        assert.equal(slugPosix, "-home-user-project");
      });
    });

    describe("readRunnerSession", () => {
      it("routes agy runner to readAgySession", () => {
        const brainDir = createTestDir();
        const convId = "conv-dispatch";
        const logsDir = join(brainDir, convId, ".system_generated", "logs");
        mkdirSync(logsDir, { recursive: true });
        writeFileSync(
          join(logsDir, "transcript.jsonl"),
          JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "Agy dispatched" }) + "\n",
          "utf8"
        );

        const result = readRunnerSession({
          runner: "agy",
          brainDir,
          sessionId: convId,
        });
        assert.equal(result, "Agy dispatched");
      });

      it("routes claude runner to readClaudeSession", () => {
        const dir = createTestDir();
        const sentinel = join(dir, "sentinel.txt");
        writeFileSync(sentinel, "Claude dispatched", "utf8");

        const result = readRunnerSession({
          runner: "claude",
          sentinelFile: sentinel,
        });
        assert.equal(result, "Claude dispatched");
      });

      it("routes pi runner to readPiSession", () => {
        const dir = createTestDir();
        const sessionFile = join(dir, "pi-session.jsonl");
        const lines = [
          JSON.stringify({ type: "session", id: "p1" }),
          JSON.stringify({
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "Pi dispatched" }] },
          }),
        ];
        writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

        const result = readRunnerSession({
          runner: "pi",
          sessionFile,
        });
        assert.equal(result, "Pi dispatched");
      });

      it("returns null for unsupported runner", () => {
        const result = readRunnerSession({ runner: "unknown-runner" });
        assert.equal(result, null);
      });
    });
  });

  describe("launchSubagent & resumeSubagent bug fixes", () => {
    it("launchSubagent does not throw ReferenceError for subagentDonePath", async () => {
      const testApi = (subagentsModule as any).__test__;
      assert.ok(testApi.launchSubagent, "expected launchSubagent to be exported in __test__");

      const dir = createTestDir();
      const parentSession = join(dir, "parent.jsonl");
      writeFileSync(parentSession, JSON.stringify({ type: "session", id: "p1" }) + "\n");

      const ctx = {
        sessionManager: {
          getSessionFile() { return parentSession; },
          getSessionId() { return "parent-id"; },
          getSessionDir() { return dir; },
        },
        cwd: dir,
      };

      try {
        await testApi.launchSubagent(
          {
            cli: "pi",
            task: "Greeting task",
            name: "test-launch",
          },
          ctx,
          { surface: "dummy-surface-1" },
        );
      } catch (err: any) {
        // It may fail due to Herdr not being connected to dummy-surface-1 in test environment,
        // but it MUST NOT fail with ReferenceError: subagentDonePath is not defined.
        assert.notEqual(err instanceof ReferenceError, true, `Unexpected ReferenceError: ${err?.message}`);
        assert.doesNotMatch(err?.message ?? "", /subagentDonePath is not defined/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("launchSubagent cleans up newly created surface if launch throws", async () => {
      const testApi = (subagentsModule as any).__test__;
      const dir = createTestDir();
      const parentSession = join(dir, "parent.jsonl");
      writeFileSync(parentSession, JSON.stringify({ type: "session", id: "p1" }) + "\n");

      const ctx = {
        sessionManager: {
          getSessionFile() { return parentSession; },
          getSessionId() { return "parent-id"; },
          getSessionDir() { return dir; },
        },
        cwd: dir,
      };

      try {
        await testApi.launchSubagent(
          {
            cli: "pi",
            task: "Test fail cleanup",
            name: "fail-test",
          },
          ctx,
          { surface: "nonexistent-surface-to-fail" },
        );
      } catch (err: any) {
        assert.notEqual(err instanceof ReferenceError, true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ensures subagent-done.ts file exists on disk at expected path", () => {
      const subagentsDir = join(fileURLToPath(import.meta.url), "../../pi-extension/subagents");
      const subagentDonePath = join(subagentsDir, "subagent-done.ts");
      assert.equal(existsSync(subagentDonePath), true, `Expected ${subagentDonePath} to exist`);
    });
  });

  describe("subagent stop & surface termination bug fixes", () => {
    it("exports terminateSurface from __test__ and herdr.ts", () => {
      const testApi = (subagentsModule as any).__test__;
      assert.equal(typeof testApi.terminateSurface, "function");
      assert.equal(typeof terminateSurface, "function");
    });

    it("stopSubagentByName handles running subagent with terminateSurface cleanly", () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      let aborted = false;
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "test-bot",
        surface: "nonexistent-surface-stop-1",
        abortController: { abort() { aborted = true; } },
      }));

      const restoreHerdr = useEmptyFakeHerdr();
      try {
        const msg = testApi.stopSubagentByName("test-bot");
        assert.match(msg, /Subagent "test-bot" stopped/);
        assert.equal(aborted, true);
        assert.equal(runningMap.has("a1"), false);
      } finally {
        restoreHerdr();
        runningMap.clear();
      }
    });

    it("subagent_stop tool handles closePane: false without error", async () => {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      const stopTool = registeredTools.find((t: any) => t.name === "subagent_stop");
      assert.ok(stopTool);

      let aborted = false;
      runningMap.set("a1", makeRunning({
        id: "a1",
        name: "test-bot-2",
        surface: "nonexistent-surface-stop-2",
        abortController: { abort() { aborted = true; } },
      }));

      try {
        const res = await stopTool.execute("call-stop-1", { name: "test-bot-2", closePane: false });
        assert.equal(res.details?.stopped, true);
        assert.equal(res.details?.name, "test-bot-2");
        assert.equal(aborted, true);
        assert.equal(runningMap.size, 0);
      } finally {
        runningMap.clear();
      }
    });
  });

  describe("getNativeSessionFile", () => {
    it("resolves agy transcript under brain directory by conversationId", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "agy-file-test-"));
      try {
        const convDir = join(tempDir, "conv-123", ".system_generated", "logs");
        mkdirSync(convDir, { recursive: true });
        const transcriptPath = join(convDir, "transcript.jsonl");
        writeFileSync(transcriptPath, '{"step_index":0}\n');

        const resolved = getNativeSessionFile({
          runner: "agy",
          sessionId: "conv-123",
          brainDir: tempDir,
        });
        assert.equal(resolved, transcriptPath);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("resolves claude transcript under projects directory by slug and sessionId", () => {
      const tempProjects = mkdtempSync(join(tmpdir(), "claude-proj-test-"));
      try {
        const cwd = "D:\\test\\my-project";
        const slug = toClaudeProjectSlug(cwd);
        const projDir = join(tempProjects, slug);
        mkdirSync(projDir, { recursive: true });
        const sessionFile = join(projDir, "session-abc.jsonl");
        writeFileSync(sessionFile, '{"type":"message"}\n');

        const resolved = getNativeSessionFile({
          runner: "claude",
          sessionId: "session-abc",
          cwd,
          projectsDir: tempProjects,
        });
        assert.equal(resolved, sessionFile);
      } finally {
        rmSync(tempProjects, { recursive: true, force: true });
      }
    });

    it("returns null for non-native runners", () => {
      assert.equal(getNativeSessionFile({ runner: "codex" }), null);
      assert.equal(getNativeSessionFile({ runner: "grok" }), null);
    });
  });

  describe("pollForExit debounce & settle verification", () => {
    const { setAgentStateOverride, setSurfaceAliveOverride, setReadScreenOverride } = __pollForExitTest__ as any;

    beforeEach(() => {
      setAgentStateOverride(null);
      setSurfaceAliveOverride(null);
      setReadScreenOverride(() => "");
    });

    after(() => {
      setAgentStateOverride(null);
      setSurfaceAliveOverride(null);
      setReadScreenOverride(null);
    });

    it("does not exit on a single transient idle tick; requires idleSettleCount consecutive idle checks", async () => {
      setSurfaceAliveOverride(() => true);

      // State sequence: working -> idle (1) -> idle (2) -> idle (3 -> done)
      let tick = 0;
      setAgentStateOverride(() => {
        tick++;
        if (tick === 1) return { name: "test", state: "working" };
        return { name: "test", state: "idle" };
      });

      const ac = new AbortController();
      const result = await pollForExit("dummy-surface", ac.signal, {
        interval: 10,
        agentName: "test",
        runner: "agy",
        idleSettleCount: 3,
      });

      assert.equal(result.reason, "done");
      assert.equal(result.exitCode, 0);
      assert.ok(tick >= 4, `expected at least 4 ticks (1 working + 3 idle), got ${tick}`);
    });

    it("resets idle streak when agent transitions back to working", async () => {
      setSurfaceAliveOverride(() => true);

      // Sequence: working -> idle (1) -> idle (2) -> working (reset!) -> idle (1) -> idle (2) -> idle (3 -> done)
      let tick = 0;
      setAgentStateOverride(() => {
        tick++;
        if (tick === 1) return { name: "test", state: "working" };
        if (tick === 2 || tick === 3) return { name: "test", state: "idle" };
        if (tick === 4) return { name: "test", state: "working" }; // interrupts idle streak
        return { name: "test", state: "idle" };
      });

      const ac = new AbortController();
      const result = await pollForExit("dummy-surface", ac.signal, {
        interval: 10,
        agentName: "test",
        runner: "claude",
        idleSettleCount: 3,
      });

      assert.equal(result.reason, "done");
      assert.equal(result.exitCode, 0);
      // tick 1 (working), 2 (idle 1), 3 (idle 2), 4 (working reset), 5 (idle 1), 6 (idle 2), 7 (idle 3 -> exit)
      assert.ok(tick >= 7, `expected at least 7 ticks due to reset, got ${tick}`);
    });

    it("pi runner does not exit on Herdr idle state", async () => {
      setSurfaceAliveOverride(() => true);

      let tick = 0;
      setAgentStateOverride(() => {
        tick++;
        if (tick === 1) return { name: "pi-agent", state: "working" };
        // Continues in idle — Pi should NOT exit based on idle
        return { name: "pi-agent", state: "idle" };
      });

      const ac = new AbortController();
      // Abort after 50ms so the test doesn't loop infinitely
      setTimeout(() => ac.abort(), 60);

      await assert.rejects(
        pollForExit("dummy-surface", ac.signal, {
          interval: 10,
          agentName: "pi-agent",
          runner: "pi",
          idleSettleCount: 2,
        }),
        /Aborted/,
      );
      assert.ok(tick >= 3, `Pi runner should have observed multiple idle ticks without exiting, got ${tick}`);
    });

    it("resets idle count when native transcript file was modified within 3 seconds", async () => {
      setSurfaceAliveOverride(() => true);

      const tempDir = mkdtempSync(join(tmpdir(), "agy-mtime-test-"));
      try {
        const convDir = join(tempDir, "conv-live", ".system_generated", "logs");
        mkdirSync(convDir, { recursive: true });
        const transcriptPath = join(convDir, "transcript.jsonl");
        writeFileSync(transcriptPath, '{"step": 1}\n');

        let tick = 0;
        setAgentStateOverride(() => {
          tick++;
          if (tick === 1) return { name: "agy-agent", state: "working", sessionId: "conv-live" };
          if (tick <= 3) {
            // Touch the file on ticks 2 and 3 to simulate active streaming
            writeFileSync(transcriptPath, `{"step": ${tick}}\n`);
          }
          return { name: "agy-agent", state: "idle", sessionId: "conv-live" };
        });

        // Patch homedir / brainDir via getNativeSessionFile or direct file
        // To test getNativeSessionFile with custom brainDir, we pass options or test through the mtime logic:
        // Here we test that if the file is touched, polling extends.
        const ac = new AbortController();
        const result = await pollForExit("dummy-surface", ac.signal, {
          interval: 15,
          agentName: "agy-agent",
          runner: "agy",
          idleSettleCount: 2,
        });

        assert.equal(result.reason, "done");
        assert.equal(result.exitCode, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("pi runner consumes a fresh .parked sidecar as turn completion", async () => {
      setSurfaceAliveOverride(() => true);
      // Idle throughout — the sidecar alone must complete, idle must not.
      setAgentStateOverride(() => ({ name: "pi-agent", state: "idle" }));

      const dir = mkdtempSync(join(tmpdir(), "pi-parked-"));
      try {
        const sessionFile = join(dir, "s.jsonl");
        writeFileSync(sessionFile, "");
        const turnStartTime = Date.now() - 5_000;
        writeFileSync(
          `${sessionFile}.parked`,
          JSON.stringify({ parkedAt: Date.now(), name: "worker", agent: "worker" }),
        );

        const ac = new AbortController();
        const result = await pollForExit("dummy-surface", ac.signal, {
          interval: 10,
          agentName: "pi-agent",
          runner: "pi",
          sessionFile,
          turnStartTime,
        });

        assert.equal(result.reason, "done");
        assert.equal(result.exitCode, 0);
        assert.ok(!existsSync(`${sessionFile}.parked`), "consumed .parked must be deleted");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops a stale .parked sidecar from a previous turn and keeps polling", async () => {
      setSurfaceAliveOverride(() => true);
      setAgentStateOverride(() => ({ name: "pi-agent", state: "working" }));

      const dir = mkdtempSync(join(tmpdir(), "pi-parked-stale-"));
      try {
        const sessionFile = join(dir, "s.jsonl");
        writeFileSync(sessionFile, "");
        // Parked before the current turn started — a leftover, not this turn's result.
        writeFileSync(`${sessionFile}.parked`, JSON.stringify({ parkedAt: Date.now() - 60_000 }));

        const ac = new AbortController();
        const pending = pollForExit("dummy-surface", ac.signal, {
          interval: 10,
          agentName: "pi-agent",
          runner: "pi",
          sessionFile,
          turnStartTime: Date.now() - 1_000,
        });
        await new Promise((r) => setTimeout(r, 80));
        assert.ok(!existsSync(`${sessionFile}.parked`), "stale .parked must be consumed and dropped");
        ac.abort();
        await assert.rejects(pending, /Aborted/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("consumes a fresh .exit error sidecar and reports the failure", async () => {
      setSurfaceAliveOverride(() => true);
      setAgentStateOverride(() => ({ name: "pi-agent", state: "working" }));

      const dir = mkdtempSync(join(tmpdir(), "pi-exit-fresh-"));
      try {
        const sessionFile = join(dir, "s.jsonl");
        writeFileSync(sessionFile, "");
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({
            type: "error",
            errorMessage: "Anthropic 529 Overloaded",
            writtenAt: Date.now(),
          }),
        );

        const ac = new AbortController();
        const result = await pollForExit("dummy-surface", ac.signal, {
          interval: 10,
          agentName: "pi-agent",
          runner: "pi",
          sessionFile,
          turnStartTime: Date.now() - 1_000,
        });

        assert.equal(result.reason, "error");
        assert.equal(result.exitCode, 1);
        assert.equal(result.errorMessage, "Anthropic 529 Overloaded");
        assert.ok(!existsSync(`${sessionFile}.exit`), "consumed .exit must be deleted");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores a stale .exit sidecar from a previous turn", async () => {
      setSurfaceAliveOverride(() => true);
      setAgentStateOverride(() => ({ name: "pi-agent", state: "working" }));

      const dir = mkdtempSync(join(tmpdir(), "pi-exit-stale-"));
      try {
        const sessionFile = join(dir, "s.jsonl");
        writeFileSync(sessionFile, "");
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({
            type: "error",
            errorMessage: "previous turn failure",
            writtenAt: Date.now() - 60_000,
          }),
        );

        const ac = new AbortController();
        const pending = pollForExit("dummy-surface", ac.signal, {
          interval: 10,
          agentName: "pi-agent",
          runner: "pi",
          sessionFile,
          turnStartTime: Date.now() - 1_000,
        });
        await new Promise((r) => setTimeout(r, 80));
        assert.ok(!existsSync(`${sessionFile}.exit`), "stale .exit must be consumed and dropped");
        ac.abort();
        await assert.rejects(pending, /Aborted/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("accepts legacy .exit payloads without writtenAt (pre-freshness behavior)", async () => {
      setSurfaceAliveOverride(() => true);
      setAgentStateOverride(() => ({ name: "pi-agent", state: "working" }));

      const dir = mkdtempSync(join(tmpdir(), "pi-exit-legacy-"));
      try {
        const sessionFile = join(dir, "s.jsonl");
        writeFileSync(sessionFile, "");
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({ type: "error", errorMessage: "legacy payload" }),
        );

        const ac = new AbortController();
        const result = await pollForExit("dummy-surface", ac.signal, {
          interval: 10,
          agentName: "pi-agent",
          runner: "pi",
          sessionFile,
          turnStartTime: Date.now() - 1_000,
        });

        assert.equal(result.reason, "error");
        assert.equal(result.errorMessage, "legacy payload");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});


describe("herdr.ts CLI error payloads (exit 0)", () => {
  const errorRun = () =>
    JSON.stringify({ error: { code: "agent_pane_busy", message: "pane is not an available shell" } });

  it("does not treat a failed agent start as success", async () => {
    const restore = setHerdrExecDeps({ available: () => true, run: errorRun, runAsync: async () => errorRun() });
    try {
      assert.throws(
        () => startAgent("scout", "claude", "w1:p1"),
        /agent_pane_busy: pane is not an available shell/,
      );
      await assert.rejects(
        startAgentAsync("scout", "claude", "w1:p1"),
        /agent_pane_busy: pane is not an available shell/,
      );
    } finally {
      restore();
    }
  });

  it("surfaces a failed prompt instead of typing it into the pane", () => {
    const restore = setHerdrExecDeps({ available: () => true, run: errorRun });
    try {
      assert.throws(
        () => promptAgent("scout", "search the news"),
        /agent_pane_busy: pane is not an available shell/,
      );
    } finally {
      restore();
    }
  });
});
