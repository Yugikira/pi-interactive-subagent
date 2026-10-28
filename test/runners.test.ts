import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  describeRunnerChoices,
  getRunner,
  getRunnerOrDefault,
  isNativeSessionRunner,
  listRunners,
  normalizeRunner,
} from "../pi-extension/subagents/runners/registry.ts";
import {
  buildPiLaunch,
  piAdapter,
  providerExtensionPaths,
  providerFromModel,
} from "../pi-extension/subagents/runners/pi.ts";
import { agyAdapter } from "../pi-extension/subagents/runners/agy.ts";
import { claudeAdapter } from "../pi-extension/subagents/runners/claude.ts";
import { toClaudeProjectSlug } from "../pi-extension/subagents/session.ts";
import { readCapturedOutput, setHerdrExecDeps } from "../pi-extension/subagents/herdr.ts";
import type {
  RunnerLaunchContext,
  RunnerResultContext,
  RunnerResumeContext,
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

function makeResumeCtx(overrides: Partial<RunnerResumeContext> = {}): RunnerResumeContext {
  return {
    platform: "linux",
    sessionFile: join(dir, "session.jsonl"),
    sessionId: "native-session-1",
    launchArgs: ["--dangerously-skip-permissions", "--model", "test-model"],
    name: "scout",
    id: "abc123",
    message: "continue",
    messageFile: null,
    loadout: emptyLoadout,
    autoExit: true,
    agentDir: null,
    spawnable: null,
    cwd: dir,
    artifactDir: join(dir, "art"),
    activityFile: join(dir, "activity.json"),
    subagentDonePath: "/p/subagent-done.ts",
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

describe("runner provider extensions", () => {
  it("extracts the provider from a provider/model reference", () => {
    assert.equal(providerFromModel("antigravity/gemini-3.8-flash"), "antigravity");
    assert.equal(providerFromModel("gemini-3.8-flash"), null);
    assert.equal(providerFromModel(null), null);
  });

  it("re-enables a third-party provider extension under --no-extensions", () => {
    const npmDir = join(dir, "npm", "node_modules");
    const gitDir = join(dir, "git");
    const pkgDir = join(npmDir, "pi-antigravity");
    const extPath = join(pkgDir, "src", "index.ts");
    mkdirSync(dirname(extPath), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pi-antigravity", pi: { extensions: ["./src/index.ts"] } }),
    );
    writeFileSync(extPath, "");

    assert.deepEqual(providerExtensionPaths("antigravity", npmDir, gitDir), [extPath]);
    assert.deepEqual(providerExtensionPaths("antigravity", npmDir, gitDir), [extPath], "cached");
    assert.deepEqual(providerExtensionPaths("anthroppic", npmDir, gitDir), []);

    // Built-in providers never scan packages, even if a similarly named
    // extension exists (e.g. a `pi-google` search extension).
    const googlePkg = join(npmDir, "pi-google");
    mkdirSync(join(googlePkg, "src"), { recursive: true });
    writeFileSync(
      join(googlePkg, "package.json"),
      JSON.stringify({ name: "pi-google", pi: { extensions: ["./src/index.ts"] } }),
    );
    writeFileSync(join(googlePkg, "src", "index.ts"), "");
    assert.deepEqual(providerExtensionPaths("google", npmDir, gitDir), []);

    // Git-installed packages are discovered under git/<host>/<owner>/<repo>.
    const repoDir = join(gitDir, "github.com", "acme", "pi-stealth");
    const gitExt = join(repoDir, "src", "index.ts");
    mkdirSync(dirname(gitExt), { recursive: true });
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "pi-stealth", pi: { extensions: ["./src/index.ts"] } }),
    );
    writeFileSync(gitExt, "");
    assert.deepEqual(providerExtensionPaths("stealth", npmDir, gitDir), [gitExt]);
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

  it("loads the model provider extension alongside the tool sandbox", () => {
    const plan = buildPiLaunch(
      makeCtx({
        model: "antigravity/gemini-3.8-flash",
        loadout: { ...emptyLoadout, toolAllowlist: "read" },
      }),
      ["/ext/pi-antigravity/index.ts"],
    );

    assert.ok(plan.startArgs.includes("--no-extensions"));
    const index = plan.startArgs.indexOf("/ext/pi-antigravity/index.ts");
    assert.ok(index > 0);
    assert.equal(plan.startArgs[index - 1], "-e");
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
        '$__piOk = $?; $__piCode = $LASTEXITCODE; ' +
        'if ($null -eq $__piCode) { $__piCode = if ($__piOk) { 0 } else { 1 } }; ' +
        'echo "__SUBAGENT_DONE_${__piCode}__"',
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

  it("extracts the last Claude assistant message from project transcript", () => {
    const projectsDir = join(dir, "projects");
    const cwd = join(dir, "workspace");
    const slug = toClaudeProjectSlug(cwd);
    const projDir = join(projectsDir, slug);
    mkdirSync(projDir, { recursive: true });

    const sessionFile = join(projDir, "claude-session-1.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Claude final answer" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const ctx = makeResultCtx({ cwd, sessionId: "claude-session-1", projectsDir });
    assert.deepEqual(claudeAdapter.extractResult(ctx), { summary: "Claude final answer" });
  });

  it("returns null for a missing Claude session", () => {
    assert.equal(claudeAdapter.extractResult(makeResultCtx({ projectsDir: join(dir, "empty") })), null);
  });

  it("extracts the last Agy assistant message from brain transcript", () => {
    const brainDir = join(dir, "brain");
    const convDir = join(brainDir, "conv-1", ".system_generated", "logs");
    mkdirSync(convDir, { recursive: true });

    const transcriptFile = join(convDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ step: 1, source: "USER", content: "task" }),
        JSON.stringify({
          step: 2,
          source: "MODEL",
          created_at: new Date().toISOString(),
          content: "Agy final answer",
        }),
      ].join("\n") + "\n",
    );

    const ctx = makeResultCtx({ sessionId: "conv-1", brainDir });
    assert.deepEqual(agyAdapter.extractResult(ctx), { summary: "Agy final answer" });
  });

  it("returns null for a missing Agy session", () => {
    assert.equal(agyAdapter.extractResult(makeResultCtx({ brainDir: join(dir, "empty") })), null);
  });

  it("readCapturedOutput tries agent output, surface output, and screen fallback with sanitization", () => {
    let callHistory: string[][] = [];
    const restore = setHerdrExecDeps({
      available: () => true,
      run: (args) => {
        callHistory.push(args);
        if (args[0] === "agent" && args[1] === "read" && args[2] === "named-agent") {
          return "raw agent text\n__SUBAGENT_DONE_0__\n> ";
        }
        if (args[0] === "pane" && args[1] === "read") {
          return "\x1b[32mcolor screen text\x1b[0m\n__SUBAGENT_DONE_0__\n> ";
        }
        throw new Error("not found");
      },
      runAsync: async (args) => "",
    });

    try {
      // 1. Success on named agent
      callHistory = [];
      const res1 = readCapturedOutput("pane-1", "named-agent");
      assert.equal(res1, "raw agent text");
      assert.equal(callHistory[0][0], "agent");
      assert.equal(callHistory[0][2], "named-agent");

      // 2. Fallback to pane read when agent read fails
      callHistory = [];
      const res2 = readCapturedOutput("pane-1", "missing-agent");
      assert.equal(res2, "color screen text");
      assert.ok(callHistory.some((c) => c[0] === "pane" && c[1] === "read"));
    } finally {
      restore();
    }
  });
});

describe("claude adapter launch plan", () => {
  it("passes a multi-line agent body by file, never as a single argv value", () => {
    const body = "Line one.\nLine two.\n\n## Process\n1. Do the work.";
    const plan = claudeAdapter.buildLaunch(
      makeCtx({
        platform: "win32",
        artifactDir: dir,
        agent: { body },
      }),
    );

    const flagIndex = plan.startArgs.indexOf("--append-system-prompt-file");
    assert.ok(flagIndex >= 0, "expected --append-system-prompt-file");
    const promptFile = plan.startArgs[flagIndex + 1];
    assert.ok(promptFile.startsWith(join(dir, "context")));
    assert.equal(readFileSync(promptFile, "utf8"), body);
    assert.equal(plan.startArgs.includes("--append-system-prompt"), false);
    for (const arg of plan.startArgs) {
      assert.ok(!arg.includes("\n"), `agent start arg contains a newline: ${arg}`);
    }
    assert.equal(plan.prompt, "do it");
  });

  it("passes an explicitly resolved model", () => {
    const plan = claudeAdapter.buildLaunch(makeCtx({ model: "claude-sonnet-5-5" }));
    const index = plan.startArgs.indexOf("--model");
    assert.ok(index >= 0);
    assert.equal(plan.startArgs[index + 1], "claude-sonnet-5-5");
  });
});

describe("runner resume plans", () => {
  it("marks Pi, Claude, and Agy resumable; protocol runners not", () => {
    assert.equal(piAdapter.supportsResume, true);
    assert.equal(claudeAdapter.supportsResume, true);
    assert.equal(agyAdapter.supportsResume, true);
    assert.equal(getRunner("codex")!.supportsResume, false);
  });

  it("builds a shell plan for Pi without changing the command builder", () => {
    const plan = piAdapter.buildResume!(makeResumeCtx());
    if (!plan || plan.mode !== "shell") throw new Error("expected a shell plan");
    assert.match(plan.command, /--session/);
    assert.equal(plan.cwd, dir);
    assert.equal(piAdapter.buildResume!(makeResumeCtx({ loadout: null })), null);
  });

  it("builds a Claude agent plan with --resume and the original argv", () => {
    const identity = join(dir, "identity.md");
    writeFileSync(identity, "identity");
    const launchArgs = [
      "--dangerously-skip-permissions",
      "--model",
      "claude-sonnet-5-5",
      "--append-system-prompt-file",
      identity,
    ];
    const plan = claudeAdapter.buildResume!(makeResumeCtx({ launchArgs }));
    if (!plan || plan.mode !== "agent") throw new Error("expected an agent plan");
    assert.deepEqual(plan.startArgs, ["--resume", "native-session-1", ...launchArgs]);
    assert.equal(plan.prompt, "continue");
    assert.equal(plan.env.PI_SUBAGENT_NAME, "scout");
  });

  it("refuses a Claude resume when the identity file is gone", () => {
    const launchArgs = ["--append-system-prompt-file", join(dir, "missing.md")];
    assert.equal(claudeAdapter.buildResume!(makeResumeCtx({ launchArgs })), null);
  });

  it("builds an Agy agent plan with --conversation and replayed model/effort", () => {
    const launchArgs = [
      "--dangerously-skip-permissions",
      "--model",
      "gemini-x",
      "--effort",
      "high",
    ];
    const plan = agyAdapter.buildResume!(makeResumeCtx({ launchArgs, sessionId: "conv-9" }));
    if (!plan || plan.mode !== "agent") throw new Error("expected an agent plan");
    assert.deepEqual(plan.startArgs, ["--conversation", "conv-9", ...launchArgs]);
    assert.equal(plan.prompt, "continue");
  });

  it("refuses resume without a native id or launch argv", () => {
    assert.equal(claudeAdapter.buildResume!(makeResumeCtx({ sessionId: null })), null);
    assert.equal(agyAdapter.buildResume!(makeResumeCtx({ launchArgs: null })), null);
  });

  it("replays the Pi resume model without double-escaping it", () => {
    const plan = piAdapter.buildResume!(
      makeResumeCtx({
        platform: "win32",
        loadout: { ...emptyLoadout, model: "minimax-cn/MiniMax-3.1-Flash" },
      }),
    );
    if (!plan || plan.mode !== "shell") throw new Error("expected a shell plan");
    assert.match(plan.command, /--model/);
    assert.doesNotMatch(plan.command, /''|"'/);
  });
});
