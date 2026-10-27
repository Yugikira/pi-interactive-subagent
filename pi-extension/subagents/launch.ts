/**
 * The launch seam: create a Herdr surface, start a runner in it, deliver the
 * first prompt, and produce a complete `RunningSubagent`. Spawn and resume both
 * go through this module so readiness, trust prompts, and surface selection
 * cannot drift.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSubagentActivityFile } from "./activity.ts";
import { getSubagentConfig } from "./config.ts";
import {
  createSurfaceAsync,
  currentPaneId,
  getAgentStateAsync,
  getTabLayoutAsync,
  listPanesAsync,
  promptAgentAsync,
  readScreenAsync,
  sanitizeAgentName,
  sendLongCommand,
  sendPaneKeys,
  startAgentAsync,
  terminateSurface,
} from "./herdr.ts";
import {
  getDefaultSessionDirFor,
  getShellReadyDelayMs,
  parentModelForRunner,
  resolveChildAutoExit,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveResumeLaunchBehavior,
  resolveRunnerAndAgent,
  resolveSubagentPaths,
  type SpawnParams,
} from "./launch-config.ts";
import { persistRunning } from "./name-registry.ts";
import { chooseSplitTarget, resolveSubagentLayout } from "./layout.ts";
import { formatParentModel, resolveModel } from "./model-config.ts";
import { getArtifactDir, SUBAGENTS_DIR } from "./paths.ts";
import { runningSubagents, trackedSurfaces, type RunningSubagent } from "./runtime.ts";
import { buildSubagentToolAllowlist } from "./runners/pi.ts";
import { getRunner } from "./runners/registry.ts";
import type { CanonicalRunner } from "./runner-kinds.ts";
import { createStatusState } from "./status.ts";
import {
  countSessionEntryLines,
  getSessionId,
  readSubagentLoadout,
  seedSubagentSessionFile,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "./session.ts";
import type { NameRegistryEntry } from "./signals.ts";
import type { RunnerResumeContext } from "./runners/types.ts";

/**
 * Bound how long a failed child can block the spawn call. Herdr's default
 * readiness wait is 30s; a child that exits on a bad model should not freeze
 * the extension host for that long.
 */
const AGENT_START_TIMEOUT_MS = 8_000;
const AGENT_START_ATTEMPTS = 2;
/**
 * Agy's cold start can take well over Herdr's 8s default. Give it a longer
 * start window and, critically, wait for the *named* agent to become ready
 * before sending the first prompt.
 */
const AGY_START_TIMEOUT_MS = 20_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const AGY_READY_TIMEOUT_MS = 20_000;

function startTimeoutFor(kind: CanonicalRunner): number {
  return kind === "agy" ? AGY_START_TIMEOUT_MS : AGENT_START_TIMEOUT_MS;
}

function readyTimeoutFor(kind: CanonicalRunner): number {
  return kind === "agy" ? AGY_READY_TIMEOUT_MS : DEFAULT_READY_TIMEOUT_MS;
}

/**
 * The pane inventory reports the registered agent *kind* (`agy`, `claude`,
 * `pi`, …), not the custom Herdr name. Match either: a start that timed out
 * after registering the agent must not be retried (the second start sees
 * `agent_pane_busy`) or killed.
 */
export function paneShowsAgent(
  pane: { agent?: string },
  name: string,
  kind: string,
): boolean {
  return pane.agent === name || pane.agent === kind;
}

/**
 * Is the named agent registered in the pane we started?
 * `null` means Herdr could not tell (both the agent lookup and the pane
 * inventory failed), which must not be mistaken for a confirmed miss.
 */
async function agentRegistrationState(
  name: string,
  surface: string,
  kind: string,
): Promise<boolean | null> {
  const info = await getAgentStateAsync(name).catch(() => null);
  if (info) return !info.paneId || info.paneId === surface;
  const panes = await listPanesAsync().catch(() => null);
  if (panes === null) return null;
  return panes.some((pane) => pane.paneId === surface && paneShowsAgent(pane, name, kind));
}

/**
 * Start an agent, retrying once for a pane whose shell is not ready yet.
 * Accepts a trust prompt through the pane (the agent is not registered yet,
 * so agent-targeted keys would be rejected).
 *
 * Herdr's `agent start --timeout` bounds its readiness wait; the child may
 * still come up just after that timeout. Treat a registered agent as success
 * before retrying, otherwise a duplicate start/fallback types the launch
 * command into a live agent.
 */
async function startAgentWithReadiness(
  name: string,
  kind: CanonicalRunner,
  surface: string,
  args: string[],
  timeoutMs = AGENT_START_TIMEOUT_MS,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < AGENT_START_ATTEMPTS; attempt++) {
    let startError: unknown = null;
    try {
      await startAgentAsync(name, kind, surface, {
        args,
        timeoutMs,
      });
    } catch (err) {
      startError = err;
    }

    // Herdr may report a readiness timeout (or an empty response) after the
    // agent has already come up. Registration is the ground truth, but an
    // unreadable inventory is not a miss: a start command that reported success
    // is trusted through an unknown inventory, and a failed one is only
    // treated as success when registration is confirmed.
    const registration = await agentRegistrationState(name, surface, kind);
    if (startError) {
      if (registration === true) return;
      const message = startError instanceof Error ? startError.message : String(startError);
      // A readiness timeout means Herdr *accepted* the start but its probe
      // timed out. If the pane inventory is also unreadable, do not retry or
      // kill a possibly live agent; the prompt/result path will surface a real
      // failure. (A confirmed miss still retries.)
      if (registration === null && /timed out|timeout/i.test(message)) {
        return;
      }
      lastError = startError;
      // Argument/shape/busy errors are deterministic; retrying cannot fix them.
      if (/invalid_agent_argument|unknown option|invalid .*argument|agent_pane_busy/i.test(message)) {
        throw startError;
      }
    } else {
      if (registration !== false) return;
      lastError = new Error(
        `herdr agent start ${name}: agent was not registered in pane ${surface}`,
      );
    }

    const screen = await readScreenAsync(surface, 20).catch(() => "");
    if (/trust/i.test(screen)) {
      try {
        sendPaneKeys(surface, ["enter"]);
      } catch {
        // The pane may already be gone; the retry will report it.
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
      continue;
    }
    if (attempt + 1 < AGENT_START_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Create the subagent pane according to `PI_SUBAGENT_LAYOUT`. */
export async function createSubagentSurface(
  displayName: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const mode = resolveSubagentLayout();
  if (mode === "tab") {
    return createSurfaceAsync(displayName, { cwd, env, layout: "tab" });
  }
  if (mode === "down") {
    return createSurfaceAsync(displayName, {
      cwd,
      env,
      layout: "down",
      fromSurface: currentPaneId() ?? undefined,
    });
  }
  if (mode === "smart") {
    const caller = currentPaneId();
    const layout = await getTabLayoutAsync(caller);
    const panes = layout?.panes ?? [];
    // Drop panes that no longer exist so a stale id cannot become the target.
    for (const id of [...trackedSurfaces]) {
      if (!panes.some((pane) => pane.paneId === id)) trackedSurfaces.delete(id);
    }
    const choice = chooseSplitTarget(caller, panes, trackedSurfaces);
    const surface = await createSurfaceAsync(displayName, {
      cwd,
      env,
      layout: choice.direction,
      fromSurface: choice.target ?? undefined,
    });
    trackedSurfaces.add(surface);
    return surface;
  }
  // Default: preserve the historical right split, anchored to the caller.
  return createSurfaceAsync(displayName, {
    cwd,
    env,
    layout: "right",
    fromSurface: currentPaneId() ?? undefined,
  });
}

export interface AgentStartInput {
  /** Herdr agent name (already sanitized). */
  name: string;
  kind: CanonicalRunner;
  surface: string;
  startArgs: string[];
  prompt: string;
  /** Override `herdr agent start --timeout` (Agy needs longer). */
  startTimeoutMs?: number;
  /** Deadline for the named agent to report idle/working before prompting. */
  readyTimeoutMs?: number;
}

/**
 * Start a non-Pi runner and deliver its first prompt. Returns the native
 * session id Herdr reported, when available.
 *
 * A failed agent start is fatal. Never type the task into the pane's shell:
 * that is how a failed Claude/Codex spawn turned into a runaway shell command
 * on Windows.
 */
export async function startAgentOnSurface(input: AgentStartInput): Promise<string | undefined> {
  const startTimeoutMs = input.startTimeoutMs ?? AGENT_START_TIMEOUT_MS;
  const readyTimeoutMs = input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  await startAgentWithReadiness(
    input.name,
    input.kind,
    input.surface,
    input.startArgs,
    startTimeoutMs,
  );

  let capturedSessionId: string | undefined;
  let lastState: string | undefined;
  let ready = false;
  const readyDeadline = Date.now() + readyTimeoutMs;

  // Do not prompt until the *named* agent reports idle/working. `agent start`
  // may return on a Herdr readiness timeout, and a slow CLI (Agy) can still be
  // registering its prompt target at that point.
  while (Date.now() < readyDeadline) {
    const state = await getAgentStateAsync(input.name).catch(() => null);
    if (state?.sessionId) capturedSessionId = state.sessionId;
    if (state) {
      lastState = state.state;
      if (state.state === "idle" || state.state === "working") {
        ready = true;
        break;
      }
      if (state.state === "blocked") {
        const screen = await readScreenAsync(input.surface, 15).catch(() => "");
        if (/trust/i.test(screen)) {
          try {
            sendPaneKeys(input.surface, ["enter"]);
          } catch {
            // Retry below; the agent may still become ready.
          }
        }
      }
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  if (!ready) {
    throw new Error(
      `herdr agent ${input.name}: did not become ready within ${readyTimeoutMs}ms ` +
        `(Herdr state: ${lastState ?? "not registered"}).`,
    );
  }

  // The readiness poll usually carries the native id; ask once more when it
  // settled before Herdr reported it. This is the only extra call.
  if (!capturedSessionId) {
    capturedSessionId = (await getAgentStateAsync(input.name).catch(() => null))?.sessionId;
  }

  const promptDeadline = Date.now() + 5_000;
  let trustRetries = 0;
  for (;;) {
    try {
      await promptAgentAsync(input.name, input.prompt);
      break;
    } catch (promptError) {
      // One trust-prompt retry, then fail. Never fall back to `pane run`.
      const screen = await readScreenAsync(input.surface, 15).catch(() => "");
      if (/trust/i.test(screen) && trustRetries < 2) {
        trustRetries += 1;
        sendPaneKeys(input.surface, ["enter"]);
        await new Promise<void>((r) => setTimeout(r, 750));
        continue;
      }
      // The readiness wait can still win a race against Herdr registering the
      // prompt target. Retry briefly, then surface the original failure.
      const message = promptError instanceof Error ? promptError.message : String(promptError);
      if (/agent_not_found/i.test(message) && Date.now() < promptDeadline) {
        await new Promise<void>((r) => setTimeout(r, 500));
        continue;
      }
      throw promptError;
    }
  }

  return capturedSessionId;
}

export interface RunningSubagentInput {
  id: string;
  name: string;
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
  artifactDir?: string;
  launchArgs?: string[];
  cwd?: string;
  sessionId?: string;
  resumeFromLine?: number;
  recordFile?: string;
  turn?: number;
  turnStartTime?: number;
  interactive: boolean;
}

/** Build a live entry with the shared turn/status defaults. */
export function createRunningSubagent(input: RunningSubagentInput): RunningSubagent {
  return {
    ...input,
    turn: input.turn ?? 1,
    turnStartTime: input.turnStartTime ?? input.startTime,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: input.startTime,
    }),
  };
}

export interface LaunchContext {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
  model?: { provider?: string; id?: string } | null;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
export async function launchSubagent(
  params: SpawnParams,
  ctx: LaunchContext,
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
    parentModel: parentModelForRunner(adapter.id, ctx.model) ?? undefined,
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
    parentModel: formatParentModel(ctx.model),
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
  let surface = "";

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
    // Surface creation lives inside the launch try so a failure after the pane
    // exists still cleans it up instead of leaking an orphan.
    surface =
      options?.surface ?? (await createSubagentSurface(displayName, targetCwdForSession, plan.env));
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    }

    let capturedSessionId: string | undefined;

    if (adapter.id === "pi") {
      try {
        await startAgentWithReadiness(herdrAgentName, "pi", surface, plan.startArgs);
      } catch {
        // Last resort for Pi: run the shell command directly. If this also
        // fails, the outer catch closes the pane and reports the error.
        sendLongCommand(surface, plan.fallbackCommand ?? "", {
          scriptPath: launchScriptFile!,
          scriptPreamble: (plan.scriptPreamble ?? []).join("\n"),
        });
      }
    } else {
      capturedSessionId = await startAgentOnSurface({
        name: herdrAgentName,
        kind: adapter.id,
        surface,
        startArgs: plan.startArgs,
        prompt: plan.prompt ?? params.task,
        startTimeoutMs: startTimeoutFor(adapter.id),
        readyTimeoutMs: readyTimeoutFor(adapter.id),
      });
    }

    const running = createRunningSubagent({
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
      artifactDir,
      launchArgs: adapter.id !== "pi" ? plan.startArgs : undefined,
      cwd: targetCwdForSession,
      sessionId: capturedSessionId,
      recordFile: plan.recordFile,
      interactive: effectiveInteractive,
    });

    runningSubagents.set(id, running);
    return running;
  } catch (err) {
    if (surface && !surfacePreCreated) {
      terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    }
    throw err;
  }
}

export type ResumeErrorCode =
  | "unsupported"
  | "already_running"
  | "session_gone"
  | "no_loadout"
  | "no_session_id"
  | "no_launch_args"
  | "plan_failed"
  | "leftover_pane"
  | "start_failed";

export type ResumeOutcome =
  | { ok: true; running: RunningSubagent; mode: "shell" | "agent" }
  | { ok: false; code: ResumeErrorCode; error: string };

export interface ResumeInput {
  name: string;
  message: string;
  parentSessionId: string;
  /** The spawner session's artifact dir (registry + resume message files). */
  artifactDir: string;
  entry: NameRegistryEntry;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resumeError(code: ResumeErrorCode, error: string): ResumeOutcome {
  return { ok: false, code, error };
}

/**
 * Resume a finished subagent by name against its existing native session.
 *
 * The adapter owns the transport (Pi's shell command vs Claude/Agy's Herdr
 * agent). This function owns the guards, the leftover-pane preflight, the new
 * surface/start, and the live-entry registration. The caller starts the
 * watcher.
 */
export async function resumeSubagent(input: ResumeInput): Promise<ResumeOutcome> {
  const { name, message, parentSessionId, artifactDir, entry } = input;
  const runnerId = entry.runner ?? "pi";
  const adapter = getRunner(runnerId);
  if (!adapter) {
    return resumeError("unsupported", `Subagent "${name}" has an unknown runner ("${runnerId}"). Spawn a fresh subagent instead.`);
  }
  if (!adapter.supportsResume || !adapter.buildResume) {
    return resumeError(
      "unsupported",
      `Subagent "${name}" ran with the "${runnerId}" CLI, which cannot be resumed. Spawn a fresh subagent instead.`,
    );
  }

  const isPi = adapter.id === "pi";

  // Never run two processes against one native session.
  const sameSession = Array.from(runningSubagents.values()).find((running) => {
    if (isPi) {
      return (
        running.cli === "pi" &&
        !!running.sessionFile &&
        !!entry.sessionFile &&
        resolve(running.sessionFile) === resolve(entry.sessionFile)
      );
    }
    return (
      running.cli === adapter.id &&
      !!entry.sessionId &&
      running.sessionId === entry.sessionId
    );
  });
  if (sameSession) {
    return resumeError(
      "already_running",
      `Subagent "${name}" is still running as "${sameSession.name}". Your message will steer it; resend as a steer.`,
    );
  }

  const startedAt = Date.now();
  const id = Math.random().toString(16).slice(2, 10);
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  let loadout: SubagentLoadout | null = null;
  let sessionId: string | null = entry.sessionId;
  let resumeFromLine: number | undefined;
  let messageFile: string | null = null;

  if (isPi) {
    if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
      return resumeError(
        "session_gone",
        `Subagent "${name}" is registered but its session file is gone (${entry.sessionFile}). It cannot be resumed. Spawn a fresh subagent instead.`,
      );
    }
    loadout = readSubagentLoadout(entry.sessionFile);
    if (!loadout) {
      return resumeError(
        "no_loadout",
        `Cannot safely resume "${name}": no sandbox snapshot found for this session ` +
          `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
          `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
          `Re-run the task as a fresh subagent instead.`,
      );
    }
    resumeFromLine = countSessionEntryLines(entry.sessionFile);
    if (message) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      messageFile = join(
        artifactDir,
        "subagent-resume",
        `${slug(name) || "resume"}-${timestamp}.md`,
      );
      mkdirSync(dirname(messageFile), { recursive: true });
      writeFileSync(messageFile, message, "utf8");
    }
  } else {
    // Recover a late id from Herdr before refusing.
    const liveState = entry.herdrAgentName
      ? await getAgentStateAsync(entry.herdrAgentName).catch(() => null)
      : null;
    sessionId = entry.sessionId ?? liveState?.sessionId ?? null;
    if (!sessionId) {
      return resumeError(
        "no_session_id",
        `Subagent "${name}" has no recorded ${adapter.label} session id, so it cannot be resumed. ` +
          `The id was not captured while its pane was open. Spawn a fresh subagent instead.`,
      );
    }
    if (!entry.launchArgs || entry.launchArgs.length === 0) {
      return resumeError(
        "no_launch_args",
        `Subagent "${name}" has no recorded launch arguments, so its model and identity ` +
          `cannot be replayed safely. Spawn a fresh subagent instead.`,
      );
    }
  }

  const cwd = isPi ? (loadout?.cwd ?? process.cwd()) : (entry.cwd ?? process.cwd());
  const context: RunnerResumeContext = {
    platform: process.platform,
    sessionFile: entry.sessionFile,
    sessionId,
    launchArgs: isPi ? null : entry.launchArgs,
    name,
    id,
    message,
    messageFile,
    loadout,
    autoExit: resolveResumeLaunchBehavior().autoExit,
    agentDir: loadout?.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
    spawnable: loadout?.spawnable ?? null,
    cwd: isPi ? (loadout?.cwd ?? null) : (entry.cwd ?? null),
    artifactDir,
    activityFile,
    subagentDonePath: join(SUBAGENTS_DIR, "subagent-done.ts"),
  };

  const plan = adapter.buildResume(context);
  if (!plan) {
    return resumeError(
      "plan_failed",
      `Cannot build a safe resume plan for "${name}" with ${adapter.label}. ` +
        `Spawn a fresh subagent instead.`,
    );
  }

  const herdrAgentName = entry.herdrAgentName ?? sanitizeAgentName(name);

  // Agent mode starts a new Herdr agent with the same name. A leftover pane
  // must be closed first, but only when it is confirmed to belong to this
  // subagent; never close a pane another agent now owns.
  if (plan.mode === "agent" && entry.surface) {
    const panes = await listPanesAsync().catch(() => null);
    if (panes === null) {
      return resumeError(
        "leftover_pane",
        `Subagent "${name}" still has a pane at ${entry.surface}, and Herdr could not report ` +
          `whether it is safe to close it. Stop it first with subagent_stop({ name: "${name}" }) and retry.`,
      );
    }
    const pane = panes.find((candidate) => candidate.paneId === entry.surface);
    if (pane) {
      const owned = !pane.agent || paneShowsAgent(pane, herdrAgentName, adapter.id);
      if (owned) {
        const outcome = terminateSurface(entry.surface, { agentName: herdrAgentName, closePane: true });
        if (!outcome.ok && !outcome.paneClosed) {
          return resumeError(
            "leftover_pane",
            `Subagent "${name}" still has a live agent or pane that could not be closed (${entry.surface}). ` +
              `Stop it first with subagent_stop({ name: "${name}" }) and retry.`,
          );
        }
      }
    }
  }

  let surface: string;
  try {
    surface = await createSubagentSurface(name, cwd, plan.env ?? {});
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  } catch (err: any) {
    return resumeError(
      "start_failed",
      `Failed to create a pane to resume "${name}": ${err?.message ?? String(err)}`,
    );
  }

  let capturedSessionId: string | undefined;
  let launchScriptFile: string | undefined;

  try {
    if (plan.mode === "shell") {
      const ext = process.platform === "win32" ? "ps1" : "sh";
      launchScriptFile = join(
        artifactDir,
        "subagent-scripts",
        `${slug(name) || "resume"}-resume-${Date.now()}.${ext}`,
      );
      sendLongCommand(surface, plan.command, {
        scriptPath: launchScriptFile,
        scriptPreamble:
          plan.scriptPreamble?.join("\n") ??
          [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${entry.sessionFile}`,
            `# Surface: ${surface}`,
            ...(messageFile ? [`# Resume message file: ${messageFile}`] : []),
          ].join("\n"),
      });
    } else {
      capturedSessionId = await startAgentOnSurface({
        name: herdrAgentName,
        kind: adapter.id,
        surface,
        startArgs: plan.startArgs,
        prompt: plan.prompt ?? message,
        startTimeoutMs: startTimeoutFor(adapter.id),
        readyTimeoutMs: readyTimeoutFor(adapter.id),
      });
    }
  } catch (err: any) {
    terminateSurface(surface, { agentName: herdrAgentName, closePane: true });
    const reason = err?.message ?? String(err);
    if (/agent_pane_busy/i.test(reason)) {
      return resumeError(
        "leftover_pane",
        `Subagent "${name}" still has a live agent or pane that could not be closed. ` +
          `Stop it first with subagent_stop({ name: "${name}" }) and retry.`,
      );
    }
    return resumeError(
      "start_failed",
      `Failed to resume "${name}" with ${adapter.label}: ${reason}`,
    );
  }

  // Match the pre-refactor Pi resume fallback: header id, then the display
  // name. Non-Pi uses the captured/recorded native id.
  const effectiveSessionId =
    plan.mode === "agent"
      ? (capturedSessionId ?? sessionId ?? undefined)
      : (entry.sessionId ?? getSessionId(entry.sessionFile) ?? name);

  const running = createRunningSubagent({
    id,
    name,
    parentSessionId,
    herdrAgentName,
    task: message,
    cli: adapter.id,
    surface,
    startTime: startedAt,
    sessionFile: entry.sessionFile,
    launchScriptFile,
    activityFile,
    artifactDir,
    launchArgs: isPi ? undefined : (entry.launchArgs ?? undefined),
    cwd: plan.cwd ?? loadout?.cwd ?? undefined,
    sessionId: effectiveSessionId,
    resumeFromLine,
    interactive: false,
  });

  runningSubagents.set(id, running);
  // Keep the persistent handle current without replacing launchArgs.
  persistRunning(running, {
    patch: {
      surface,
      herdrAgentName,
      ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
      ...(running.cwd ? { cwd: running.cwd } : {}),
    },
  });

  return { ok: true, running, mode: plan.mode };
}
