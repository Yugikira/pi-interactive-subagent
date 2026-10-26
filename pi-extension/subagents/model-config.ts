/**
 * Model resolution for spawned subagents.
 *
 * Bundled agents are intentionally provider-neutral: a model id that only
 * exists on one machine makes every fresh install launch a doomed child. The
 * resolved model instead comes from the first source that supplies one:
 *
 *   1. explicit `subagent({ model })`
 *   2. agent frontmatter `model:`
 *   3. `models.agents.<name>` in config.json
 *   4. `PI_SUBAGENT_DEFAULT_MODEL`
 *   5. `models.default` in config.json
 *   6. the parent session's active model (`ctx.model`)
 *   7. none — the child uses Pi's own configured default
 *
 * Keeping this as a pure function means the precedence is table-testable and
 * the launch path never has to reconstruct it.
 */

export interface ModelConfig {
  default?: string;
  agents: Record<string, string>;
}

export type ModelSource =
  | "explicit"
  | "agent-frontmatter"
  | "config-agent"
  | "env"
  | "config-default"
  | "parent"
  | "none";

export interface ModelResolution {
  model: string | null;
  source: ModelSource;
}

export interface ResolveModelInput {
  explicitModel?: string | null;
  agentName?: string | null;
  agentModel?: string | null;
  config?: ModelConfig | null;
  env?: NodeJS.ProcessEnv;
  parentModel?: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function invalidModelConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidModelConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Parse the `models` section of config.json. Unknown keys are rejected. */
export function parseModelConfig(raw: unknown, source = "config.json"): ModelConfig {
  const models = requireObject(raw, source, "models");
  const unsupported = Object.keys(models).filter((key) => key !== "default" && key !== "agents");
  if (unsupported.length > 0) {
    invalidModelConfig(source, `models has unsupported key(s): ${unsupported.join(", ")}`);
  }

  let defaultModel: string | undefined;
  if (models.default != null) {
    const value = nonEmpty(models.default as string | undefined);
    if (!value || typeof models.default !== "string") {
      invalidModelConfig(source, "models.default must be a non-empty string");
    }
    defaultModel = value;
  }

  const agents: Record<string, string> = {};
  if (models.agents != null) {
    const entries = requireObject(models.agents, source, "models.agents");
    for (const [agent, value] of Object.entries(entries)) {
      const model = nonEmpty(value as string | undefined);
      if (!model || typeof value !== "string") {
        invalidModelConfig(source, `models.agents.${agent} must be a non-empty string`);
      }
      agents[agent] = model;
    }
  }

  return defaultModel ? { default: defaultModel, agents } : { agents };
}

/** Resolve the model and record which rule supplied it (for listing/debugging). */
export function resolveModel(input: ResolveModelInput): ModelResolution {
  const explicit = nonEmpty(input.explicitModel);
  if (explicit) return { model: explicit, source: "explicit" };

  const agentModel = nonEmpty(input.agentModel);
  if (agentModel) return { model: agentModel, source: "agent-frontmatter" };

  const agentName = nonEmpty(input.agentName);
  const configAgent = agentName ? nonEmpty(input.config?.agents?.[agentName]) : null;
  if (configAgent) return { model: configAgent, source: "config-agent" };

  const envModel = nonEmpty(input.env?.PI_SUBAGENT_DEFAULT_MODEL);
  if (envModel) return { model: envModel, source: "env" };

  const configDefault = nonEmpty(input.config?.default);
  if (configDefault) return { model: configDefault, source: "config-default" };

  const parent = nonEmpty(input.parentModel);
  if (parent) return { model: parent, source: "parent" };

  return { model: null, source: "none" };
}

/** Render a Pi `ctx.model` as the `provider/id` string the CLI expects. */
export function formatParentModel(
  model: { provider?: string; id?: string } | null | undefined,
): string | null {
  if (!model) return null;
  const provider = nonEmpty(model.provider);
  const id = nonEmpty(model.id);
  if (provider && id) return `${provider}/${id}`;
  return id ?? provider ?? null;
}
