/**
 * Herdr surface layer — terminal multiplexer integration for coding agents.
 *
 * Supports Herdr on Windows and POSIX, exposing primitives for:
 * - Pane lifecycle: split (sibling), run, read, close
 * - Agent lifecycle: start, prompt, get, wait, read, send-keys
 * - Multi-runner normalization: pi, agy, claude, codex, grok, opencode
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getNativeSessionFile } from "./session.ts";
import { shellEscape } from "./shell.ts";
import type { CanonicalRunner } from "./runner-kinds.ts";
import {
  consumeExitSignal,
  consumeParkedSignal,
  interpretExitSignal,
  isFreshSignal,
} from "./signals.ts";

const execFileAsync = promisify(execFile);

const HERDR_BIN = process.platform === "win32" ? "herdr.exe" : "herdr";

// ── Injectable Execution Seam ──

export interface HerdrExecDeps {
  /** Whether the herdr CLI is usable in this process. */
  available(): boolean;
  /** Run herdr synchronously; throws on non-zero exit (herdr's error JSON is in the message). */
  run(args: string[], options?: { timeoutMs?: number }): string;
  /** Async variant used by launch/monitor paths; falls back to execFile. */
  runAsync?(args: string[], options?: { timeoutMs?: number }): Promise<string>;
}

const defaultHerdrDeps: HerdrExecDeps = {
  available: () => process.env.HERDR_ENV === "1" && hasCommand("herdr"),
  run: (args, options) =>
    execFileSync(HERDR_BIN, args, {
      encoding: "utf8",
      timeout: options?.timeoutMs ?? 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  runAsync: async (args, options) => {
    const { stdout } = await execFileAsync(HERDR_BIN, args, {
      encoding: "utf8",
      timeout: options?.timeoutMs ?? 60_000,
    });
    return stdout;
  },
};

let herdrDeps: HerdrExecDeps = defaultHerdrDeps;

/**
 * Override the execution seam (tests run against a fake herdr through this).
 * Returns a restore function.
 */
export function setHerdrExecDeps(next: Partial<HerdrExecDeps>): () => void {
  const previous = herdrDeps;
  herdrDeps = { ...herdrDeps, ...next };
  return () => {
    herdrDeps = previous;
  };
}

// ── Diagnostics ──

export type HerdrLogFn = (message: string) => void;

let herdrLogSink: HerdrLogFn | null = null;

/**
 * Install a diagnostics sink (the host wires this to a file when
 * `PI_SUBAGENT_DEBUG=1`). Termination decisions are otherwise invisible:
 * every failure used to be swallowed, which is what made "the pane is still
 * open" indistinguishable from a clean stop.
 */
export function setHerdrLogSink(fn: HerdrLogFn | null): void {
  herdrLogSink = fn;
}

export function logHerdr(message: string): void {
  if (!herdrLogSink) return;
  try {
    herdrLogSink(message);
  } catch {
    // Diagnostics must never break a stop.
  }
}

// ── Runner Kinds & Normalization ──
// The taxonomy is a leaf module; re-exported here for the existing public API.
export {
  RUNNER_KINDS,
  RUNNER_ALIASES,
  normalizeRunner,
  isKnownRunner,
  type CanonicalRunner,
} from "./runner-kinds.ts";

// ── Availability ──

const commandAvailability = new Map<string, boolean>();
/**
 * A failed probe is only trusted for this long. A transient `where.exe`/spawn
 * failure must not be cached for the lifetime of a long-running session:
 * `isHerdrAvailable()` gates the stop path, so a permanently cached `false`
 * silently turns every stop into a no-op that still reports success.
 */
const COMMAND_MISS_TTL_MS = 5_000;
const commandMisses = new Map<string, number>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  const missedAt = commandMisses.get(command);
  if (missedAt !== undefined && Date.now() - missedAt < COMMAND_MISS_TTL_MS) {
    return false;
  }

  let available = false;
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    }
    available = true;
  } catch {
    available = false;
  }

  if (available) {
    commandAvailability.set(command, true);
    commandMisses.delete(command);
  } else {
    commandMisses.set(command, Date.now());
  }
  return available;
}

/**
 * True when running inside a Herdr-managed pane with the herdr binary on PATH.
 * `HERDR_ENV=1` is injected by Herdr into every managed pane.
 */
export function isHerdrAvailable(): boolean {
  return herdrDeps.available();
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Subagents require Herdr. Ensure you are running inside a Herdr-managed pane (HERDR_ENV=1) and `herdr` is in PATH.";
}

function requireHerdr(): void {
  if (!herdrDeps.available()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell Helpers ──

export { shellEscape } from "./shell.ts";

/**
 * Herdr agent names must match `^[a-z][a-z0-9_-]{0,31}$` and be unique among live agents.
 */
export function sanitizeAgentName(name: string): string {
  let cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);

  if (!cleaned || !/^[a-z]/.test(cleaned)) {
    cleaned = `sub-${cleaned}`.slice(0, 32);
  }

  if (!/^[a-z]/.test(cleaned)) {
    cleaned = `subagent-${Math.random().toString(36).slice(2, 8)}`;
  }

  return cleaned;
}

// ── Low-level Herdr CLI Execution ──

/** A short, safe label for diagnostics (never includes task text or env). */
function describeHerdrCommand(args: string[]): string {
  return `herdr ${args.slice(0, 3).join(" ")}`;
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/**
 * Prefer the last embedded `{"error":…}` object. The prompt/task text can
 * itself contain `"code"`/`"message"` keys; a plain regex over the whole
 * "Command failed" blob could pick those up instead of Herdr's payload.
 */
function errorPayloadFrom(raw: string): { code: string; message: string } | null {
  const marker = raw.lastIndexOf('{"error"');
  if (marker >= 0) {
    try {
      const data = JSON.parse(raw.slice(marker));
      if (data?.error) {
        return {
          code: data.error.code ?? "error",
          message: data.error.message ?? JSON.stringify(data.error),
        };
      }
    } catch {
      // A truncated payload falls back to the regex parser.
    }
  }
  return parseHerdrError(raw);
}

/**
 * Herdr prints `{"error":{...}}` and exits non-zero for some failures, so the
 * JSON arrives inside the thrown error's stdout rather than as a normal
 * response. Surface the code/message instead of a 1 KB "Command failed" blob.
 */
function asHerdrFailure(error: unknown, args: string[]): Error {
  const context = describeHerdrCommand(args);
  // Check the child's own output first; the generic "Command failed" message
  // repeats stderr and can also contain task text.
  const sources = [
    textFrom((error as any)?.stderr),
    textFrom((error as any)?.stdout),
    textFrom((error as any)?.message),
  ];
  for (const source of sources) {
    if (!source) continue;
    const parsed = errorPayloadFrom(source);
    if (parsed) return new Error(`${context}: ${parsed.code}: ${parsed.message}`);
  }
  return error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
}

function execHerdrSync(args: string[], options?: { timeout?: number }): string {
  requireHerdr();
  const started = Date.now();
  try {
    const raw = herdrDeps.run(args, { timeoutMs: options?.timeout });
    logHerdr(`${describeHerdrCommand(args)} ok ${Date.now() - started}ms`);
    return raw;
  } catch (err) {
    const failure = asHerdrFailure(err, args);
    logHerdr(`${describeHerdrCommand(args)} failed ${Date.now() - started}ms: ${failure.message}`);
    throw failure;
  }
}

async function execHerdrAsync(args: string[], options?: { timeout?: number }): Promise<string> {
  requireHerdr();
  const started = Date.now();
  try {
    const raw = herdrDeps.runAsync
      ? await herdrDeps.runAsync(args, { timeoutMs: options?.timeout })
      : (
          await execFileAsync(HERDR_BIN, args, {
            encoding: "utf8",
            timeout: options?.timeout ?? 60_000,
          })
        ).stdout;
    logHerdr(`${describeHerdrCommand(args)} ok ${Date.now() - started}ms`);
    return raw;
  } catch (err) {
    const failure = asHerdrFailure(err, args);
    logHerdr(`${describeHerdrCommand(args)} failed ${Date.now() - started}ms: ${failure.message}`);
    throw failure;
  }
}

/**
 * Herdr's CLI prints `{"error":{...}}` on API failures but still exits 0.
 * Parsing only on non-zero exit (or not parsing at all) silently treats a
 * failed `agent start` as success. Callers that expect JSON use this helper.
 *
 * Non-JSON output (e.g. `pane read`) returns null rather than throwing.
 */
function parseHerdrResponse<T = any>(raw: string, context: string): T | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let data: any;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (data?.error) {
    const code = data.error.code ?? "error";
    const message = data.error.message ?? JSON.stringify(data.error);
    throw new Error(`${context}: ${code}: ${message}`);
  }
  return data as T;
}

function parseHerdrJson<T = any>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw new Error(`Failed to parse Herdr JSON response: ${err?.message ?? String(err)}: ${raw}`);
  }
}

// ── Surface / Pane Primitives ──

export type SurfaceLayout = "right" | "down" | "tab";

export interface CreateSurfaceOptions {
  direction?: "right" | "down";
  /** `tab` creates a new Herdr tab; right/down split the source pane. */
  layout?: SurfaceLayout;
  cwd?: string;
  env?: Record<string, string>;
  fromSurface?: string;
}

export interface PaneRect {
  paneId: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface TabLayout {
  tabId: string;
  panes: PaneRect[];
}

/** Parse `herdr pane layout` into per-pane rectangles. */
export function parsePaneLayout(raw: string): TabLayout | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const layout = data?.result?.layout;
  const panes = layout?.panes;
  if (!Array.isArray(panes)) return null;
  const parsed: PaneRect[] = [];
  for (const pane of panes) {
    const paneId = pane?.pane_id;
    const rect = pane?.rect;
    if (
      typeof paneId !== "string" ||
      typeof rect?.width !== "number" ||
      typeof rect?.height !== "number"
    ) {
      continue;
    }
    parsed.push({
      paneId,
      width: rect.width,
      height: rect.height,
      x: typeof rect.x === "number" ? rect.x : 0,
      y: typeof rect.y === "number" ? rect.y : 0,
    });
  }
  return {
    tabId: typeof layout?.tab_id === "string" ? layout.tab_id : "",
    panes: parsed,
  };
}

/** Geometry of the tab containing `surface` (or the caller's tab). */
export function getTabLayout(surface?: string | null): TabLayout | null {
  if (!herdrDeps.available()) return null;
  try {
    const args = ["pane", "layout", surface ? "--pane" : "--current"];
    if (surface) args.push(surface);
    return parsePaneLayout(execHerdrSync(args, { timeout: 5_000 }));
  } catch {
    return null;
  }
}

/** Async layout read for the launch path. */
export async function getTabLayoutAsync(surface?: string | null): Promise<TabLayout | null> {
  if (!herdrDeps.available()) return null;
  try {
    const args = ["pane", "layout", surface ? "--pane" : "--current"];
    if (surface) args.push(surface);
    return parsePaneLayout(await execHerdrAsync(args, { timeout: 5_000 }));
  } catch {
    return null;
  }
}

/** The pane this extension is running in, if Herdr exposes it. */
export function currentPaneId(): string | null {
  const fromEnv = process.env.HERDR_PANE_ID;
  if (fromEnv) return fromEnv;
  if (!herdrDeps.available()) return null;
  try {
    const data = parseHerdrJson(execHerdrSync(["pane", "current", "--current"], { timeout: 3_000 }));
    const paneId = data?.result?.pane?.pane_id;
    return typeof paneId === "string" ? paneId : null;
  } catch {
    return null;
  }
}

/**
 * A split is a UI operation on a server that answers other clients serially;
 * 15 s leaves room for a busy Herdr without hanging the extension host forever.
 */
const SURFACE_CREATE_TIMEOUT_MS = 15_000;

function buildTabArgs(options?: CreateSurfaceOptions): string[] {
  const args = ["tab", "create", "--no-focus"];
  if (options?.cwd) args.push("--cwd", options.cwd);
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("--env", `${key}=${value}`);
    }
  }
  return args;
}

function buildSplitArgs(options?: CreateSurfaceOptions): string[] {
  const layout = options?.layout ?? options?.direction ?? "right";
  const direction = layout === "down" ? "down" : "right";
  const args = ["pane", "split"];

  // Anchor to the caller's pane rather than Herdr's "current" pane: closing a
  // subagent shifts keyboard focus, and `--current` would then split an
  // unrelated tab on the next spawn.
  const fromSurface = options?.fromSurface ?? currentPaneId();
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }

  args.push("--direction", direction, "--no-focus");

  if (options?.cwd) {
    args.push("--cwd", options.cwd);
  }

  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      args.push("--env", `${k}=${v}`);
    }
  }
  return args;
}

function parseSplitResponse(raw: string): string {
  const data = parseHerdrResponse(raw, "herdr pane split");
  const paneId = data?.result?.pane?.pane_id ?? data?.pane?.pane_id ?? data?.pane_id;
  if (!data || typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr pane split response: ${raw}`);
  }
  return paneId;
}

function parseTabResponse(raw: string): string {
  const data = parseHerdrResponse(raw, "herdr tab create");
  const root = data?.result?.root_pane;
  const paneId = typeof root?.pane_id === "string" ? root.pane_id : root;
  if (!data || typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr tab create response: ${raw}`);
  }
  return paneId;
}

/** Create a new tab and return its root pane id. */
function createTabSurface(options?: CreateSurfaceOptions): string {
  requireHerdr();
  return parseTabResponse(
    execHerdrSync(buildTabArgs(options), { timeout: SURFACE_CREATE_TIMEOUT_MS }),
  );
}

async function createTabSurfaceAsync(options?: CreateSurfaceOptions): Promise<string> {
  requireHerdr();
  return parseTabResponse(
    await execHerdrAsync(buildTabArgs(options), { timeout: SURFACE_CREATE_TIMEOUT_MS }),
  );
}

/**
 * Create a new sibling pane split for a subagent.
 * Defaults to splitting right off the current pane without stealing keyboard focus.
 * Returns the new pane id (e.g. `w1:p2`).
 */
export function createSurface(name: string, options?: CreateSurfaceOptions): string {
  void name;
  requireHerdr();

  const layout = options?.layout ?? options?.direction ?? "right";
  if (layout === "tab") return createTabSurface(options);

  return parseSplitResponse(
    execHerdrSync(buildSplitArgs(options), { timeout: SURFACE_CREATE_TIMEOUT_MS }),
  );
}

/**
 * Async surface creation for the launch path.
 *
 * The launch flow awaits this, so the TUI stays responsive and a slow/busy
 * Herdr is bounded by an explicit timeout instead of blocking the event loop.
 * `createSurface` remains for synchronous callers (resume fallbacks/tests).
 */
export async function createSurfaceAsync(
  name: string,
  options?: CreateSurfaceOptions,
): Promise<string> {
  void name;
  requireHerdr();

  const layout = options?.layout ?? options?.direction ?? "right";
  if (layout === "tab") return createTabSurfaceAsync(options);

  return parseSplitResponse(
    await execHerdrAsync(buildSplitArgs(options), { timeout: SURFACE_CREATE_TIMEOUT_MS }),
  );
}

/** Backward compatibility alias for createSurface. */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const herdrDir = direction === "down" || direction === "up" ? "down" : "right";
  return createSurface(name, { direction: herdrDir, fromSurface });
}

// ── Pane Inspection (read-only) ──

export interface PaneSummary {
  paneId: string;
  agent?: string;
  agentStatus?: string;
  agentSessionValue?: string;
  cwd?: string;
}

/** Parse a `herdr pane list` payload; null when it is not usable. */
export function parsePaneList(raw: string): PaneSummary[] | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const panes = data?.result?.panes ?? data?.panes;
  if (!Array.isArray(panes)) return null;

  const summaries: PaneSummary[] = [];
  for (const pane of panes) {
    const paneId = pane?.pane_id;
    if (typeof paneId !== "string" || !paneId) continue;
    summaries.push({
      paneId,
      agent: typeof pane?.agent === "string" ? pane.agent : undefined,
      agentStatus: typeof pane?.agent_status === "string" ? pane.agent_status : undefined,
      agentSessionValue:
        typeof pane?.agent_session?.value === "string" ? pane.agent_session.value : undefined,
      cwd: typeof pane?.cwd === "string" ? pane.cwd : undefined,
    });
  }
  return summaries;
}

/** Read the pane inventory, or null when it cannot be read. */
export function listPanes(onError?: (message: string) => void): PaneSummary[] | null {
  if (!herdrDeps.available()) return null;
  try {
    return parsePaneList(execHerdrSync(["pane", "list"], { timeout: 5_000 }));
  } catch (err) {
    onError?.(errorText(err));
    return null;
  }
}

/** Async pane inventory for the 1 Hz monitor; null means "cannot tell". */
export async function listPanesAsync(
  onError?: (message: string) => void,
): Promise<PaneSummary[] | null> {
  if (!herdrDeps.available()) return null;
  try {
    return parsePaneList(await execHerdrAsync(["pane", "list"], { timeout: 5_000 }));
  } catch (err) {
    onError?.(errorText(err));
    return null;
  }
}

/**
 * Tri-state pane existence: true / false / null ("cannot tell").
 *
 * `pane list` is the authoritative inventory. A read failure must never be
 * interpreted as "the pane is gone" — that conflation is what let the previous
 * stop path report success for a pane it had never touched.
 */
export function paneExists(surface: string, onError?: (message: string) => void): boolean | null {
  const panes = listPanes(onError);
  if (!panes) return null;
  return panes.some((pane) => pane.paneId === surface);
}

/** Async tri-state pane existence for the completion/lifecycle path. */
export async function paneExistsAsync(
  surface: string,
  onError?: (message: string) => void,
): Promise<boolean | null> {
  const panes = await listPanesAsync(onError);
  if (!panes) return null;
  return panes.some((pane) => pane.paneId === surface);
}

/** Pull `{"error":{"code":…,"message":…}}` out of a herdr failure message. */
export function parseHerdrError(raw: string): { code: string; message: string } | null {
  const code = raw.match(/"code"\s*:\s*"([^"]+)"/)?.[1];
  const message = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  if (!code && !message) return null;
  return { code: code ?? "unknown", message: message ?? raw.replace(/\s+/g, " ").trim() };
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const parsed = parseHerdrError(raw);
  return parsed ? `${parsed.code}: ${parsed.message}` : raw.replace(/\s+/g, " ").trim();
}

/** Close a pane. Returns true only when the pane is confirmed gone. */
export function closeSurface(surface: string, onError?: (message: string) => void): boolean {
  if (!herdrDeps.available()) return false;

  if (paneExists(surface, onError) === false) return true;

  const closed = tryClosePane(surface, onError);
  const afterFirst = paneExists(surface, onError);
  if (closed && afterFirst !== true) return true;
  if (afterFirst === false) return true;

  // A single transient failure should not leak a pane — retry once.
  const retried = tryClosePane(surface, onError);
  const afterRetry = paneExists(surface, onError);
  if (afterRetry === false) return true;
  return closed && retried && afterRetry === null;
}

function tryClosePane(surface: string, onError?: (message: string) => void): boolean {
  try {
    const raw = execHerdrSync(["pane", "close", surface], { timeout: 5_000 });
    parseHerdrResponse(raw, `herdr pane close ${surface}`);
    return true;
  } catch (err) {
    // Reported rather than swallowed: "the close failed" is exactly the fact
    // that used to be invisible.
    onError?.(errorText(err));
    return false;
  }
}

// ── Termination ──

export type TerminateMethod = "not-alive" | "keys";

/** Honest outcome of a termination attempt — never claims more than was verified. */
export interface TerminateOutcome {
  ok: boolean;
  surface: string;
  paneClosed: boolean;
  method: TerminateMethod;
  reason?: "pane_still_alive" | "unverified";
  /** What the termination actually did. */
  attempted: string[];
  /** herdr errors that used to be swallowed. */
  errors: string[];
}

export interface TerminateSurfaceOptions {
  agentName?: string;
  closePane?: boolean;
}

/**
 * Stop a subagent's process and optionally close its pane.
 *
 * The guarantee added here is narrow and it is the whole bug: an unreadable
 * probe must not become a silent success. `pane list` is the authoritative
 * inventory, and "cannot tell" (null) is never treated as "the pane is gone" —
 * which is how a transient read failure used to skip the exit keys *and* the
 * pane close while still reporting "stopped".
 */
export function terminateSurface(
  surface: string,
  options?: TerminateSurfaceOptions,
): TerminateOutcome {
  const attempted: string[] = [];
  const errors: string[] = [];
  const onError = (message: string) => {
    if (!errors.includes(message)) errors.push(message);
    logHerdr(`  herdr error: ${message}`);
  };
  const base = { surface, attempted, errors };

  logHerdr(`terminate surface=${surface} closePane=${options?.closePane !== false}`);

  const panes = listPanes(onError);
  logHerdr(`  paneList=${panes === null ? "unreadable" : panes.length}`);
  let knownAgent: string | undefined;
  if (panes !== null) {
    const pane = panes.find((candidate) => candidate.paneId === surface);
    // Only a *confirmed* absence short-circuits. "Cannot tell" falls through
    // to the actual stop attempt.
    if (!pane) {
      return { ...base, ok: true, paneClosed: true, method: "not-alive" };
    }
    knownAgent = pane.agent;
  }

  // Address the agent by name only when the pane inventory confirms that agent
  // is actually registered there. Otherwise Herdr logs `agent target not found`
  // for every stop of an agent that died during startup, and the cascade hides
  // the real failure.
  const agentName = options?.agentName;
  const canUseAgent =
    !!agentName && (panes === null || knownAgent === agentName);
  if (canUseAgent && agentName) {
    let agentError: string | null = null;
    try {
      sendAgentKeys(agentName, ["ctrl+c", "ctrl+c"]);
      attempted.push(`agent send-keys ${agentName} ctrl+c ctrl+c`);
    } catch (err) {
      // Held back: if the pane fallback lands, the keys still arrived and this
      // is recoverable noise rather than a failure worth reporting.
      agentError = errorText(err);
    }

    if (agentError !== null) {
      try {
        sendPaneKeys(surface, ["ctrl+c", "ctrl+c"]);
        attempted.push(`pane send-keys ${surface} ctrl+c ctrl+c`);
      } catch (fallbackErr) {
        onError(`${agentError}; ${errorText(fallbackErr)}`);
      }
    }
  } else {
    try {
      sendPaneKeys(surface, ["ctrl+c", "ctrl+c"]);
      attempted.push(`pane send-keys ${surface} ctrl+c ctrl+c`);
    } catch (err) {
      onError(errorText(err));
    }
  }

  if (options?.closePane === false) {
    return { ...base, ok: true, paneClosed: false, method: "keys" };
  }

  // Close the pane, then verify against the inventory rather than trusting
  // that the command "succeeded".
  const closed = closeSurface(surface, onError);
  const after = paneExists(surface, onError);
  logHerdr(`  closeSurface=${closed} paneExistsAfter=${after}`);
  if (after === false) {
    return { ...base, ok: true, paneClosed: true, method: "keys" };
  }
  return {
    ...base,
    ok: false,
    paneClosed: false,
    method: "keys",
    reason: after === true ? "pane_still_alive" : "unverified",
  };
}

let surfaceAliveOverride: ((surface: string) => boolean) | null = null;

/**
 * Check whether a pane surface still exists in Herdr.
 *
 * Only a confirmed absence returns false. A timed-out or unreadable inventory
 * is treated as "still there": `pane read` is slower than the inventory, and
 * treating its failure as death is what orphaned keepOpen panes.
 */
export function isSurfaceAlive(surface: string): boolean {
  if (surfaceAliveOverride) return surfaceAliveOverride(surface);
  return paneExists(surface) !== false;
}

/** Send raw command to run in a pane. */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  const raw = execHerdrSync(["pane", "run", surface, command]);
  parseHerdrResponse(raw, `herdr pane run ${surface}`);
}

/**
 * Send long command by writing to a script file first.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const ext = process.platform === "win32" ? "ps1" : "sh";
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`,
    );

  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts: string[] = [];
  if (process.platform !== "win32") {
    scriptParts.push("#!/bin/bash");
  }
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  if (process.platform === "win32") {
    sendCommand(surface, `& ${shellEscape(scriptPath)}`);
  } else {
    sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  }

  return scriptPath;
}

let readScreenOverride: ((surface: string, lines?: number) => string) | null = null;

/** Read the screen contents of a pane (sync). */
export function readScreen(surface: string, lines = 50): string {
  if (readScreenOverride) return readScreenOverride(surface, lines);
  if (!isHerdrAvailable()) return "";
  try {
    return execHerdrSync([
      "pane",
      "read",
      surface,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(Math.max(1, lines)),
    ]);
  } catch {
    return "";
  }
}

/** Read the screen contents of a pane (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (readScreenOverride) return readScreenOverride(surface, lines);
  if (!isHerdrAvailable()) return "";
  try {
    return await execHerdrAsync([
      "pane",
      "read",
      surface,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(Math.max(1, lines)),
    ]);
  } catch {
    return "";
  }
}

// ── Herdr Agent API ──

export interface StartAgentOptions {
  timeoutMs?: number;
  args?: string[];
}

/**
 * Start a recognized interactive coding agent inside an existing pane.
 * Herdr detects the agent in that pane and waits until it reaches interactive readiness.
 */
export function startAgent(
  name: string,
  kind: CanonicalRunner,
  paneId: string,
  options?: StartAgentOptions,
): void {
  requireHerdr();
  const safeName = sanitizeAgentName(name);
  const args = ["agent", "start", safeName, "--kind", kind, "--pane", paneId];

  if (options?.timeoutMs) {
    args.push("--timeout", String(options.timeoutMs));
  }

  if (options?.args && options.args.length > 0) {
    args.push("--", ...options.args);
  }

  const raw = execHerdrSync(args, { timeout: (options?.timeoutMs ?? 30_000) + 5_000 });
  parseHerdrResponse(raw, `herdr agent start ${safeName}`);
}

/**
 * Async version of startAgent.
 */
export async function startAgentAsync(
  name: string,
  kind: CanonicalRunner,
  paneId: string,
  options?: StartAgentOptions,
): Promise<void> {
  requireHerdr();
  const safeName = sanitizeAgentName(name);
  const args = ["agent", "start", safeName, "--kind", kind, "--pane", paneId];

  if (options?.timeoutMs) {
    args.push("--timeout", String(options.timeoutMs));
  }

  if (options?.args && options.args.length > 0) {
    args.push("--", ...options.args);
  }

  const raw = await execHerdrAsync(args, { timeout: (options?.timeoutMs ?? 30_000) + 5_000 });
  parseHerdrResponse(raw, `herdr agent start ${safeName}`);
}

/**
 * Submit work/prompt to a live agent via Herdr.
 * Uses bracketed paste boundaries and encoded Enter.
 */
export function promptAgent(
  target: string,
  text: string,
  options?: { wait?: boolean; timeoutMs?: number },
): void {
  requireHerdr();
  const args = ["agent", "prompt", target, text];
  if (options?.wait) {
    args.push("--wait");
    if (options?.timeoutMs) {
      args.push("--timeout", String(options.timeoutMs));
    }
  }

  const raw = execHerdrSync(args, { timeout: options?.timeoutMs });
  parseHerdrResponse(raw, `herdr agent prompt ${target}`);
}

/**
 * Async prompt submission.
 */
export async function promptAgentAsync(
  target: string,
  text: string,
  options?: { wait?: boolean; timeoutMs?: number },
): Promise<void> {
  requireHerdr();
  const args = ["agent", "prompt", target, text];
  if (options?.wait) {
    args.push("--wait");
    if (options?.timeoutMs) {
      args.push("--timeout", String(options.timeoutMs));
    }
  }

  const raw = await execHerdrAsync(args, { timeout: options?.timeoutMs });
  parseHerdrResponse(raw, `herdr agent prompt ${target}`);
}

export type HerdrAgentStateKind = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  name: string;
  kind?: string;
  state: HerdrAgentStateKind;
  paneId?: string;
  sessionId?: string;
  raw?: any;
}

let agentStateOverride: ((target: string) => AgentInfo | null) | null = null;

function parseAgentInfo(data: any, target: string): AgentInfo | null {
  const agent = data?.result?.agent ?? data?.agent ?? data?.result;
  if (!agent) return null;
  const rawState = (agent.agent_status ?? agent.state ?? agent.status ?? "unknown") as string;
  const sessionVal =
    agent.agent_session?.value ??
    agent.agent_session_id ??
    agent.agent_session?.id;
  return {
    name: agent.name ?? target,
    kind: agent.agent ?? agent.kind,
    state: rawState as HerdrAgentStateKind,
    paneId: agent.pane_id,
    sessionId: typeof sessionVal === "string" ? sessionVal : undefined,
    raw: agent,
  };
}

/**
 * Inspect the current state of an agent via `herdr agent get <target>`.
 */
export function getAgentState(target: string): AgentInfo | null {
  if (agentStateOverride) return agentStateOverride(target);
  if (!isHerdrAvailable()) return null;
  try {
    const raw = execHerdrSync(["agent", "get", target], { timeout: 3_000 });
    return parseAgentInfo(parseHerdrJson(raw), target);
  } catch {
    return null;
  }
}

/** Async variant used by the 1 Hz monitor; never blocks the extension host. */
export async function getAgentStateAsync(target: string): Promise<AgentInfo | null> {
  if (agentStateOverride) return agentStateOverride(target);
  if (!isHerdrAvailable()) return null;
  try {
    const raw = await execHerdrAsync(["agent", "get", target], { timeout: 3_000 });
    return parseAgentInfo(parseHerdrJson(raw), target);
  } catch {
    return null;
  }
}

/**
 * Sanitize captured terminal output by stripping ANSI escape sequences,
 * OSC sequences, status spinners, sentinels, and TUI chrome.
 */
export function sanitizeTerminalOutput(raw: string): string {
  if (!raw) return "";

  let text = raw
    // Strip OSC sequences (hyperlinks, window titles)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // Strip CSI ANSI escape codes
    .replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, "")
    // Strip any remaining ANSI escape codes
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Remove terminal sentinels
    .replace(/__SUBAGENT_DONE_\d+__/g, "")
    // Normalize newlines
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  // Filter out noise lines (spinners alone, empty prompt markers, box lines)
  const lines = text.split("\n");
  const cleanedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines that just contained spinners
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✶*·\s]+$/.test(trimmed) && trimmed.length > 0) {
      continue;
    }
    // Skip lines that are purely box-drawing horizontal lines
    if (/^[─━═┄┅┈┉\s]+$/.test(trimmed) && trimmed.length > 3) {
      continue;
    }
    cleanedLines.push(line);
  }

  text = cleanedLines.join("\n").trim();
  // Strip trailing bottom prompts like "> " or "? "
  text = text.replace(/(?:\n|^)\s*[>?]\s*$/g, "").trim();

  return text;
}

/**
 * Read output from an agent pane via `herdr agent read <target>`.
 */
export function readAgentOutput(target: string, lines = 1000): string {
  if (!isHerdrAvailable()) return "";
  try {
    return execHerdrSync([
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(Math.max(1, lines)),
    ]);
  } catch {
    return "";
  }
}

/**
 * Async agent output reading.
 */
export async function readAgentOutputAsync(target: string, lines = 1000): Promise<string> {
  if (!isHerdrAvailable()) return "";
  try {
    return await execHerdrAsync([
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(Math.max(1, lines)),
    ]);
  } catch {
    return "";
  }
}

/**
 * Read and sanitize terminal output from an agent pane or surface.
 * Attempts structured output via `herdr agent read` first (by agentName or surface),
 * falling back to raw screen capture (`readScreen`), and strips ANSI escapes, chrome, and sentinels.
 */
export function readCapturedOutput(surface: string, agentName?: string, lines = 1000): string {
  let raw = "";
  if (agentName) {
    raw = readAgentOutput(agentName, lines);
  }
  if (!raw && surface) {
    raw = readAgentOutput(surface, lines);
  }
  if (!raw && surface) {
    raw = readScreen(surface, lines);
  }
  return sanitizeTerminalOutput(raw);
}

/**
 * Async variant of `readCapturedOutput`.
 */
export async function readCapturedOutputAsync(
  surface: string,
  agentName?: string,
  lines = 1000,
): Promise<string> {
  let raw = "";
  if (agentName) {
    raw = await readAgentOutputAsync(agentName, lines);
  }
  if (!raw && surface) {
    raw = await readAgentOutputAsync(surface, lines);
  }
  if (!raw && surface) {
    raw = await readScreenAsync(surface, lines);
  }
  return sanitizeTerminalOutput(raw);
}

/** Send key presses to an agent (e.g. esc, ctrl+c). */
export function sendAgentKeys(target: string, keys: string[]): void {
  requireHerdr();
  const raw = execHerdrSync(["agent", "send-keys", target, ...keys]);
  parseHerdrResponse(raw, `herdr agent send-keys ${target}`);
}

/** Send key presses straight to a pane (works while the agent is blocked). */
export function sendPaneKeys(surface: string, keys: string[]): void {
  requireHerdr();
  const raw = execHerdrSync(["pane", "send-keys", surface, ...keys]);
  parseHerdrResponse(raw, `herdr pane send-keys ${surface}`);
}

// ── Exit Polling ──

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

export function interpretExitSidecar(data: any): PollResult {
  return interpretExitSignal(data);
}

/**
 * Whether a `.parked` signal counts for the current turn. Signals are
 * accepted only when written at or after the current turn started, so a
 * leftover from a previous turn can never be delivered as the current
 * turn's result (steer↔result stay 1:1).
 */
export function isFreshParkSignal(parkedAt: number, turnStartTime: number): boolean {
  return isFreshSignal(parkedAt, turnStartTime);
}

/**
 * Read-and-consume the `.exit` signal. Kept as a thin alias while the legacy
 * poller is still in place; the codec itself lives in `signals.ts`.
 */
export function consumeExitSidecar(sessionFile: string, turnStartTime: number): PollResult | null {
  return consumeExitSignal(sessionFile, turnStartTime);
}

/**
 * Read-and-consume the `.parked` signal for a kept-open Pi turn.
 */
export function consumeParkedSidecar(sessionFile: string, turnStartTime: number): PollResult | null {
  return consumeParkedSignal(sessionFile, turnStartTime);
}

export const __pollForExitTest__ = {
  interpretExitSidecar,
  setAgentStateOverride: (fn: ((target: string) => AgentInfo | null) | null) => {
    agentStateOverride = fn;
  },
  setSurfaceAliveOverride: (fn: ((surface: string) => boolean) | null) => {
    surfaceAliveOverride = fn;
  },
  setReadScreenOverride: (fn: ((surface: string, lines?: number) => string) | null) => {
    readScreenOverride = fn;
  },
};

export interface PollForExitOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  agentName?: string;
  runner?: CanonicalRunner;
  cwd?: string;
  /**
   * Lower bound (ms epoch) for one-shot sidecar signals to count as fresh —
   * the start of the current turn. Signals written before it are leftovers
   * from an earlier turn and are dropped, keeping steer↔result 1:1.
   */
  turnStartTime?: number;
  idleSettleCount?: number;
  onTick?: (elapsed: number) => void;
}

/**
 * Poll until the subagent exits or completes its active turn.
 * Uses Herdr's agent lifecycle tracking + file sidecars.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollForExitOptions,
): Promise<PollResult> {
  const start = Date.now();
  let hasObservedWorking = false;
  let consecutiveIdleCount = 0;
  let consecutiveNullCount = 0;
  const IDLE_SETTLE_COUNT = options.idleSettleCount ?? 3;

  // One-shot sidecar signals written by the Pi child extension next to its
  // session file: `.exit` (errored turn, any mode) and `.parked` (genuine
  // turn end in a kept-open session — the Pi runner's completion signal,
  // since Herdr "idle" is never trusted for Pi). Each is consumed at most
  // once; stale leftovers are dropped.
  const checkSidecars = (): PollResult | null => {
    if (!options.sessionFile) return null;
    const turnStartTime = options.turnStartTime ?? 0;
    const exitResult = consumeExitSidecar(options.sessionFile, turnStartTime);
    if (exitResult) return exitResult;
    if (options.runner === "pi") {
      return consumeParkedSidecar(options.sessionFile, turnStartTime);
    }
    return null;
  };

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Surface liveness check: detect if pane was closed by user or exited
    if (isHerdrAvailable() && !isSurfaceAlive(surface) && Date.now() - start > 1000) {
      return {
        reason: hasObservedWorking ? "done" : "error",
        exitCode: hasObservedWorking ? 0 : 1,
        errorMessage: hasObservedWorking ? undefined : "Subagent pane was closed.",
      };
    }

    // Fast path: one-shot sidecar signals (.exit / .parked)
    const sidecarResult = checkSidecars();
    if (sidecarResult) return sidecarResult;

    // Check sentinel file if specified (e.g. Claude stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Agent state tracking via Herdr
    if (options.agentName) {
      const stateInfo = getAgentState(options.agentName);
      if (stateInfo) {
        consecutiveNullCount = 0;
        if (stateInfo.state === "working") {
          hasObservedWorking = true;
          consecutiveIdleCount = 0;
        } else if (stateInfo.state === "done") {
          return { reason: "done", exitCode: 0 };
        } else if (hasObservedWorking && stateInfo.state === "idle") {
          // For Pi runner: Herdr's screen detector seeing "idle" does NOT mean completion.
          // Pi subagents are autonomous processes that terminate via ctx.shutdown() when finished,
          // which shuts down the process / closes the pane. While Pi is running, "idle" simply means
          // it is waiting (e.g. for child subagents like scout/researcher, ask_question reply, or tool execution).
          // A session that parks at a genuine turn end instead announces it explicitly via the
          // `.parked` sidecar (consumed by checkSidecars above) — the only turn-level completion
          // signal for Pi, so `runner !== "pi"` stays correct here.
          if (options.runner !== "pi") {
            let isActivelyWriting = false;
            if (options.runner === "agy" || options.runner === "claude") {
              try {
                const nativeFile = getNativeSessionFile({
                  runner: options.runner,
                  sessionId: stateInfo.sessionId,
                  cwd: options.cwd,
                });
                if (nativeFile && existsSync(nativeFile)) {
                  const mtime = statSync(nativeFile).mtimeMs;
                  if (Date.now() - mtime < 3000) {
                    isActivelyWriting = true;
                  }
                }
              } catch {}
            }

            if (isActivelyWriting) {
              consecutiveIdleCount = 0;
            } else {
              consecutiveIdleCount++;
              if (consecutiveIdleCount >= IDLE_SETTLE_COUNT) {
                return { reason: "done", exitCode: 0 };
              }
            }
          }
        }
      } else if (hasObservedWorking) {
        consecutiveNullCount++;
        if (consecutiveNullCount >= 2 || !isSurfaceAlive(surface)) {
          // Agent was running and has now exited/cleared from the pane
          return { reason: "done", exitCode: 0 };
        }
      }
    }

    // Terminal sentinel screen check (fallback for Pi CLI exit marker)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Transient error reading screen or pane is initializing — sidecar
      // signals may still be readable even when the screen isn't.
      const sidecarResult = checkSidecars();
      if (sidecarResult) return sidecarResult;
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
