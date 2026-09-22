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
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

const HERDR_BIN = process.platform === "win32" ? "herdr.exe" : "herdr";

// ── Injectable Execution Seam ──

export interface HerdrExecDeps {
  /** Whether the herdr CLI is usable in this process. */
  available(): boolean;
  /** Run herdr synchronously; throws on non-zero exit (herdr's error JSON is in the message). */
  run(args: string[], options?: { timeoutMs?: number }): string;
}

const defaultHerdrDeps: HerdrExecDeps = {
  available: () => process.env.HERDR_ENV === "1" && hasCommand("herdr"),
  run: (args, options) =>
    execFileSync(HERDR_BIN, args, {
      encoding: "utf8",
      timeout: options?.timeoutMs ?? 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
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

export const RUNNER_KINDS = [
  "pi",
  "agy",
  "claude",
  "codex",
  "grok",
  "opencode",
] as const;

export type CanonicalRunner = (typeof RUNNER_KINDS)[number];

const RUNNER_ALIASES: Record<string, CanonicalRunner> = {
  pi: "pi",
  agy: "agy",
  antigravity: "agy",
  "antigravity-cli": "agy",
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  "openai-codex": "codex",
  grok: "grok",
  "grok-cli": "grok",
  opencode: "opencode",
  "open-code": "opencode",
  open_code: "opencode",
};

export function normalizeRunner(input?: string | null): CanonicalRunner | undefined {
  if (!input) return undefined;
  const key = input.trim().toLowerCase();
  return RUNNER_ALIASES[key];
}

export function isKnownRunner(input?: string | null): boolean {
  return normalizeRunner(input) !== undefined;
}

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

export function shellEscape(s: string): string {
  if (process.platform === "win32") {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

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

function execHerdrSync(args: string[], options?: { timeout?: number }): string {
  requireHerdr();
  return herdrDeps.run(args, { timeoutMs: options?.timeout });
}

async function execHerdrAsync(args: string[], options?: { timeout?: number }): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(HERDR_BIN, args, {
    encoding: "utf8",
    timeout: options?.timeout ?? 60_000,
  });
  return stdout;
}

function parseHerdrJson<T = any>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw new Error(`Failed to parse Herdr JSON response: ${err?.message ?? String(err)}: ${raw}`);
  }
}

// ── Surface / Pane Primitives ──

export interface CreateSurfaceOptions {
  direction?: "right" | "down";
  cwd?: string;
  env?: Record<string, string>;
  fromSurface?: string;
}

/**
 * Create a new sibling pane split for a subagent.
 * Defaults to splitting right off the current pane without stealing keyboard focus.
 * Returns the new pane id (e.g. `w1:p2`).
 */
export function createSurface(name: string, options?: CreateSurfaceOptions): string {
  void name;
  requireHerdr();

  const direction = options?.direction ?? "right";
  const args = ["pane", "split"];

  if (options?.fromSurface) {
    args.push("--pane", options.fromSurface);
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

  const raw = execHerdrSync(args);
  const data = parseHerdrJson(raw);
  const paneId = data?.result?.pane?.pane_id ?? data?.pane?.pane_id ?? data?.pane_id;

  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr pane split response: ${raw}`);
  }

  return paneId;
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
    execHerdrSync(["pane", "close", surface], { timeout: 5_000 });
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

  const exists = paneExists(surface, onError);
  logHerdr(`  paneExists=${exists}`);
  // Only a *confirmed* absence short-circuits. "Cannot tell" falls through to
  // the actual stop attempt.
  if (exists === false) {
    return { ...base, ok: true, paneClosed: true, method: "not-alive" };
  }

  // Ask the runner's TUI to exit: agent keys, falling back to the raw pane.
  if (options?.agentName) {
    let agentError: string | null = null;
    try {
      sendAgentKeys(options.agentName, ["ctrl+c", "ctrl+c"]);
      attempted.push(`agent send-keys ${options.agentName} ctrl+c ctrl+c`);
    } catch (err) {
      // Held back: if the pane fallback lands, the keys still arrived and this
      // is recoverable noise rather than a failure worth reporting.
      agentError = errorText(err);
    }

    if (agentError !== null) {
      try {
        execHerdrSync(["pane", "send-keys", surface, "ctrl+c", "ctrl+c"], { timeout: 3_000 });
        attempted.push(`pane send-keys ${surface} ctrl+c ctrl+c`);
      } catch (fallbackErr) {
        onError(`${agentError}; ${errorText(fallbackErr)}`);
      }
    }
  } else {
    try {
      execHerdrSync(["pane", "send-keys", surface, "ctrl+c", "ctrl+c"], { timeout: 3_000 });
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

/** Check whether a pane surface still exists in Herdr. */
export function isSurfaceAlive(surface: string): boolean {
  if (!isHerdrAvailable()) return false;
  try {
    execHerdrSync(["pane", "read", surface, "--lines", "1"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Send raw command to run in a pane. */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execHerdrSync(["pane", "run", surface, command]);
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

/** Read the screen contents of a pane (sync). */
export function readScreen(surface: string, lines = 50): string {
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

  execHerdrSync(args, { timeout: (options?.timeoutMs ?? 30_000) + 5_000 });
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

  await execHerdrAsync(args, { timeout: (options?.timeoutMs ?? 30_000) + 5_000 });
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

  execHerdrSync(args, { timeout: options?.timeoutMs });
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

  await execHerdrAsync(args, { timeout: options?.timeoutMs });
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

/**
 * Inspect the current state of an agent via `herdr agent get <target>`.
 */
export function getAgentState(target: string): AgentInfo | null {
  if (!isHerdrAvailable()) return null;
  try {
    const raw = execHerdrSync(["agent", "get", target], { timeout: 3_000 });
    const data = parseHerdrJson(raw);
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

/** Send key presses to an agent (e.g. esc, ctrl+c). */
export function sendAgentKeys(target: string, keys: string[]): void {
  requireHerdr();
  execHerdrSync(["agent", "send-keys", target, ...keys]);
}

// ── Exit Polling ──

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

export interface PollForExitOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  agentName?: string;
  runner?: CanonicalRunner;
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

    // Fast path: check for .exit sidecar file (written by Pi's error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

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
        if (stateInfo.state === "working") {
          hasObservedWorking = true;
        } else if (hasObservedWorking && (stateInfo.state === "idle" || stateInfo.state === "done")) {
          // Agent completed its active turn
          return { reason: "done", exitCode: 0 };
        } else if (!hasObservedWorking && Date.now() - start > 3000 && (stateInfo.state === "idle" || stateInfo.state === "done")) {
          // Agent completed quickly or was already idle after prompt delivery
          return { reason: "done", exitCode: 0 };
        }
      } else if (hasObservedWorking) {
        // Agent was running and has now exited/cleared from the pane
        return { reason: "done", exitCode: 0 };
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
      // Transient error reading screen or pane is initializing
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
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
