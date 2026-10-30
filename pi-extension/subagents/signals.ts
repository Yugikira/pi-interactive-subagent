/**
 * Cross-process signals shared by the parent extension (`index.ts`) and the
 * child extension (`subagent-done.ts`).
 *
 * Every file here is written by one process and consumed by another, often
 * while the writer is still running. Two rules keep that safe:
 *
 *   1. Writes are atomic: write a unique temp file in the same directory, then
 *      rename it over the destination. A reader therefore sees either the old
 *      complete payload or the new complete payload, never a partial one.
 *   2. Reads validate before consuming. A malformed payload left by an
 *      interrupted write is retried on the next poll instead of being deleted
 *      and lost. Only a payload that stays malformed past a bounded age is
 *      reaped, so a poison file cannot wedge the watcher forever.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── Payload types ───────────────────────────────────────────────────────────

/** Structural completion result, kept here to avoid a signals ↔ completion cycle. */
export interface SignalResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

/** `${sessionFile}.exit` — written when a turn errors (auto-exit or parked). */
export interface ExitSignal {
  /** Optional: legacy/unknown payload shapes are normalized to a clean done. */
  type?: "done" | "error";
  errorMessage?: string;
  stopReason?: "error";
  /** Freshness bound: signals written before the current turn are stale. */
  writtenAt?: number;
}

/** `${sessionFile}.parked` — genuine turn end in a kept-open Pi session. */
export interface ParkedSignal {
  parkedAt: number;
  name?: string;
  agent?: string;
}

/** `${sessionFile}.ask` — an `ask_question` waiting for an orchestrator reply. */
export interface AskSignal {
  name?: string;
  agent?: string;
  question: string;
  writtenAt?: number;
}

/** Snapshot written next to a session so resume can replay the sandbox. */
export interface SubagentLoadout {
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null to use the session default. */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /**
   * Runner-native session reference: the Pi session header id, the Claude
   * transcript UUID, or the Agy conversation id. Kept for display/lineage and
   * used by `subagent_message` to resume the session.
   */
  sessionId: string | null;
  /** Runner that produced the session (absent on legacy entries = pi). */
  runner?: string;
  /**
   * Last pane this subagent ran in. A completed keepOpen subagent stays
   * discoverable by name so `subagent_stop` can close its leftover pane even
   * after the in-memory running entry is gone (absent on legacy entries).
   */
  surface?: string;
  /** Herdr agent name for the pane above (absent on legacy entries). */
  herdrAgentName?: string;
  /** Working directory the runner was launched in (needed by native readers on resume). */
  cwd?: string;
  /**
   * Non-Pi only: the exact argv passed after `herdr agent start ... --`. This
   * replays the model, permissions, and system-prompt-file flags on resume.
   * Never stored for Pi (its argv contains task text).
   */
  launchArgs?: string[];
}

export type NameRegistry = Record<string, NameRegistryEntry>;

// ── Paths ───────────────────────────────────────────────────────────────────

export function exitSignalPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

export function parkedSignalPath(sessionFile: string): string {
  return `${sessionFile}.parked`;
}

export function askSignalPath(sessionFile: string): string {
  return `${sessionFile}.ask`;
}

export function loadoutPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

// ── Atomic writes ───────────────────────────────────────────────────────────

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Rename with a short retry loop. On Windows `renameSync` can transiently fail
 * with EPERM/EBUSY when another process (antivirus, indexer, reader) holds the
 * destination open. Removing the destination first is safe here: readers treat
 * a missing file as "no signal yet" and retry on the next tick.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 2 || !RENAME_RETRY_CODES.has(code)) throw error;
      try {
        rmSync(to, { force: true });
      } catch {
        // Destination cleanup is best effort; retry the rename regardless.
      }
    }
  }
}

/** Write JSON atomically (temp file + rename) so no reader sees a partial payload. */
export function writeJsonAtomic(path: string, payload: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, "utf8");
    renameWithRetry(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Read and validate a JSON file without consuming it. */
export function readJsonFile<T>(
  path: string,
  validate: (value: unknown) => T | null,
): T | null {
  try {
    if (!existsSync(path)) return null;
    return validate(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function fileAgeMs(path: string, now: number): number {
  try {
    return Math.max(0, now - statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * Read, validate, then delete a one-shot signal.
 *
 * Returns null when the file is absent, unreadable, or (still) malformed. A
 * malformed file is left in place so a concurrent writer can finish; once it
 * is older than `maxInvalidAgeMs` it is reaped and dropped. This is the
 * difference between a partial write being retried and being lost forever.
 */
export function consumeJson<T>(
  path: string,
  validate: (value: unknown) => T | null,
  options?: { maxInvalidAgeMs?: number; now?: number },
): T | null {
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let value: T | null = null;
  try {
    value = validate(JSON.parse(raw));
  } catch {
    value = null;
  }

  if (value === null) {
    const now = options?.now ?? Date.now();
    const maxAge = options?.maxInvalidAgeMs ?? 30_000;
    if (fileAgeMs(path, now) >= maxAge) {
      rmSync(path, { force: true });
    }
    return null;
  }

  rmSync(path, { force: true });
  return value;
}

// ── Exit / parked / ask codecs ──────────────────────────────────────────────

/** Interpret an `.exit` payload. Unknown shapes are treated as a clean done. */
export function interpretExitSignal(data: unknown): SignalResult {
  const payload = (data ?? {}) as Partial<ExitSignal>;
  if (payload.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim() !== ""
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

function validateExit(value: unknown): ExitSignal | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    // Legacy/unknown shapes still mean "the turn ended"; keep the old tolerant
    // behavior by normalizing them to `{}` (interpreted as done).
    return {};
  }
  return value as ExitSignal;
}

function validateParked(value: unknown): ParkedSignal | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<ParkedSignal>;
  if (typeof payload.parkedAt !== "number" || !Number.isFinite(payload.parkedAt)) return null;
  return payload as ParkedSignal;
}

function validateAsk(value: unknown): AskSignal | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<AskSignal>;
  if (typeof payload.question !== "string" || payload.question.trim() === "") return null;
  return payload as AskSignal;
}

/** Whether a one-shot signal belongs to the current turn. */
export function isFreshSignal(at: number, turnStartTime: number): boolean {
  return at >= turnStartTime;
}

/** Read-and-consume `.exit`; stale payloads from an earlier turn are dropped. */
export function consumeExitSignal(
  sessionFile: string,
  turnStartTime: number,
  now = Date.now(),
): SignalResult | null {
  const signal = consumeJson(exitSignalPath(sessionFile), validateExit, { now });
  if (!signal) return null;
  // Legacy payloads without `writtenAt` stay accepted (pre-freshness behavior).
  if (typeof signal.writtenAt === "number" && !isFreshSignal(signal.writtenAt, turnStartTime)) {
    return null;
  }
  return interpretExitSignal(signal);
}

/** Read-and-consume `.parked`; stale payloads from an earlier turn are dropped. */
export function consumeParkedSignal(
  sessionFile: string,
  turnStartTime: number,
  now = Date.now(),
): SignalResult | null {
  const signal = consumeJson(parkedSignalPath(sessionFile), validateParked, { now });
  if (!signal) return null;
  if (!isFreshSignal(signal.parkedAt, turnStartTime)) return null;
  return { reason: "done", exitCode: 0 };
}

/** Read-and-consume `.ask`; the caller is responsible for delivering the reply. */
export function consumeAskSignal(sessionFile: string, now = Date.now()): AskSignal | null {
  return consumeJson(askSignalPath(sessionFile), validateAsk, { now });
}

export function writeExitSignal(
  sessionFile: string,
  info: { errorMessage: string; stopReason: "error" },
): void {
  writeJsonAtomic(exitSignalPath(sessionFile), {
    type: "error",
    errorMessage: info.errorMessage,
    stopReason: info.stopReason,
    writtenAt: Date.now(),
  });
}

/**
 * Write the `.exit` completion sidecar for a successful auto-exit turn. Without
 * it the parent has no completion signal: Herdr may keep the pane after the
 * agent process exits, so neither pane loss nor an idle state can settle it.
 */
export function writeDoneExitSignal(sessionFile: string): void {
  writeJsonAtomic(exitSignalPath(sessionFile), {
    type: "done",
    writtenAt: Date.now(),
  });
}

export function writeParkedSignal(
  sessionFile: string,
  info: { name?: string; agent?: string },
): void {
  writeJsonAtomic(parkedSignalPath(sessionFile), {
    parkedAt: Date.now(),
    name: info.name,
    agent: info.agent,
  });
}

export function writeAskSignal(
  sessionFile: string,
  info: { name?: string; agent?: string; question: string },
): void {
  writeJsonAtomic(askSignalPath(sessionFile), {
    name: info.name,
    agent: info.agent,
    question: info.question,
    writtenAt: Date.now(),
  });
}

// ── Loadout / name registry ─────────────────────────────────────────────────

export function writeLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  writeJsonAtomic(loadoutPath(sessionFile), loadout);
}

export function readLoadout(sessionFile: string): SubagentLoadout | null {
  return readJsonFile(loadoutPath(sessionFile), (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as SubagentLoadout;
  });
}

export function readNameRegistry(artifactDir: string): NameRegistry {
  const registry = readJsonFile(nameRegistryPath(artifactDir), (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as NameRegistry;
  });
  return registry ?? {};
}

export function writeNameRegistry(artifactDir: string, registry: NameRegistry): void {
  writeJsonAtomic(nameRegistryPath(artifactDir), registry);
}
