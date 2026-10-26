/**
 * One validated `config.json` for the extension.
 *
 * The file historically held only the status widget settings. It now also
 * holds model defaults, so both sections share one strict parser and one
 * file-resolution rule:
 *
 *   `PI_SUBAGENT_CONFIG` → package-root `config.json` → `config.json.example`
 *
 * Loading is lazy (`getSubagentConfig`) so importing the extension does no
 * disk I/O and a broken config cannot crash module evaluation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelConfig, type ModelConfig } from "./model-config.ts";

export const DEFAULT_STATUS_LINE_LIMIT = 4;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
}

export interface SubagentConfig {
  status: StatusConfig;
  models: ModelConfig;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

/** Parse the `status` section. `lineLimit` is optional and must be a positive integer. */
export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled", "lineLimit"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  let lineLimit = DEFAULT_STATUS_LINE_LIMIT;
  if (status.lineLimit != null) {
    if (
      typeof status.lineLimit !== "number" ||
      !Number.isInteger(status.lineLimit) ||
      status.lineLimit < 1
    ) {
      invalidStatusConfig(source, "status.lineLimit must be a positive integer");
    }
    lineLimit = status.lineLimit;
  }

  return { enabled, lineLimit };
}

/** Parse a complete config file: `status` is required, `models` is optional. */
export function parseSubagentConfig(rawConfig: unknown, source = "config.json"): SubagentConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = parseStatusConfig(config, source);
  const models =
    config.models == null
      ? { agents: {} }
      : parseModelConfig(config.models, source);
  return { status, models };
}

function readConfigFile(
  configPath: string,
  examplePath: string,
): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

function parseConfigJson(rawConfig: string, sourcePath: string): unknown {
  try {
    return JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }
}

/** Resolve the config path, honoring `PI_SUBAGENT_CONFIG`. */
export function resolveConfigPaths(
  configPath?: string,
  examplePath = CONFIG_EXAMPLE_PATH,
): { configPath: string; examplePath: string } {
  return {
    configPath: configPath ?? process.env.PI_SUBAGENT_CONFIG ?? DEFAULT_CONFIG_PATH,
    examplePath,
  };
}

/** Load only the status section (kept for existing callers/tests). */
export function loadStatusConfig(
  configPath?: string,
  examplePath?: string,
): StatusConfig {
  const paths = resolveConfigPaths(configPath, examplePath);
  const { sourcePath, rawConfig } = readConfigFile(paths.configPath, paths.examplePath);
  return parseStatusConfig(parseConfigJson(rawConfig, sourcePath), sourcePath);
}

/** Load and validate the complete config. */
export function loadSubagentConfig(
  configPath?: string,
  examplePath?: string,
): SubagentConfig {
  const paths = resolveConfigPaths(configPath, examplePath);
  const { sourcePath, rawConfig } = readConfigFile(paths.configPath, paths.examplePath);
  return parseSubagentConfig(parseConfigJson(rawConfig, sourcePath), sourcePath);
}

let cachedConfig: SubagentConfig | null = null;

/** Lazily load and cache the config for this process. */
export function getSubagentConfig(): SubagentConfig {
  cachedConfig ??= loadSubagentConfig();
  return cachedConfig;
}

/** Drop the cached config (tests / `/reload`). */
export function resetSubagentConfigCache(): void {
  cachedConfig = null;
}
