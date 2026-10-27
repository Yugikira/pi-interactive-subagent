import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  loadoutPath,
  nameRegistryPath as signalsNameRegistryPath,
  readLoadout,
  readNameRegistry as readNameRegistryFromDisk,
  writeLoadout,
  writeNameRegistry,
  type NameRegistry,
  type NameRegistryEntry,
  type SubagentLoadout,
} from "./signals.ts";

export type { NameRegistry, NameRegistryEntry, SubagentLoadout } from "./signals.ts";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ sessionId })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * same `--no-extensions` + `--tools` restriction, model, identity, spawn
 * whitelist, cwd, and config dir it originally ran with — instead of falling
 * back to pi's default (all global extensions + full toolset). Storing the
 * resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return loadoutPath(sessionFile);
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeLoadout(sessionFile, loadout);
  } catch {
    // Best-effort: a missing snapshot only means resume will refuse, never that
    // it launches unrestricted.
  }
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  return readLoadout(sessionFile);
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return signalsNameRegistryPath(artifactDir);
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  return readNameRegistryFromDisk(artifactDir);
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  try {
    const registry = readNameRegistry(artifactDir);
    registry[name] = entry;
    writeNameRegistry(artifactDir, registry);
  } catch {
    // Best-effort: a failed registration only means resume-by-name won't find
    // this subagent later; it never breaks the spawn itself.
  }
}

/**
 * Merge fields into an existing registry entry. Used by the monitor/resume
 * paths so they cannot drop fields (notably `launchArgs`) written at spawn.
 * A missing entry is a no-op: it is never created half-populated.
 */
export function updateNameRegistryEntry(
  artifactDir: string,
  name: string,
  patch: Partial<NameRegistryEntry>,
): void {
  try {
    const registry = readNameRegistry(artifactDir);
    const existing = registry[name];
    if (!existing) return;
    registry[name] = { ...existing, ...patch };
    writeNameRegistry(artifactDir, registry);
  } catch {
    // Best-effort: a failed update only loses resume metadata.
  }
}

/** Resolve a name to its registry entry within a spawner session, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap — this
 * is what makes scanning a large session tree fast enough to avoid blocking the
 * event loop. Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session id (or id prefix) to a session file path by scanning every
 * `*.jsonl` under `sessionsRoot` and matching the header `id`. Mirrors pi's own
 * resolution order: exact match first, then prefix match. Most recently
 * modified file wins on ties. Returns null when nothing matches.
 */
/**
 * In-process index of session id → session file, per sessions root.
 *
 * Resolving a session id naively walks every `.jsonl` under the sessions tree
 * and reads each header. With a few thousand sessions that is thousands of
 * synchronous open/read/stat syscalls — on the extension host's single thread
 * that blocks the entire terminal UI for many seconds (measured ~67s on a
 * 2010-file tree). To avoid that, we build the index once per root and cache
 * it; subsequent lookups are O(1). The cache is validated cheaply (a directory
 * listing plus statSync-only mtime checks) on every call, so new sessions are
 * picked up without re-reading unchanged headers and without ever freezing the
 * UI again.
 */
interface SessionIndex {
  idToFile: Map<string, { path: string; mtime: number }>;
  /** file path → mtime when indexed (staleness detection). */
  files: Map<string, number>;
  /** top-level dir signature used to detect newly added cwd dirs. */
  topSig: string;
}
const sessionIndexCache = new Map<string, SessionIndex>();

function topLevelSignature(root: string): string {
  const parts: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      let m = 0;
      try {
        m = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      parts.push(`d:${e.name}:${m}`);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      parts.push(`f:${e.name}`);
    }
  }
  parts.sort();
  return parts.join("|");
}

/** Recursively index new/changed .jsonl files under dir into idx. */
function indexDir(dir: string, idx: SessionIndex): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      indexDir(full, idx);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const known = idx.files.get(full);
      if (known !== undefined && known === mtime) continue; // unchanged
      const id = readHeaderId(full); // only read headers for new/changed files
      idx.files.set(full, mtime);
      if (!id) continue;
      const prev = idx.idToFile.get(id);
      if (!prev || mtime >= prev.mtime) {
        idx.idToFile.set(id, { path: full, mtime });
      }
    }
  }
}

function getSessionIndex(sessionsRoot: string): SessionIndex {
  let idx = sessionIndexCache.get(sessionsRoot);
  const sig = topLevelSignature(sessionsRoot);
  if (!idx) {
    idx = { idToFile: new Map(), files: new Map(), topSig: sig };
    sessionIndexCache.set(sessionsRoot, idx);
    indexDir(sessionsRoot, idx); // first build: full scan, once per process
  } else if (idx.topSig !== sig) {
    idx.topSig = sig;
    indexDir(sessionsRoot, idx); // a cwd dir was added/changed: incremental rescan
  } else {
    indexDir(sessionsRoot, idx); // cheap: stats files, reads only new/changed headers
  }
  return idx;
}

export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

function lookupSessionIndex(
  idx: { idToFile: Map<string, { path: string; mtime: number }> },
  sessionId: string,
): string | null {
  // Exact match first.
  const exact = idx.idToFile.get(sessionId);
  if (exact && existsSync(exact.path)) return exact.path;

  // Prefix match: most recently modified wins (ids are unique in practice, so
  // this is only a convenience for hand-typed short prefixes).
  let best: { path: string; mtime: number } | null = null;
  for (const [id, rec] of idx.idToFile) {
    if (!id.startsWith(sessionId)) continue;
    if (!existsSync(rec.path)) continue;
    if (!best || rec.mtime > best.mtime) best = rec;
  }
  return best ? best.path : null;
}

/**
 * Async variant used by the interactive resume path. Index building/refresh is
 * synchronous I/O, which can take many seconds on a cold OS page cache with a
 * few thousand sessions; running it synchronously would block the extension
 * host's single thread and freeze the terminal UI. Deferring to a macrotask
 * keeps the event loop responsive. The heavy work only happens on the first
 * resolution per process (and incrementally thereafter); warm lookups are ~50ms.
 */
export async function resolveSessionFileByIdAsync(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  // Let the event loop breathe (and the UI repaint) before the sync scan.
  await new Promise<void>((r) => setImmediate(r));
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

/** Test hook: drop the cached session index so tests start clean. */
export function resetSessionIndexCache(): void {
  sessionIndexCache.clear();
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
/**
 * Count the number of entry lines in a session file without parsing each line
 * into an object. Used by the resume path, which only needs the *count* of
 * pre-existing entries (so it can later slice out the new ones). Parsing every
 * line of a large resumed transcript synchronously at resume time would block
 * the UI; counting newlines is dramatically cheaper.
 */
export function countSessionEntryLines(sessionFile: string): number {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    // Count non-blank lines, mirroring getNewEntries' `.filter(line => line.trim())`
    // but skipping the per-line JSON.parse that makes resume slow on big files.
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Returns null if the file can't be read.
 */
export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  return stats;
}

export interface SubagentTurnRecord {
  turn?: number;
  timestamp?: number | string;
  content?: string;
  summary?: string;
  text?: string;
  exitCode?: number;
  [key: string]: unknown;
}

/**
 * Return the path to a subagent's turn record JSONL file under the project's temp directory.
 */
export function getSubagentRecordPath(projectCwd: string, agentName: string): string {
  return join(projectCwd, ".pi", "temp", "subagent-records", `${agentName}.jsonl`);
}

/**
 * Read the last valid turn record from a JSONL file, optionally filtering for records
 * created at or after `afterTimestamp`.
 *
 * Reads lines, parses from the bottom to find the last valid JSON entry with non-empty content.
 */
export function readLastSessionRecord(
  recordPath: string,
  afterTimestamp?: number,
): string | null {
  if (!recordPath || !existsSync(recordPath)) return null;

  try {
    const raw = readFileSync(recordPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const record = JSON.parse(lines[i]) as SubagentTurnRecord;
        if (!record || typeof record !== "object") continue;

        if (afterTimestamp !== undefined && record.timestamp !== undefined) {
          const t =
            typeof record.timestamp === "number"
              ? record.timestamp
              : Date.parse(record.timestamp);
          if (!isNaN(t) && t < afterTimestamp) {
            continue;
          }
        }

        const text = record.content ?? record.summary ?? record.text;
        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return null;
  }

  return null;
}

// ── Native Session Readers (Clean Transcripts) ──────────────────────────────

export const NATIVE_SESSION_RUNNERS = new Set<string>(["pi", "agy", "claude"]);

/**
 * Returns true if the runner has native session transcript extraction support,
 * which means prompts should NOT be decorated with artificial [Output Protocol].
 */
export function isNativeSessionRunner(runner?: string): boolean {
  return typeof runner === "string" && NATIVE_SESSION_RUNNERS.has(runner.toLowerCase());
}

/**
 * Read the last assistant message from a native Pi session JSONL transcript.
 */
export function readPiSession(sessionFile: string, afterLine = 0): string | null {
  if (!sessionFile || !existsSync(sessionFile)) return null;
  try {
    const entries = getNewEntries(sessionFile, afterLine);
    return findLastAssistantMessage(entries);
  } catch {
    return null;
  }
}

export interface ReadAgySessionOptions {
  conversationId?: string;
  cwd?: string;
  afterTimestamp?: number;
  brainDir?: string;
}

/**
 * Read the last assistant response from agy (Antigravity CLI) native transcript.
 * Checks ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
 * (falling back to transcript.jsonl).
 */
export function readAgySession(options: ReadAgySessionOptions): string | null {
  const baseBrainDir =
    options.brainDir ?? join(homedir(), ".gemini", "antigravity-cli", "brain");
  if (!existsSync(baseBrainDir)) return null;

  let sessionFolder: string | null = null;
  if (options.conversationId) {
    const candidate = join(baseBrainDir, options.conversationId);
    if (existsSync(candidate)) {
      sessionFolder = candidate;
    }
  }

  if (!sessionFolder) {
    // Scan brain directory for the conversation folder containing the newest transcript file
    try {
      const entries = readdirSync(baseBrainDir, { withFileTypes: true });
      let newestTime = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateFolder = join(baseBrainDir, entry.name);
        const fullTranscript = join(candidateFolder, ".system_generated", "logs", "transcript_full.jsonl");
        const compactTranscript = join(candidateFolder, ".system_generated", "logs", "transcript.jsonl");
        const candidateFile = existsSync(fullTranscript)
          ? fullTranscript
          : existsSync(compactTranscript)
            ? compactTranscript
            : null;

        const checkTarget = candidateFile ?? candidateFolder;
        try {
          const stats = statSync(checkTarget);
          if (options.afterTimestamp !== undefined && stats.mtimeMs < options.afterTimestamp - 5000) {
            continue;
          }
          if (stats.mtimeMs > newestTime) {
            newestTime = stats.mtimeMs;
            sessionFolder = candidateFolder;
          }
        } catch {
          // ignore unreadable dirs
        }
      }
    } catch {
      return null;
    }
  }

  if (!sessionFolder) return null;

  // Look for transcript_full.jsonl first, then transcript.jsonl
  const fullTranscript = join(sessionFolder, ".system_generated", "logs", "transcript_full.jsonl");
  const compactTranscript = join(sessionFolder, ".system_generated", "logs", "transcript.jsonl");
  const transcriptFile = existsSync(fullTranscript)
    ? fullTranscript
    : existsSync(compactTranscript)
      ? compactTranscript
      : null;

  if (!transcriptFile) return null;

  try {
    const raw = readFileSync(transcriptFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (!item || typeof item !== "object") continue;

        if (options.afterTimestamp !== undefined && item.created_at) {
          const t = Date.parse(item.created_at);
          if (!isNaN(t) && t < options.afterTimestamp) {
            continue;
          }
        }

        // Check if model planner response or assistant response
        if (
          (item.source === "MODEL" || item.type === "PLANNER_RESPONSE") &&
          typeof item.content === "string" &&
          item.content.trim()
        ) {
          if (item.status === "ERROR") {
            return `Subagent error: ${item.content.trim()}`;
          }
          return item.content.trim();
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return null;
  }

  return null;
}

export interface ReadClaudeSessionOptions {
  sessionId?: string;
  cwd?: string;
  sentinelFile?: string;
  afterTimestamp?: number;
  projectsDir?: string;
}

/**
 * Normalizes a directory path into Claude Code's project slug convention.
 * e.g. "D:\claude\pi-extensions" -> "D--claude-pi-extensions"
 * e.g. "/Users/user/project" -> "-Users-user-project"
 */
export function toClaudeProjectSlug(dirPath: string): string {
  return dirPath
    .replace(/^([a-zA-Z]):[\\/]/, "$1--") // Windows drive letter "C:\" -> "C--"
    .replace(/[\\/]/g, "-");
}

function findNewestClaudeJsonl(
  dir: string,
  targetSessionId?: string,
  afterTimestamp?: number,
): string | null {
  try {
    const files = readdirSync(dir, { withFileTypes: true });
    let bestFile: string | null = null;
    let newestTime = 0;

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      if (targetSessionId && !f.name.includes(targetSessionId)) continue;
      const full = join(dir, f.name);
      try {
        const stats = statSync(full);
        if (afterTimestamp !== undefined && stats.mtimeMs < afterTimestamp - 5000) {
          continue;
        }
        if (stats.mtimeMs > newestTime) {
          newestTime = stats.mtimeMs;
          bestFile = full;
        }
      } catch {}
    }
    return bestFile;
  } catch {
    return null;
  }
}

/**
 * Parse assistant response from a Claude Code JSONL transcript.
 */
export function parseClaudeTranscriptFile(
  filePath: string,
  afterTimestamp?: number,
): string | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (!item || typeof item !== "object") continue;

        if (afterTimestamp !== undefined && item.timestamp) {
          const t = Date.parse(item.timestamp);
          if (!isNaN(t) && t < afterTimestamp) {
            continue;
          }
        }

        if (item.type === "assistant" && item.message?.content) {
          const content = item.message.content;
          if (Array.isArray(content)) {
            const texts = content
              .filter(
                (b: any) =>
                  b.type === "text" && typeof b.text === "string" && b.text.trim() !== "",
              )
              .map((b: any) => b.text as string);
            if (texts.length > 0 && texts.join("").trim()) {
              return texts.join("\n").trim();
            }
          } else if (typeof content === "string" && content.trim()) {
            return content.trim();
          }
        }
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Read the last assistant message from Claude Code native storage or sentinel file.
 */
export function readClaudeSession(options: ReadClaudeSessionOptions): string | null {
  // 1. Fast path: check sentinel file if written by Stop hook
  if (options.sentinelFile && existsSync(options.sentinelFile)) {
    try {
      const content = readFileSync(options.sentinelFile, "utf8").trim();
      if (content) return content;
    } catch {}
  }

  // 2. Transcript check from sentinel .transcript file
  if (options.sentinelFile) {
    const transcriptRef = `${options.sentinelFile}.transcript`;
    if (existsSync(transcriptRef)) {
      try {
        const p = readFileSync(transcriptRef, "utf8").trim();
        if (p && existsSync(p)) {
          const res = parseClaudeTranscriptFile(p, options.afterTimestamp);
          if (res) return res;
        }
      } catch {}
    }
  }

  // 3. Scan Claude projects directory (~/.claude/projects/)
  const baseProjectsDir = options.projectsDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(baseProjectsDir)) return null;

  let sessionFile: string | null = null;

  if (options.cwd) {
    const expectedSlug = toClaudeProjectSlug(options.cwd);
    const candidateDir = join(baseProjectsDir, expectedSlug);
    if (existsSync(candidateDir)) {
      sessionFile = findNewestClaudeJsonl(candidateDir, options.sessionId, options.afterTimestamp);
    }
  }

  if (!sessionFile) {
    // If exact slug didn't match, scan project subdirectories
    try {
      const dirs = readdirSync(baseProjectsDir, { withFileTypes: true });
      let newestTime = 0;
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const sub = join(baseProjectsDir, d.name);
        const f = findNewestClaudeJsonl(sub, options.sessionId, options.afterTimestamp);
        if (f) {
          try {
            const m = statSync(f).mtimeMs;
            if (m > newestTime) {
              newestTime = m;
              sessionFile = f;
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (!sessionFile || !existsSync(sessionFile)) return null;
  return parseClaudeTranscriptFile(sessionFile, options.afterTimestamp);
}

export interface ReadRunnerSessionOptions {
  runner: string;
  cwd?: string;
  agentName?: string;
  sessionId?: string;
  sessionFile?: string;
  sentinelFile?: string;
  afterTimestamp?: number;
  afterLine?: number;
  brainDir?: string;
  projectsDir?: string;
}

/**
 * Unified native session reader dispatcher for supported runners.
 */
export function readRunnerSession(options: ReadRunnerSessionOptions): string | null {
  const runner = options.runner.toLowerCase();
  switch (runner) {
    case "pi":
      return options.sessionFile ? readPiSession(options.sessionFile, options.afterLine) : null;
    case "agy":
      return readAgySession({
        conversationId: options.sessionId,
        cwd: options.cwd,
        afterTimestamp: options.afterTimestamp,
        brainDir: options.brainDir,
      });
    case "claude":
      return readClaudeSession({
        sessionId: options.sessionId,
        cwd: options.cwd,
        sentinelFile: options.sentinelFile,
        afterTimestamp: options.afterTimestamp,
        projectsDir: options.projectsDir,
      });
    default:
      return null;
  }
}

export interface GetNativeSessionFileOptions {
  runner: string;
  sessionId?: string;
  cwd?: string;
  brainDir?: string;
  projectsDir?: string;
}

/**
 * Resolves the active transcript / session file path for a native session runner (agy, claude).
 * Returns null if not found or runner is not native.
 */
export function getNativeSessionFile(options: GetNativeSessionFileOptions): string | null {
  const runner = options.runner.toLowerCase();

  if (runner === "agy") {
    const baseBrainDir =
      options.brainDir ?? join(homedir(), ".gemini", "antigravity-cli", "brain");
    if (!existsSync(baseBrainDir)) return null;

    let sessionFolder: string | null = null;
    if (options.sessionId) {
      const candidate = join(baseBrainDir, options.sessionId);
      if (existsSync(candidate)) {
        sessionFolder = candidate;
      }
    }

    if (!sessionFolder) {
      try {
        const entries = readdirSync(baseBrainDir, { withFileTypes: true });
        let newestTime = 0;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidateFolder = join(baseBrainDir, entry.name);
          try {
            const stats = statSync(candidateFolder);
            if (stats.mtimeMs > newestTime) {
              newestTime = stats.mtimeMs;
              sessionFolder = candidateFolder;
            }
          } catch {}
        }
      } catch {
        return null;
      }
    }

    if (!sessionFolder) return null;

    const fullTranscript = join(sessionFolder, ".system_generated", "logs", "transcript_full.jsonl");
    const compactTranscript = join(sessionFolder, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(fullTranscript)) return fullTranscript;
    if (existsSync(compactTranscript)) return compactTranscript;
    return null;
  }

  if (runner === "claude") {
    const baseProjectsDir =
      options.projectsDir ?? join(homedir(), ".claude", "projects");
    if (!existsSync(baseProjectsDir)) return null;

    if (options.cwd) {
      const expectedSlug = toClaudeProjectSlug(options.cwd);
      const candidateDir = join(baseProjectsDir, expectedSlug);
      if (existsSync(candidateDir)) {
        if (options.sessionId) {
          const direct = join(candidateDir, `${options.sessionId}.jsonl`);
          if (existsSync(direct)) return direct;
        }
        const newest = findNewestClaudeJsonl(candidateDir, options.sessionId);
        if (newest) return newest;
      }
    }

    try {
      const dirs = readdirSync(baseProjectsDir, { withFileTypes: true });
      let newestTime = 0;
      let bestFile: string | null = null;
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const sub = join(baseProjectsDir, d.name);
        const f = findNewestClaudeJsonl(sub, options.sessionId);
        if (f) {
          try {
            const m = statSync(f).mtimeMs;
            if (m > newestTime) {
              newestTime = m;
              bestFile = f;
            }
          } catch {}
        }
      }
      return bestFile;
    } catch {
      return null;
    }
  }

  return null;
}

