import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSubagentConfig,
  loadSubagentConfig,
  loadStatusConfig,
  parseSubagentConfig,
  resetSubagentConfigCache,
  resolveConfigPaths,
} from "../pi-extension/subagents/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-test-"));
  resetSubagentConfigCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetSubagentConfigCache();
});

describe("config.ts parsing", () => {
  it("parses status and models together", () => {
    assert.deepEqual(
      parseSubagentConfig({
        status: { enabled: false, lineLimit: 2 },
        models: { default: "provider/default", agents: { scout: "provider/scout" } },
      }),
      {
        status: { enabled: false, lineLimit: 2 },
        models: { default: "provider/default", agents: { scout: "provider/scout" } },
      },
    );
  });

  it("defaults models to empty and lineLimit to 4", () => {
    assert.deepEqual(parseSubagentConfig({ status: { enabled: true } }), {
      status: { enabled: true, lineLimit: 4 },
      models: { agents: {} },
    });
  });

  it("rejects an invalid lineLimit and invalid models", () => {
    assert.throws(
      () => parseSubagentConfig({ status: { enabled: true, lineLimit: 0 } }),
      /status\.lineLimit must be a positive integer/,
    );
    assert.throws(
      () => parseSubagentConfig({ status: { enabled: true, lineLimit: 1.5 } }),
      /status\.lineLimit must be a positive integer/,
    );
    assert.throws(
      () => parseSubagentConfig({ status: { enabled: true }, models: { nope: "x" } }),
      /models has unsupported key\(s\): nope/,
    );
  });

  it("still requires a status section", () => {
    assert.throws(
      () => parseSubagentConfig({ models: { default: "x" } }),
      /status must be an object/,
    );
  });
});

describe("config.ts file loading", () => {
  it("loads a local config with models", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        status: { enabled: true, lineLimit: 7 },
        models: { agents: { worker: "provider/worker" } },
      }),
    );

    assert.deepEqual(loadSubagentConfig(configPath), {
      status: { enabled: true, lineLimit: 7 },
      models: { agents: { worker: "provider/worker" } },
    });
  });

  it("falls back to the example for models too", () => {
    const examplePath = join(dir, "config.json.example");
    writeFileSync(
      examplePath,
      JSON.stringify({ status: { enabled: true }, models: { default: "provider/example" } }),
    );

    assert.deepEqual(loadSubagentConfig(join(dir, "config.json"), examplePath), {
      status: { enabled: true, lineLimit: 4 },
      models: { default: "provider/example", agents: {} },
    });
  });

  it("keeps the status-only loader behavior", () => {
    const examplePath = join(dir, "config.json.example");
    writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }));

    assert.deepEqual(loadStatusConfig(join(dir, "config.json"), examplePath), {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("honors PI_SUBAGENT_CONFIG as the config path", () => {
    const configPath = join(dir, "custom.json");
    writeFileSync(configPath, JSON.stringify({ status: { enabled: false } }));

    const previous = process.env.PI_SUBAGENT_CONFIG;
    process.env.PI_SUBAGENT_CONFIG = configPath;
    try {
      assert.equal(resolveConfigPaths().configPath, configPath);
      resetSubagentConfigCache();
      assert.equal(getSubagentConfig().status.enabled, false);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CONFIG;
      else process.env.PI_SUBAGENT_CONFIG = previous;
    }
  });

  it("caches the loaded config until reset", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ status: { enabled: true } }));

    const previous = process.env.PI_SUBAGENT_CONFIG;
    process.env.PI_SUBAGENT_CONFIG = configPath;
    try {
      assert.equal(getSubagentConfig().status.enabled, true);
      writeFileSync(configPath, JSON.stringify({ status: { enabled: false } }));
      assert.equal(getSubagentConfig().status.enabled, true, "cached until reset");
      resetSubagentConfigCache();
      assert.equal(getSubagentConfig().status.enabled, false);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CONFIG;
      else process.env.PI_SUBAGENT_CONFIG = previous;
    }
  });
});
