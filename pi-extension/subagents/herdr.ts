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

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
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

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a Herdr-managed pane with the herdr binary on PATH.
 * `HERDR_ENV=1` is injected by Herdr into every managed pane.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Subagents require Herdr. Ensure you are running inside a Herdr-managed pane (HERDR_ENV=1) and `herdr` is in PATH.";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
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
  return execFileSync(HERDR_BIN, args, {
    encoding: "utf8",
    timeout: options?.timeout ?? 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
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

/** Close a pane. Returns true if the pane was closed (or was already dead). */
export function closeSurface(surface: string): boolean {
  if (!isHerdrAvailable()) return false;
  try {
    execHerdrSync(["pane", "close", surface], { timeout: 5_000 });
    return true;
  } catch {
    // If pane already closed, isSurfaceAlive will be false (success)
    if (isSurfaceAlive(surface)) {
      try {
        execHerdrSync(["pane", "close", surface], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }
}

export interface TerminateSurfaceOptions {
  agentName?: string;
  closePane?: boolean;
}

/**
 * Terminate a subagent's running process and optionally close its pane surface in Herdr.
 *
 * 1. Sends break/interruption keys (ctrl+c, ctrl+c) to cleanly stop the active process
 *    (via Herdr agent keys or pane keys).
 * 2. If closePane is true (default), closes the pane surface in Herdr so Herdr does not
 *    respawn a default shell or leave the pane hanging.
 */
export function terminateSurface(
  surface: string,
  options?: TerminateSurfaceOptions,
): boolean {
  if (!isHerdrAvailable()) return false;
  if (!isSurfaceAlive(surface)) return true;

  // 1. Send break / interrupt keys to cleanly exit the running agent/process
  if (options?.agentName) {
    try {
      sendAgentKeys(options.agentName, ["ctrl+c", "ctrl+c"]);
    } catch {
      try {
        execHerdrSync(["pane", "send-keys", surface, "ctrl+c", "ctrl+c"], { timeout: 3_000 });
      } catch {}
    }
  } else {
    try {
      execHerdrSync(["pane", "send-keys", surface, "ctrl+c", "ctrl+c"], { timeout: 3_000 });
    } catch {}
  }

  // 2. If closePane is explicitly false, keep the pane open
  if (options?.closePane === false) {
    return true;
  }

  // 3. Close the pane surface in Herdr
  return closeSurface(surface);
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
