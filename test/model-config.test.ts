import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatParentModel,
  parseModelConfig,
  resolveModel,
  type ModelConfig,
} from "../pi-extension/subagents/model-config.ts";

const config: ModelConfig = {
  default: "provider/config-default",
  agents: { scout: "provider/scout" },
};

describe("model-config.ts precedence", () => {
  it("prefers an explicit model over every other source", () => {
    assert.deepEqual(
      resolveModel({
        explicitModel: "provider/explicit",
        agentName: "scout",
        agentModel: "provider/frontmatter",
        config,
        env: { PI_SUBAGENT_DEFAULT_MODEL: "provider/env" },
        parentModel: "provider/parent",
      }),
      { model: "provider/explicit", source: "explicit" },
    );
  });

  it("prefers agent frontmatter over config", () => {
    assert.deepEqual(
      resolveModel({
        agentName: "scout",
        agentModel: "provider/frontmatter",
        config,
        env: { PI_SUBAGENT_DEFAULT_MODEL: "provider/env" },
        parentModel: "provider/parent",
      }),
      { model: "provider/frontmatter", source: "agent-frontmatter" },
    );
  });

  it("prefers a per-agent config entry over env and default", () => {
    assert.deepEqual(
      resolveModel({ agentName: "scout", config, env: { PI_SUBAGENT_DEFAULT_MODEL: "provider/env" } }),
      { model: "provider/scout", source: "config-agent" },
    );
  });

  it("prefers the env default over the config default", () => {
    assert.deepEqual(
      resolveModel({ config, env: { PI_SUBAGENT_DEFAULT_MODEL: "provider/env" } }),
      { model: "provider/env", source: "env" },
    );
  });

  it("falls back to the config default, then the parent model", () => {
    assert.deepEqual(resolveModel({ config }), {
      model: "provider/config-default",
      source: "config-default",
    });
    assert.deepEqual(resolveModel({ parentModel: "provider/parent" }), {
      model: "provider/parent",
      source: "parent",
    });
  });

  it("returns none when no source supplies a model", () => {
    assert.deepEqual(resolveModel({}), { model: null, source: "none" });
  });

  it("treats empty and whitespace-only values as absent", () => {
    assert.deepEqual(
      resolveModel({
        explicitModel: "   ",
        agentModel: "",
        config: { agents: { scout: "  " } },
        env: { PI_SUBAGENT_DEFAULT_MODEL: "" },
        parentModel: " ",
      }),
      { model: null, source: "none" },
    );
  });
});

describe("model-config.ts parsing", () => {
  it("parses default and per-agent models", () => {
    assert.deepEqual(
      parseModelConfig({ default: "provider/default", agents: { scout: "provider/scout" } }),
      { default: "provider/default", agents: { scout: "provider/scout" } },
    );
  });

  it("omits an absent default and accepts an empty models object", () => {
    assert.deepEqual(parseModelConfig({}), { agents: {} });
    assert.deepEqual(parseModelConfig({ agents: {} }), { agents: {} });
  });

  it("rejects unsupported keys and non-string values", () => {
    assert.throws(
      () => parseModelConfig({ default: "x", extra: true }),
      /models has unsupported key\(s\): extra/,
    );
    assert.throws(() => parseModelConfig({ default: 42 }), /models\.default must be a non-empty string/);
    assert.throws(
      () => parseModelConfig({ agents: { scout: "" } }),
      /models\.agents\.scout must be a non-empty string/,
    );
    assert.throws(() => parseModelConfig(null), /models must be an object/);
  });
});

describe("model-config.ts parent model formatting", () => {
  it("renders provider/id, id-only, and null", () => {
    assert.equal(formatParentModel({ provider: "anthropic", id: "claude-sonnet" }), "anthropic/claude-sonnet");
    assert.equal(formatParentModel({ id: "claude-sonnet" }), "claude-sonnet");
    assert.equal(formatParentModel(null), null);
    assert.equal(formatParentModel({}), null);
  });
});
