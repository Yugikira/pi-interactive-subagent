import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverAgentDefinitions,
  getAgentDirs,
  getBundledAgentsDir,
  getSubagentAllowlist,
  loadAgentDefaults,
  parseAgentDefinition,
  type AgentDirs,
} from "../pi-extension/subagents/agents.ts";

let root: string;
let dirs: AgentDirs;

function writeAgent(dir: string, name: string, frontmatter: string, body = "Body."): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agents-test-"));
  dirs = {
    projectDir: join(root, "project"),
    globalDir: join(root, "global"),
    packageDir: join(root, "package"),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("agents.ts frontmatter parsing", () => {
  it("parses every supported frontmatter field", () => {
    const parsed = parseAgentDefinition(
      [
        "---",
        "name: worker",
        "description: Does work",
        "model: provider/model",
        "tools: read, write",
        "skills: alpha, beta",
        "thinking: high",
        "system-prompt: replace",
        "subagent_agents: scout, researcher",
        "auto-exit: true",
        "interactive: false",
        "session-mode: lineage-only",
        "cwd: /tmp/project",
        "cli: pi",
        "disable-model-invocation: true",
        "---",
        "",
        "You are a worker.",
      ].join("\n"),
      "fallback",
    );

    assert.ok(parsed);
    assert.equal(parsed.name, "worker");
    assert.equal(parsed.description, "Does work");
    assert.equal(parsed.model, "provider/model");
    assert.equal(parsed.tools, "read, write");
    assert.equal(parsed.skills, "alpha, beta");
    assert.equal(parsed.thinking, "high");
    assert.equal(parsed.systemPromptMode, "replace");
    assert.deepEqual(parsed.subagentAgents, ["scout", "researcher"]);
    assert.equal(parsed.autoExit, true);
    assert.equal(parsed.interactive, false);
    assert.equal(parsed.sessionMode, "lineage-only");
    assert.equal(parsed.cwd, "/tmp/project");
    assert.equal(parsed.cli, "pi");
    assert.equal(parsed.disableModelInvocation, true);
    assert.equal(parsed.body, "You are a worker.");
  });

  it("returns null without a frontmatter block and ignores invalid session modes", () => {
    assert.equal(parseAgentDefinition("no frontmatter", "x"), null);

    const parsed = parseAgentDefinition("---\nname: x\nsession-mode: bogus\n---\n", "x");
    assert.equal(parsed?.sessionMode, undefined);
    assert.equal(parsed?.systemPromptMode, undefined);
  });

  it("uses the filename as the fallback name", () => {
    assert.equal(parseAgentDefinition("---\ndescription: d\n---\n", "file-name")?.name, "file-name");
  });
});

describe("agents.ts discovery precedence", () => {
  it("lets project override global override package", () => {
    writeAgent(dirs.packageDir, "worker", "name: worker\ndescription: package");
    writeAgent(dirs.globalDir, "worker", "name: worker\ndescription: global");
    writeAgent(dirs.projectDir, "worker", "name: worker\ndescription: project");
    writeAgent(dirs.packageDir, "scout", "name: scout\ndescription: package scout");

    const agents = discoverAgentDefinitions({ dirs, allowlist: null });
    const worker = agents.find((agent) => agent.name === "worker");
    const scout = agents.find((agent) => agent.name === "scout");

    assert.equal(worker?.description, "project");
    assert.equal(worker?.source, "project");
    assert.equal(scout?.source, "package");
  });

  it("filters discovery through the PI_SUBAGENT_ALLOWED allowlist", () => {
    writeAgent(dirs.packageDir, "scout", "name: scout");
    writeAgent(dirs.packageDir, "worker", "name: worker");

    const agents = discoverAgentDefinitions({ dirs, allowlist: new Set(["scout"]) });
    assert.deepEqual(agents.map((agent) => agent.name), ["scout"]);
  });

  it("loadAgentDefaults stops at the first matching directory", () => {
    writeAgent(dirs.packageDir, "worker", "name: worker\ndescription: package");
    writeAgent(dirs.globalDir, "worker", "name: worker\ndescription: global");

    assert.equal(loadAgentDefaults("worker", { dirs })?.description, "global");
    assert.equal(loadAgentDefaults("missing", { dirs }), null);
  });

  it("builds the default dirs from cwd and the agent config env", () => {
    const built = getAgentDirs({ cwd: "/tmp/project", env: { PI_CODING_AGENT_DIR: "/tmp/agent" } });
    assert.equal(built.projectDir, join("/tmp/project", ".pi", "agents"));
    assert.equal(built.globalDir, join("/tmp/agent", "agents"));
    assert.equal(built.packageDir, getBundledAgentsDir());
  });
});

describe("agents.ts allowlist parsing", () => {
  it("returns null when unset or empty and a set otherwise", () => {
    assert.equal(getSubagentAllowlist({}), null);
    assert.equal(getSubagentAllowlist({ PI_SUBAGENT_ALLOWED: "  " }), null);
    assert.deepEqual(
      [...(getSubagentAllowlist({ PI_SUBAGENT_ALLOWED: "scout, researcher" }) ?? [])],
      ["scout", "researcher"],
    );
  });
});

describe("bundled agents are provider-neutral", () => {
  it("no bundled agent hardcodes a model", () => {
    const bundled = discoverAgentDefinitions({ dirs: { ...dirs, packageDir: getBundledAgentsDir() }, allowlist: null });
    const withModels = bundled.filter((agent) => agent.model);
    assert.deepEqual(withModels, [], "bundled agents must inherit or configure their model");
  });
});
