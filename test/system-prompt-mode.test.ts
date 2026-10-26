import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAgentDefinition } from "../pi-extension/subagents/agents.ts";
import { applySandboxToParts } from "../pi-extension/subagents/runners/pi.ts";
import type { SubagentLoadout } from "../pi-extension/subagents/signals.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "system-prompt-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function loadout(overrides: Partial<SubagentLoadout> = {}): SubagentLoadout {
  return {
    agent: "worker",
    toolAllowlist: null,
    model: null,
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: false,
    cwd: null,
    agentDir: null,
    ...overrides,
  };
}

function sandboxArgs(overrides: Partial<SubagentLoadout>): string[] {
  const parts: string[] = [];
  applySandboxToParts(parts, loadout(overrides), {
    artifactDir: dir,
    name: "worker",
    escape: false,
  });
  return parts;
}

describe("system-prompt frontmatter", () => {
  it("parses replace, append, and absent modes", () => {
    assert.equal(
      parseAgentDefinition("---\nname: x\nsystem-prompt: replace\n---\nBody", "x")?.systemPromptMode,
      "replace",
    );
    assert.equal(
      parseAgentDefinition("---\nname: x\nsystem-prompt: append\n---\nBody", "x")?.systemPromptMode,
      "append",
    );
    assert.equal(
      parseAgentDefinition("---\nname: x\nsystem-prompt: bogus\n---\nBody", "x")?.systemPromptMode,
      undefined,
    );
  });

  it("keeps the body separate from frontmatter", () => {
    const parsed = parseAgentDefinition(
      "---\nname: x\nsystem-prompt: append\n---\n\nYou are X.\n",
      "x",
    );
    assert.equal(parsed?.body, "You are X.");
  });
});

describe("system-prompt flag generation", () => {
  it("uses --system-prompt for replace mode", () => {
    const args = sandboxArgs({
      identity: "You are X.",
      systemPromptMode: "replace",
    });
    assert.ok(args.includes("--system-prompt"));
    assert.equal(args.includes("--append-system-prompt"), false);
    const pathIndex = args.indexOf("--system-prompt") + 1;
    assert.equal(existsSync(args[pathIndex]), true);
  });

  it("uses --append-system-prompt for append mode", () => {
    const args = sandboxArgs({
      identity: "You are X.",
      systemPromptMode: "append",
    });
    assert.ok(args.includes("--append-system-prompt"));
    assert.equal(args.includes("--system-prompt"), false);
  });

  it("adds no system-prompt flag when no identity was routed there", () => {
    const args = sandboxArgs({ identity: null, systemPromptMode: "append" });
    assert.equal(args.includes("--append-system-prompt"), false);
    assert.equal(args.includes("--system-prompt"), false);
  });
});
