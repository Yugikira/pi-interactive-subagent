/**
 * The runner registry: the single place that maps a CLI name or alias to its
 * adapter. Callers never switch on a runner id.
 */
import {
  RUNNER_KINDS,
  RUNNER_ALIASES,
  normalizeRunner,
  isKnownRunner,
  type CanonicalRunner,
} from "../runner-kinds.ts";
import { agyAdapter } from "./agy.ts";
import { claudeAdapter } from "./claude.ts";
import { piAdapter } from "./pi.ts";
import { createProtocolAdapter } from "./protocol.ts";
import type { RunnerAdapter } from "./types.ts";

export { RUNNER_KINDS, RUNNER_ALIASES, normalizeRunner, isKnownRunner, type CanonicalRunner };

const codexAdapter = createProtocolAdapter({
  id: "codex",
  label: "OpenAI Codex",
  aliases: ["openai-codex"],
});
const grokAdapter = createProtocolAdapter({
  id: "grok",
  label: "Grok",
  aliases: ["grok-cli"],
});
const opencodeAdapter = createProtocolAdapter({
  id: "opencode",
  label: "OpenCode",
  aliases: ["open-code", "open_code"],
});

const ADAPTERS: readonly RunnerAdapter[] = [
  piAdapter,
  agyAdapter,
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  opencodeAdapter,
];

const BY_ID = new Map<CanonicalRunner, RunnerAdapter>(
  ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

/** Resolve a runner id or alias to its adapter; undefined for unknown names. */
export function getRunner(input?: string | null): RunnerAdapter | undefined {
  const id = normalizeRunner(input);
  return id ? BY_ID.get(id) : undefined;
}

/** Resolve a runner, falling back to Pi for unset/unknown input. */
export function getRunnerOrDefault(input?: string | null): RunnerAdapter {
  return getRunner(input) ?? piAdapter;
}

export function listRunners(): readonly RunnerAdapter[] {
  return ADAPTERS;
}

/** Whether this runner reads a native transcript (agy/claude/pi). */
export function isNativeSessionRunner(input?: string | null): boolean {
  return getRunner(input)?.resultMode === "native";
}

/** Derived compatibility set for callers/tests that still use it. */
export const NATIVE_SESSION_RUNNERS: ReadonlySet<string> = new Set(
  ADAPTERS.filter((adapter) => adapter.resultMode === "native").map((adapter) => adapter.id),
);

/**
 * Human-readable list for the `cli` tool-schema description. Generated so a
 * new adapter is automatically advertised.
 */
export function describeRunnerChoices(): string {
  const entries = ADAPTERS.map((adapter) => {
    const aliases = adapter.aliases.length > 0 ? ` (${adapter.aliases.join(", ")})` : "";
    return `'${adapter.id}'${aliases}`;
  });
  return `The coding agent CLI runner to execute: ${entries.join(", ")}. The default is 'pi'.`;
}
