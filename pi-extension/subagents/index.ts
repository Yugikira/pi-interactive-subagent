import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join, resolve } from "node:path";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  isHerdrAvailable,
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendCommand,
  sendLongCommand,
  terminateSurface,
  isSurfaceAlive,
  readScreen,
  startAgent,
  promptAgent,
  getAgentState,
  readAgentOutput,
  readScreenAsync,
  listPanesAsync,
  sendAgentKeys,
  sendPaneKeys,
  currentPaneId,
  getTabLayout,
  sanitizeAgentName,
  sanitizeTerminalOutput,
  setHerdrLogSink,
  type TerminateOutcome,
} from "./herdr.ts";
import {
  describeRunnerChoices,
  getRunner,
  isKnownRunner,
  isNativeSessionRunner,
  normalizeRunner,
  RUNNER_KINDS,
  type CanonicalRunner,
} from "./runners/registry.ts";
import {
  applySandboxToParts,
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  piAdapter,
} from "./runners/pi.ts";
import { formatNonPiPrompt } from "./runners/protocol.ts";
import { chooseSplitTarget, resolveSubagentLayout } from "./layout.ts";

import {
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  getNativeSessionFile,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeSessionStats,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
} from "./status.ts";
import { getSubagentActivityFile, readSubagentActivityFileAsync } from "./activity.ts";
import {
  consumeAskSignal,
  consumeExitSignal,
  consumeParkedSignal,
  type AskSignal,
} from "./signals.ts";
import {
  CompletionController,
  completionPolicyFor,
  type CompletionResult,
} from "./completion.ts";
import {
  createTicker,
  type MonitorDeps,
  type MonitorEntry,
  type Ticker,
} from "./monitor.ts";
import {
  discoverAgentDefinitions,
  getAgentConfigDir,
  getSubagentAllowlist,
  loadAgentDefaults,
  type AgentDefaults,
  type SubagentSessionMode,
} from "./agents.ts";
import { getSubagentConfig } from "./config.ts";
import { formatParentModel, resolveModel } from "./model-config.ts";
import { getArtifactDir, SUBAGENTS_DIR } from "./paths.ts";
import {
  getToolExtensionPath,
  registerToolExtension,
  SPAWNING_TOOLS,
} from "./tool-extensions.ts";

export { registerToolExtension } from "./tool-extensions.ts";

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const MONITOR_KEY = Symbol.for("pi-subagents/monitor");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevMonitor = (globalThis as any)[MONITOR_KEY] as Ticker | null;
  prevMonitor?.stop();
  (globalThis as any)[MONITOR_KEY] = null;
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

/** First text block of a tool result (content may also hold images). */
function toolResultText(result: any): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

const SubagentParams = Type.Object({
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Which agent role profile to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
        "fixed profile — its model, tool loadout, and system prompt. Optional if `cli` is specified.",
    }),
  ),
  cli: Type.Optional(
    Type.String({
      description:
        describeRunnerChoices() +
        " When a non-pi CLI is specified, the subagent runs with that agent CLI in Herdr.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent profile or runner name. " +
        "Has no effect on which agent runs — use `agent` or `cli` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local configuration.",
    }),
  ),
  keepOpen: Type.Optional(
    Type.Boolean({
      description:
        "When true, the subagent pane stays open in Herdr after the task is completed instead of auto-closing. Useful when you or the user want to inspect the output or interact with the subagent directly.",
    }),
  ),
});

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.keepOpen != null) return params.keepOpen;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

/**
 * Whether the Pi child process should auto-exit at the end of a completed
 * turn. `auto-exit` frontmatter is the default, but an effectively
 * interactive session (explicit `keepOpen` / `interactive: true`) overrides
 * it: the session must stay alive to be steered, matching how the agy/claude
 * CLIs keep their REPL open under `keepOpen`. A parked session's turn
 * completions are delivered via the child's `.parked` sidecar.
 */
function resolveChildAutoExit(autoExit: boolean | undefined, interactive: boolean): boolean {
  return (autoExit ?? false) && !interactive;
}

function resolveRunnerAndAgent(params: {
  agent?: string;
  cli?: string;
}): {
  effectiveRunner: CanonicalRunner;
  agentName?: string;
  agentDefs: AgentDefaults | null;
} {
  let agentName = params.agent?.trim() || undefined;
  let rawCli = params.cli?.trim() || undefined;

  // If agent is specified without cli, check if agent is actually an alias for a known runner
  // when no matching markdown profile exists
  if (agentName && !rawCli) {
    const asRunner = normalizeRunner(agentName);
    if (asRunner) {
      const profile = loadAgentDefaults(agentName);
      if (!profile) {
        rawCli = asRunner;
        agentName = undefined;
      }
    }
  }

  const agentDefs = agentName ? loadAgentDefaults(agentName) : null;
  const effectiveRunner: CanonicalRunner =
    normalizeRunner(rawCli) ??
    normalizeRunner(agentDefs?.cli) ??
    "pi";

  return { effectiveRunner, agentName, agentDefs };
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require Herdr. ${muxSetupHint()}`,
      },
    ],
    details: { error: "Herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
/** Lazy view of the shared config; the file is not read at module import. */
function getStatusConfig() {
  return getSubagentConfig().status;
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  cli?: CanonicalRunner;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  /** Session that spawned this subagent; shutdown only clears its own. */
  parentSessionId?: string;
  herdrAgentName: string;
  task: string;
  agent?: string;
  cli: CanonicalRunner;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  abortController?: AbortController;
  recordFile?: string;
  cwd?: string;
  sessionId?: string;
  turn?: number;
  turnStartTime?: number;
  statusState: SubagentStatusState;
  /** Per-turn completion controller fed by the shared monitor. */
  completion?: CompletionController;
  /** One result steer per turn, even if watchers overlap. */
  delivery?: { turn: number; state: "pending" | "delivered" | "suppressed" };
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const runnerTag = agent.cli !== "pi" ? ` [${agent.cli}]` : "";
    const agentTag = agent.agent ? ` (${agent.agent})` : runnerTag;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right = getStatusConfig().enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli !== "pi"
        ? ` running (${agent.cli})… `
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    stopMonitor();
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function resolveRunningByName(name: string, parentSessionId?: string):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const visible = Array.from(runningSubagents.values()).filter(
    (running) => !parentSessionId || !running.parentSessionId || running.parentSessionId === parentSessionId,
  );
  const matches = visible.filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = visible.map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Format a task prompt for non-Pi runners with an explicit output record protocol.
 */
/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  try {
    const nextTurn = (running.turn ?? 1) + 1;
    running.turn = nextTurn;
    running.turnStartTime = Date.now();

    if (
      running.herdrAgentName &&
      isHerdrAvailable() &&
      send === sendCommand
    ) {
      const promptText =
        running.recordFile && !isNativeSessionRunner(running.cli)
          ? formatNonPiPrompt(message, running.recordFile, nextTurn)
          : message;
      try {
        promptAgent(running.herdrAgentName, promptText);
        return { ok: true };
      } catch {
        // Fallback to sending command to surface directly
      }
    }
    const flattened = message.replace(/\s*\n\s*/g, " ").trim();
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via Herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
  parentSessionId?: string,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "", parentSessionId);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  // If the previous turn's watcher has completed (or was aborted), re-arm watchSubagent
  // so the orchestrator receives the subagent's response for this new turn.
  if (running.interactive && send === sendCommand && latestPi && (!running.abortController || running.abortController.signal.aborted)) {
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    watchSubagent(running, watcherAbort.signal)
      .then((result) => {
        if (!claimDelivery(running)) return;
        updateWidget();
        const presentation = resolveResultPresentation(result, running.name);
        latestPi?.sendMessage(
          {
            customType: "subagent_result",
            content: presentation,
            display: true,
            details: {
              name: running.name,
              task: running.task,
              agent: running.agent,
              cli: running.cli,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              sessionFile: result.sessionFile,
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
              ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
              ...(result.stats ? { stats: result.stats } : {}),
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      })
      .catch((err) => {
        if (!claimDelivery(running)) return;
        updateWidget();
        latestPi?.sendMessage(
          {
            customType: "subagent_result",
            content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
            display: true,
            details: { name: running.name, task: running.task, error: err?.message },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      });
  }

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

/** Send Escape to the active turn without closing the pane or session. */
function defaultInterrupt(running: RunningSubagent): void {
  try {
    sendPaneKeys(running.surface, ["Escape"]);
  } catch {
    // The agent registration can outlive the pane id in rare reload states.
    sendAgentKeys(running.herdrAgentName, ["Escape"]);
  }
}

function handleSubagentInterrupt(
  params: { name?: string },
  interrupt: (running: RunningSubagent) => void = defaultInterrupt,
  parentSessionId?: string,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
  const resolved = resolveRunningByName(params.name ?? "", parentSessionId);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const adapter = getRunner(running.cli) ?? getRunner("pi");
  if (!adapter?.supportsTurnInterrupt) {
    const err =
      `Turn interrupt is only supported for Pi subagents; ` +
      `"${running.name}" runs with the "${running.cli}" CLI.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name },
    };
  }

  try {
    interrupt(running);
  } catch (error: any) {
    const err =
      `Failed to send Escape to subagent "${running.name}" via Herdr: ` +
      `${error?.message ?? String(error)}`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, Date.now());
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Interrupt requested for subagent "${running.name}". Its pane and session stay open; ` +
        `send subagent_message to continue, or subagent_stop to close it.`,
    }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

let monitor: Ticker | null = null;

function isTranscriptFresh(
  adapter: { id: string; nativeTranscriptFreshness: boolean },
  entry: MonitorEntry,
  pane: { kind: string; sessionId?: string },
): boolean | undefined {
  if (!adapter.nativeTranscriptFreshness) return undefined;
  const sessionId = pane.kind === "present" ? pane.sessionId : entry.sessionId;
  const file = getNativeSessionFile({ runner: adapter.id, sessionId, cwd: entry.cwd });
  if (!file || !existsSync(file)) return false;
  try {
    return Date.now() - statSync(file).mtimeMs < 3_000;
  } catch {
    return false;
  }
}

function createMonitorDeps(): MonitorDeps {
  return {
    now: () => Date.now(),
    listPanes: () => listPanesAsync(),
    readActivity: (file, id) => readSubagentActivityFileAsync(file, id),
    readScreen: (surface, lines) => readScreenAsync(surface, lines),
    consumeExit: (entry) =>
      consumeExitSignal(entry.sessionFile, entry.turnStartTime ?? entry.startTime),
    consumeParked: (entry) =>
      consumeParkedSignal(entry.sessionFile, entry.turnStartTime ?? entry.startTime),
    consumeAsk: (entry) => consumeAskSignal(entry.sessionFile),
    isTranscriptFresh: (adapter, entry, pane) => isTranscriptFresh(adapter, entry, pane),
    deliverQuestion: (entry, ask) => deliverPendingQuestion(entry as RunningSubagent, ask),
    onTransitions: (transitions) => {
      const lines = transitions
        .filter(({ entry }) => !entry.interactive)
        .map(({ entry, snapshot, transition }) =>
          formatTransitionLine(entry.name, snapshot, transition),
        );
      if (lines.length === 0) return;
      const capped = capStatusLines(lines, getStatusConfig().lineLimit);
      latestPi?.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(lines, getStatusConfig().lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    onWidgetDirty: () => updateWidget(),
    statusEnabled: () => getStatusConfig().enabled,
  };
}

function ensureMonitorStarted(): void {
  if (monitor) return;
  monitor = createTicker(() => Array.from(runningSubagents.values()), createMonitorDeps(), 1_000);
  monitor.start();
  (globalThis as any)[MONITOR_KEY] = monitor;
}

function stopMonitor(): void {
  monitor?.stop();
  monitor = null;
  (globalThis as any)[MONITOR_KEY] = null;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(keepOpen?: boolean): { autoExit: boolean; interactive: boolean } {
  if (keepOpen) {
    return { autoExit: false, interactive: true };
  }
  return { autoExit: true, interactive: false };
}

/** Stop a subagent and return an honest outcome. */
function terminateRunning(
  running: RunningSubagent,
  closePane = true,
): TerminateOutcome {
  return terminateSurface(running.surface, {
    agentName: running.herdrAgentName,
    closePane,
  });
}

function formatStopErrors(outcome: TerminateOutcome): string {
  const last = outcome.errors.at(-1);
  return last ? ` (herdr: ${last})` : "";
}

/**
 * Message for a stop. Only claims a stop when the pane is confirmed gone —
 * an unverifiable outcome is reported as a failure, never as a success.
 */
function formatStopMessage(name: string, outcome: TerminateOutcome): string {
  if (outcome.ok || outcome.paneClosed) {
    return `Subagent "${name}" stopped.`;
  }
  if (outcome.reason === "unverified") {
    return (
      `Subagent "${name}" may still be running: Herdr could not report the state of pane ` +
      `${outcome.surface}, so the stop could not be verified.` +
      formatStopErrors(outcome)
    );
  }
  return (
    `Subagent "${name}" did not stop: pane ${outcome.surface} is still open. ` +
    `Its process may still be running there — close the pane manually once you no longer need it.` +
    formatStopErrors(outcome)
  );
}

function stopSubagentByName(targetName?: string, parentSessionId?: string): string {
  const visible = () =>
    Array.from(runningSubagents.values()).filter(
      (running) =>
        !parentSessionId ||
        !running.parentSessionId ||
        running.parentSessionId === parentSessionId,
    );

  const trimmed = targetName?.trim();
  if (trimmed === "all") {
    const all = visible();
    if (all.length === 0) {
      return "No subagents are currently running.";
    }
    const count = all.length;
    const stuck: string[] = [];
    for (const running of all) {
      const outcome = terminateRunning(running);
      running.abortController?.abort();
      runningSubagents.delete(running.id);
      if (!outcome.ok && !outcome.paneClosed) {
        stuck.push(`${running.name} (${running.surface})`);
      }
    }
    updateWidget();
    if (stuck.length === 0) {
      return `All subagents stopped (${count} stopped).`;
    }
    return (
      `Stopped ${count - stuck.length} of ${count} subagents. Still running: ${stuck.join(", ")}. ` +
      `Their panes were left open.`
    );
  }
  if (trimmed) {
    const match = visible().find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
    if (!match) {
      const names = visible().map((r) => r.name);
      return `No running subagent named "${trimmed}". Currently running: ${names.join(", ") || "none"}.`;
    }
    const outcome = terminateRunning(match);
    match.abortController?.abort();
    runningSubagents.delete(match.id);
    updateWidget();
    return formatStopMessage(match.name, outcome);
  }
  const all = visible();
  if (all.length === 0) {
    return "No subagents are currently running.";
  }
  if (all.length === 1) {
    const only = all[0];
    const outcome = terminateRunning(only);
    only.abortController?.abort();
    runningSubagents.delete(only.id);
    updateWidget();
    return formatStopMessage(only.name, outcome);
  }
  const names = all.map((r) => r.name);
  return `Multiple subagents running: ${names.join(", ")}. Use /subagent:stop <name> or /subagent:stop all.`;
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveRunnerAndAgent,
  normalizeRunner,
  isKnownRunner,
  RUNNER_KINDS,
  sanitizeAgentName,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  resolveChildAutoExit,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  getToolExtensionPath,
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  handleSubagentInterrupt,
  defaultInterrupt,
  claimDelivery,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
  stopSubagentByName,
  terminateRunning,
  formatStopMessage,
  terminateSurface,
  formatNonPiPrompt,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  launchSubagent,
};

/** Panes created by this extension, used for smart tiling. */
const trackedSurfaces = new Set<string>();

/** Create the subagent pane according to `PI_SUBAGENT_LAYOUT`. */
function createSubagentSurface(
  displayName: string,
  cwd: string,
  env: Record<string, string>,
): string {
  const mode = resolveSubagentLayout();
  if (mode === "tab") {
    return createSurface(displayName, { cwd, env, layout: "tab" });
  }
  if (mode === "down") {
    return createSurface(displayName, { cwd, env, layout: "down" });
  }
  if (mode === "smart") {
    const caller = currentPaneId();
    const layout = getTabLayout(caller);
    const panes = layout?.panes ?? [];
    // Drop panes that no longer exist so a stale id cannot become the target.
    for (const id of [...trackedSurfaces]) {
      if (!panes.some((pane) => pane.paneId === id)) trackedSurfaces.delete(id);
    }
    const choice = chooseSplitTarget(caller, panes, trackedSurfaces);
    const surface = createSurface(displayName, {
      cwd,
      env,
      layout: choice.direction,
      fromSurface: choice.target ?? undefined,
    });
    trackedSurfaces.add(surface);
    return surface;
  }
  // Default: preserve the historical right split off the caller's pane.
  return createSurface(displayName, { cwd, env, layout: "right" });
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    model?: { provider?: string; id?: string } | null;
  },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const { effectiveRunner, agentName, agentDefs } = resolveRunnerAndAgent(params);
  const adapter = getRunner(effectiveRunner) ?? getRunner("pi");
  if (!adapter) throw new Error("Pi runner adapter is not registered");

  const effectiveModel = resolveModel({
    explicitModel: params.model,
    agentName,
    agentModel: agentDefs?.model,
    config: getSubagentConfig().models,
    env: process.env,
    parentModel: formatParentModel(ctx.model),
  }).model ?? undefined;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const displayName = params.name || agentName || effectiveRunner;
  const herdrAgentName = sanitizeAgentName(displayName);

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  // Interactive sessions (keepOpen / interactive frontmatter) stay parked after
  // each turn instead of shutting down; their completions arrive via the
  // child-authored `.parked` signal.
  const childAutoExit = resolveChildAutoExit(agentDefs?.autoExit, effectiveInteractive);
  const modeHint = childAutoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = childAutoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = launchBehavior.inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, { grantSpawning });
  const loadout: SubagentLoadout = {
    agent: agentName ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: agentDefs?.subagentAgents ?? null,
    autoExit: childAutoExit,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
  };
  // Only the Pi runner can be resumed, so only it needs a loadout snapshot.
  if (adapter.id === "pi") {
    writeSubagentLoadout(subagentSessionFile, loadout);
  }

  const plan = adapter.buildLaunch({
    platform: process.platform,
    id,
    displayName,
    herdrAgentName,
    task: params.task,
    taskDelivery: launchBehavior.taskDelivery,
    cwd: targetCwdForSession,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    agentName: agentName ?? null,
    agent: agentDefs,
    loadout,
    artifactDir,
    sessionFile: subagentSessionFile,
    activityFile,
    subagentDonePath: join(SUBAGENTS_DIR, "subagent-done.ts"),
    autoExit: childAutoExit,
    interactive: effectiveInteractive,
    spawnable: agentDefs?.subagentAgents ?? null,
    agentDir: resolvedAgentDir,
    effectiveTools,
    effectiveSkills,
    grantSpawning,
    fullTask,
  });

  // Use a pre-created surface (parallel mode) or create one with the complete
  // pane env. Every runner now gets the same env, including the spawn
  // allowlist and agent dir on the normal startAgent path.
  const surfacePreCreated = !!options?.surface;
  const surface =
    options?.surface ?? createSubagentSurface(displayName, targetCwdForSession, plan.env);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const ext = process.platform === "win32" ? "ps1" : "sh";
  const safeName = displayName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const launchScriptFile =
    adapter.id === "pi"
      ? join(artifactDir, "subagent-scripts", `${safeName || "subagent"}-${id}.${ext}`)
      : undefined;

  try {
    if (adapter.id === "pi") {
      try {
        startAgent(herdrAgentName, "pi", surface, { args: plan.startArgs });
      } catch {
        sendLongCommand(surface, plan.fallbackCommand ?? "", {
          scriptPath: launchScriptFile!,
          scriptPreamble: (plan.scriptPreamble ?? []).join("\n"),
        });
      }
    } else {
      try {
        startAgent(herdrAgentName, adapter.id, surface, { args: plan.startArgs });
      } catch {
        // Herdr returns agent_not_ready if the agent is blocked on startup
        // (e.g. a workspace trust prompt). Accept it and retry the launch.
        const screen = readScreen(surface, 20);
        if (/trust.*folder|trust.*project/i.test(screen)) {
          try {
            sendAgentKeys(herdrAgentName, ["enter"]);
          } catch {
            sendCommand(surface, "");
          }
        }
      }

      for (let i = 0; i < 6; i++) {
        const state = getAgentState(herdrAgentName);
        if (state && (state.state === "idle" || state.state === "working")) break;
        if (state && state.state === "blocked") {
          const screen = readScreen(surface, 15);
          if (/trust/i.test(screen)) {
            try {
              sendAgentKeys(herdrAgentName, ["enter"]);
            } catch {
              sendCommand(surface, "");
            }
          }
        }
        await new Promise<void>((r) => setTimeout(r, 500));
      }

      const prompt = plan.prompt ?? params.task;
      try {
        promptAgent(herdrAgentName, prompt);
      } catch {
        const screen = readScreen(surface, 15);
        if (/trust/i.test(screen)) {
          try {
            sendAgentKeys(herdrAgentName, ["enter"]);
            await new Promise<void>((r) => setTimeout(r, 500));
            promptAgent(herdrAgentName, prompt);
          } catch {
            sendCommand(surface, prompt);
          }
        } else {
          sendCommand(surface, prompt);
        }
      }
    }

    const running: RunningSubagent = {
      id,
      name: displayName,
      parentSessionId: sessionId,
      herdrAgentName,
      task: params.task,
      agent: agentName,
      cli: adapter.id,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      activityFile,
      cwd: targetCwdForSession,
      recordFile: plan.recordFile,
      turn: 1,
      turnStartTime: startTime,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        // All runners now report live pane/activity status; the legacy
        // Claude-only "running" source is no longer used in production.
        source: "pi",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    return running;
  } catch (err) {
    if (!surfacePreCreated) {
      terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    }
    throw err;
  }
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
function deliverPendingQuestion(running: RunningSubagent, payload: AskSignal): void {
  if (!payload.question) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Claim the single result steer allowed for a completed turn. */
function claimDelivery(running: RunningSubagent): boolean {
  const delivery = running.delivery;
  // No record means an error surfaced outside the per-turn watcher; deliver it.
  if (!delivery) return true;
  if (delivery.state !== "pending") return false;
  delivery.state = "delivered";
  return true;
}

/** Wake the parent once when a turn stops making progress. Never settles it. */
function notifyStall(running: RunningSubagent, elapsedMs: number): void {
  const line =
    `${running.name} no progress for ${Math.round(elapsedMs / 1000)}s — still running; ` +
    `steer with subagent_message or stop with subagent_stop.`;
  latestPi?.sendMessage(
    {
      customType: "subagent_status",
      content: `Subagent ${line}`,
      display: true,
      details: { name: running.name, elapsedMs, lines: [line], overflow: 0 },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, herdrAgentName, task, surface, startTime, sessionFile, cli } = running;
  const adapter = getRunner(cli) ?? getRunner("pi");
  if (!adapter) throw new Error(`Unknown runner adapter: ${cli}`);
  const deliveryTurn = running.turn ?? 1;

  try {
    // The shared monitor feeds this controller once per tick; the controller
    // itself owns no timer.
    const controller = new CompletionController(
      completionPolicyFor(adapter, { interactive: running.interactive }),
      running.turnStartTime ?? startTime,
      (elapsedMs) => notifyStall(running, elapsedMs),
    );
    running.completion = controller;
    const combined = AbortSignal.any([signal, getModuleAbortSignal()]);
    const onAbort = () => controller.abort();
    combined.addEventListener("abort", onAbort, { once: true });
    if (combined.aborted) onAbort();

    let result: CompletionResult;
    try {
      result = await controller.result;
    } finally {
      combined.removeEventListener("abort", onAbort);
      running.completion = undefined;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // External runners (agy, claude, codex, grok, opencode)
    if (!adapter.supportsSessionStats) {
      let summary = "";

      // Resolve session ID from Herdr if not already known
      let sessionRefId = running.sessionId;
      if (!sessionRefId && running.herdrAgentName) {
        const stateInfo = getAgentState(running.herdrAgentName);
        if (stateInfo?.sessionId) {
          sessionRefId = stateInfo.sessionId;
          running.sessionId = sessionRefId;
        }
      }

      // 1. The adapter owns native-reader vs protocol-record dispatch.
      summary =
        adapter.extractResult({
          sessionFile,
          recordFile: running.recordFile,
          cwd: running.cwd ?? "",
          turnStartTime: running.turnStartTime ?? startTime,
          sessionId: sessionRefId,
          agentName: herdrAgentName,
          readPane: (lines) => sanitizeTerminalOutput(readAgentOutput(herdrAgentName, lines)),
        })?.summary ?? "";

      // 2. Fallback to reading agent output via Herdr with expanded buffer and sanitization
      if (!summary) {
        summary = sanitizeTerminalOutput(readAgentOutput(herdrAgentName, 1000));
      }

      // 4. Fallback to reading screen
      if (!summary) {
        summary = sanitizeTerminalOutput(
          readScreen(surface, 1000).replace(/__SUBAGENT_DONE_\d+__/, "")
        );
      }

      if (!summary) {
        summary =
          result.exitCode !== 0
            ? `${cli} exited with code ${result.exitCode}`
            : `${cli} completed without output`;
      }

      if (!running.interactive && result.exitCode === 0) {
        await new Promise((r) => setTimeout(r, 500));
        terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
      }
      if (!running.interactive || !isSurfaceAlive(surface)) {
        runningSubagents.delete(running.id);
      } else {
        running.abortController = undefined;
        running.turn = (running.turn ?? 1) + 1;
        running.turnStartTime = Date.now();
      }

      running.delivery = { turn: deliveryTurn, state: "pending" };
      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        cli,
      };
    }

    // Pi subagent result extraction
    let summary = "";
    if (existsSync(sessionFile)) {
      summary =
        adapter.extractResult({
          sessionFile,
          recordFile: running.recordFile,
          cwd: running.cwd ?? "",
          turnStartTime: running.turnStartTime ?? startTime,
          sessionId: running.sessionId,
          agentName: herdrAgentName,
          readPane: (lines) => sanitizeTerminalOutput(readAgentOutput(herdrAgentName, lines)),
        })?.summary ?? "";
      if (!summary) {
        summary = result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output";
      }
    } else {
      summary =
        sanitizeTerminalOutput(readAgentOutput(herdrAgentName, 1000)) ||
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    if (!running.interactive && result.exitCode === 0) {
      await new Promise((r) => setTimeout(r, 500));
      terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    }
    if (!running.interactive || !isSurfaceAlive(surface)) {
      runningSubagents.delete(running.id);
    } else {
      running.abortController = undefined;
      running.turn = (running.turn ?? 1) + 1;
      running.turnStartTime = Date.now();
    }

    running.delivery = { turn: deliveryTurn, state: "pending" };
    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      cli,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    runningSubagents.delete(running.id);
    running.delivery = { turn: deliveryTurn, state: "pending" };

    if (signal.aborted) {
      terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
        cli: running.cli,
      };
    }
    terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
      cli: running.cli,
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;

  // Opt-in termination diagnostics. Stop failures used to be invisible (every
  // herdr error was swallowed and the tool always reported success), so when a
  // stop misbehaves this log is the only way to see which probe lied.
  if (process.env.PI_SUBAGENT_DEBUG === "1") {
    const logFile = process.env.PI_SUBAGENT_DEBUG_FILE ?? join(tmpdir(), "pi-subagents-herdr.log");
    try {
      setHerdrLogSink((message) => {
        appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
      });
      appendFileSync(
        logFile,
        `\n${new Date().toISOString()} ── extension loaded (pid ${process.pid}, cwd ${process.cwd()}) ──\n`,
      );
    } catch {
      // Never let diagnostics break extension loading.
    }
  }

  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
  });

  // Clean up on session shutdown. Pi can host multiple sessions in one
  // process, so only clear the subagents this session spawned; another
  // session's panes and watchers must survive.
  pi.on("session_shutdown", (_event, ctx) => {
    const shutdownSessionId = ctx?.sessionManager?.getSessionId?.();
    for (const [id, agent] of runningSubagents) {
      if (shutdownSessionId && agent.parentSessionId && agent.parentSessionId !== shutdownSessionId) {
        continue;
      }
      terminateSurface(agent.surface, { agentName: agent.herdrAgentName, closePane: true });
      agent.abortController?.abort();
      runningSubagents.delete(id);
    }
    if (runningSubagents.size === 0) {
      stopMonitor();
      trackedSurfaces.clear();
      const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
      if (moduleAbort) moduleAbort.abort();
    }
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { effectiveRunner, agentName, agentDefs } = resolveRunnerAndAgent(params);

        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (effectiveRunner === "pi" && agentName && currentAgent && agentName === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        const allowlist = getSubagentAllowlist();
        const permittedAgents = allowlist
          ? [...allowlist]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        // Strict whitelist at every depth.
        if (agentName) {
          if (!permittedSet.has(agentName)) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `You may not spawn the "${agentName}" agent — it is not ` +
                    `${allowlist ? "in your allowlist" : "a known agent"}. ` +
                    `Available agents: ${permittedList}.`,
                },
              ],
              details: {
                error: allowlist ? "agent not in allowlist" : "unknown agent",
              },
            };
          }
        } else if (!params.cli && !params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        }

        // Validate prerequisites (need Herdr + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Names are unique across the whole session: dedupe explicit labels as
        // well as defaulted ones, against running subagents, in-flight
        // reservations, and every name already in the registry. Reserve the
        // chosen name synchronously (before any await) so parallel spawns
        // don't collide.
        const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
        const requestedBase = params.name?.trim() || agentName || effectiveRunner;
        params.name = uniqueRunningName(requestedBase, registryNames);
        const reservedName: string = params.name;
        reservedNames.add(reservedName);

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        let running;
        try {
          running = await launchSubagent(params, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
        }

        // Persist name → session so subagent_message({ name }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
          runner: running.cli,
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        ensureMonitorStarted();

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            if (!claimDelivery(running)) return;
            updateWidget(); // reflect removal from Map immediately

            const presentation = resolveResultPresentation(result, running.name);

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  cli: running.cli,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.stats ? { stats: result.stats } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!claimDelivery(running)) return;
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: running.agent,
            cli: running.cli,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const cliName =
          typeof partialArgs.cli === "string" && partialArgs.cli ? partialArgs.cli : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || cliName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agentTag =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const runnerTag =
          cliName && cliName !== "pi" ? theme.fg("accent", ` [${cliName}]`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agentTag +
          runnerTag +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = toolResultText(result);
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const config = getSubagentConfig();
        const list = discoverAgentDefinitions()
          .filter((agent) => !agent.disableModelInvocation)
          .map((agent) => ({
            ...agent,
            resolvedModel: resolveModel({
              agentName: agent.name,
              agentModel: agent.model,
              config: config.models,
              env: process.env,
              parentModel: formatParentModel(ctx?.model),
            }).model,
          }));

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.resolvedModel ? ` [${a.resolvedModel}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        lines.push("");
        lines.push(`Supported CLI runners: ${RUNNER_KINDS.join(", ")} (specify via cli parameter)`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list, runners: RUNNER_KINDS },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const shownModel = a.resolvedModel ?? a.model;
          const model = shownModel ? theme.fg("dim", ` [${shownModel}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "`name` and `message` are both required. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
        "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message. " +
        "Do not poll or fabricate results.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
        }),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const text = toolResultText(result);
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it.
        const parentSessionId = ctx.sessionManager.getSessionId();
        const runningMatch = Array.from(runningSubagents.values()).find(
          (r) =>
            r.name === requestedName &&
            (!r.parentSessionId || r.parentSessionId === parentSessionId),
        );
        if (runningMatch) {
          return handleSubagentSteer(
            { name: requestedName, message: params.message },
            sendCommand,
            parentSessionId,
          );
        }

        // ── Resume a finished session by name ──
        const message = params.message;
        const name = requestedName; // identity preservation: the resumed run reclaims its name
        const { autoExit, interactive } = resolveResumeLaunchBehavior();
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        // Resolve the name to its session file via this session's registry.
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );
        const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
        if (!entry) {
          const known = Object.keys(readNameRegistry(parentArtifactDir));
          const err =
            `No subagent named "${requestedName}" in this session. ` +
            (known.length > 0
              ? `Known subagents: ${known.join(", ")}.`
              : "No subagents have been spawned in this session yet.");
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const sessionPath = entry.sessionFile;
        if (!sessionPath || !existsSync(sessionPath)) {
          const err =
            `Subagent "${requestedName}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // Only Pi sessions carry the loadout + resume command contract. Legacy
        // entries predate the `runner` field and default to Pi.
        const entryRunner = entry.runner ?? "pi";
        if (entryRunner !== "pi") {
          const err =
            `Subagent "${requestedName}" ran with the "${entryRunner}" CLI. ` +
            `Session resume is only supported for Pi subagents; spawn a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        // Guard: never resume a session that is still running — two processes
        // mutating the same .jsonl corrupts it. Steer it by name instead.
        for (const r of runningSubagents.values()) {
          if (resolve(r.sessionFile) === resolve(sessionPath)) {
            const err = `Subagent "${requestedName}" is still running as "${r.name}". Your message will steer it; resending as a steer.`;
            return handleSubagentSteer(
              { name: r.name, message: params.message },
              sendCommand,
              ctx.sessionManager.getSessionId(),
            );
          }
        }

        // Reconstruct the sandbox from the snapshot written at spawn time.
        // Without it we cannot safely resume: relaunching bare would load every
        // global extension + the full toolset. Refuse rather than escalate.
        const loadout = readSubagentLoadout(sessionPath);
        if (!loadout) {
          const err =
            `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
            `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;

        // Record entry count before resuming so we can extract new messages.
        // Count lines cheaply (no per-line JSON.parse) so resuming a large
        // transcript doesn't block the UI.
        const entryCountBefore = countSessionEntryLines(sessionPath);

        const surface = createSubagentSurface(name, loadout.cwd ?? process.cwd(), {});
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, message, "utf8");
        }

        // The Pi adapter owns resume command construction: it replays the
        // sandbox from the loadout and reuses the same env/quoting path as a
        // fresh launch, so spawn and resume cannot drift.
        const command = piAdapter.buildResume!({
          platform: process.platform,
          sessionFile: sessionPath,
          name,
          id,
          activityFile,
          artifactDir,
          subagentDonePath: join(SUBAGENTS_DIR, "subagent-done.ts"),
          messageFile: resumeMsgFile ?? null,
          loadout,
          autoExit,
          agentDir: loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
          spawnable: loadout.spawnable,
          cwd: loadout.cwd,
        });
        const resumeExt = process.platform === "win32" ? "ps1" : "sh";
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.${resumeExt}`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          parentSessionId: ctx.sessionManager.getSessionId(),
          herdrAgentName: sanitizeAgentName(name),
          task: message,
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          activityFile,
          cli: "pi",
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        ensureMonitorStarted();

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            if (!claimDelivery(running)) return;
            updateWidget();

            const allEntries = getNewEntries(sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: sessionPath, sessionId: resumedSessionId },
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: message,
                  cli: "pi",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: sessionPath,
                  sessionId: resumedSessionId,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!claimDelivery(running)) return;
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // ── subagent_interrupt tool ──
  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description:
      "Send Escape to the active turn of a running Pi subagent. The pane, session, and watcher stay alive; " +
      "the subagent remains steerable with subagent_message and can be closed with subagent_stop.",
    promptSnippet:
      "Send Escape to the active turn of a running Pi subagent. The pane, session, and watcher stay alive; " +
      "the subagent remains steerable with subagent_message and can be closed with subagent_stop.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact running subagent display name" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return handleSubagentInterrupt(
        params,
        defaultInterrupt,
        ctx?.sessionManager?.getSessionId?.(),
      );
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(args.name ?? "(unknown)")) +
          theme.fg("dim", " — interrupt turn"),
        0,
        0,
      );
    },
    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "interrupt_requested") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
            theme.fg("dim", " — interrupt requested"),
          0,
          0,
        );
      }
      const text = toolResultText(result);
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  // ── subagent_stop tool ──
  pi.registerTool({
    name: "subagent_stop",
    label: "Stop Subagent",
    description:
      "Stop a running subagent, abort its background watcher, dismiss its UI widget, and optionally close its pane in Herdr. " +
      "Use this when a subagent is no longer needed, was closed by the user, has errored or stalled, or needs to be terminated.",
    promptSnippet:
      "Stop a running subagent by name, dismiss its UI widget, and optionally close its pane.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Display name of the subagent to stop. If omitted and only one subagent is running, stops that subagent.",
        }),
      ),
      closePane: Type.Optional(
        Type.Boolean({
          description: "Whether to close the pane in Herdr. Defaults to true.",
        }),
      ),
    }),

    renderCall(args, theme) {
      const target = args.name ?? "(current)";
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — stop"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.stopped) {
        const label = theme.fg("toolTitle", theme.bold(details.name ?? "subagent"));
        return new Text(
          details.warning
            ? theme.fg("error", "⚠") + " " + label + theme.fg("error", " — pane still open")
            : theme.fg("success", "✓") + " " + label + theme.fg("dim", " — stopped"),
          0,
          0,
        );
      }
      const text = toolResultText(result);
      return new Text(theme.fg("dim", text), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx?.sessionManager?.getSessionId?.();
      const visible = Array.from(runningSubagents.values()).filter(
        (r) => !r.parentSessionId || r.parentSessionId === parentSessionId,
      );

      if (visible.length === 0) {
        return {
          content: [{ type: "text", text: "No subagents are currently running." }],
          details: { stopped: false, reason: "none_running" },
        };
      }

      let target: RunningSubagent | undefined;
      if (params.name?.trim()) {
        const requested = params.name.trim().toLowerCase();
        target = visible.find((r) => r.name.toLowerCase() === requested);
        if (!target) {
          const names = visible.map((r) => r.name);
          return {
            content: [
              {
                type: "text",
                text: `No running subagent named "${params.name.trim()}". Currently running: ${names.join(", ")}.`,
              },
            ],
            details: { stopped: false, error: "not_found" },
          };
        }
      } else if (visible.length === 1) {
        target = visible[0];
      } else {
        const names = visible.map((r) => r.name);
        return {
          content: [
            {
              type: "text",
              text: `Multiple subagents are running (${names.join(", ")}). Please specify the name of the subagent to stop.`,
            },
          ],
          details: { stopped: false, error: "ambiguous" },
        };
      }

      const closePane = params.closePane !== false;
      const outcome = terminateRunning(target, closePane);
      target.abortController?.abort();
      runningSubagents.delete(target.id);
      updateWidget();

      // Report a pane that survived instead of claiming a clean stop. Scoped to
      // pi because it is the runner whose stop path was changed; every other
      // runner keeps its previous messaging.
      const failed = target.cli === "pi" && closePane && !outcome.ok && !outcome.paneClosed;
      const message = formatStopMessage(target.name, outcome);

      return {
        content: [
          {
            type: "text",
            text: failed ? message : `Sub-agent "${target.name}" stopped and dismissed.`,
          },
        ],
        details: {
          stopped: true,
          name: target.name,
          id: target.id,
          paneClosed: outcome.paneClosed,
          ...(failed ? { warning: message } : {}),
        },
      };
    },
  });

  // /subagent command — spawn or manage subagents
  pi.registerCommand("subagent", {
    description: "Manage subagents: /subagent <agent|cli> [task] | /subagent stop [name] | /subagent status",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent|cli> [task] | /subagent stop [name] | /subagent status", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const target = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (target.toLowerCase() === "stop" || target.toLowerCase() === "kill") {
        const msg = stopSubagentByName(rest, ctx?.sessionManager?.getSessionId?.());
        ctx.ui.notify(msg, msg.includes("No running") || msg.includes("Multiple") ? "warning" : "info");
        return;
      }

      if (target.toLowerCase() === "status" || target.toLowerCase() === "list") {
        if (runningSubagents.size === 0) {
          ctx.ui.notify("No subagents are currently running.", "info");
          return;
        }
        const lines = Array.from(runningSubagents.values()).map((r) => {
          const elapsed = formatElapsedMMSS(r.startTime);
          const snapshot = classifyStatus(r.statusState, Date.now());
          return `• ${r.name} [${r.cli}] (${elapsed}, ${snapshot.kind})`;
        });
        ctx.ui.notify(`Running subagents:\n${lines.join("\n")}`, "info");
        return;
      }

      const runner = normalizeRunner(target);
      if (runner) {
        const taskText = rest || `You are the ${runner} agent. Wait for instructions.`;
        const displayName = runner[0].toUpperCase() + runner.slice(1);
        const toolCall = `Use subagent with cli: "${runner}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
        pi.sendUserMessage(toolCall);
        return;
      }

      const defs = loadAgentDefaults(target);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${target}" not found in ~/.pi/agent/agents/ or .pi/agents/ (supported runners: ${RUNNER_KINDS.join(", ")})`,
          "error",
        );
        return;
      }

      const taskText = rest || `You are the ${target} agent. Wait for instructions.`;
      const displayName = target[0].toUpperCase() + target.slice(1);
      const toolCall = `Use subagent with agent: "${target}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent:stop command — convenience command to stop a running subagent
  pi.registerCommand("subagent:stop", {
    description: "Stop a running subagent: /subagent:stop [name|all]",
    handler: async (args, ctx) => {
      const msg = stopSubagentByName(args, ctx?.sessionManager?.getSessionId?.());
      ctx.ui.notify(msg, msg.includes("No running") || msg.includes("Multiple") ? "warning" : "info");
    },
  });

  // /subagents command — list currently running subagents
  pi.registerCommand("subagents", {
    description: "List currently running subagents: /subagents",
    handler: async (_args, ctx) => {
      if (runningSubagents.size === 0) {
        ctx.ui.notify("No subagents are currently running.", "info");
        return;
      }
      const lines = Array.from(runningSubagents.values()).map((r) => {
        const elapsed = formatElapsedMMSS(r.startTime);
        const snapshot = classifyStatus(r.statusState, Date.now());
        return `• ${r.name} [${r.cli}] (${elapsed}, ${snapshot.kind})`;
      });
      ctx.ui.notify(`Running subagents:\n${lines.join("\n")}`, "info");
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
