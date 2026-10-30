/**
 * Scripted stand-in for the Herdr CLI.
 *
 * The suite may itself run inside a Herdr pane, where `HERDR_ENV=1` makes the
 * real CLI reachable. Every test that exercises launch/stop/monitor paths
 * installs this fake through `setHerdrExecDeps`, so nothing touches the
 * developer's real panes.
 *
 * Unknown verbs throw `invalid_request`; that is deliberate. A test that
 * reaches a Herdr path the fake does not model should fail loudly rather than
 * silently observe an empty world.
 */
import { setHerdrExecDeps } from "../pi-extension/subagents/herdr.ts";

export interface FakePane {
  /** `herdr pane close` rejects for this pane. */
  closeFails?: boolean;
  /** Agent registered in this pane, as `pane list` would report it. */
  agent?: string;
  /** Runner kind reported by `agent start` (defaults to the agent name). */
  agentStatus?: string;
  /** Native session id exposed as `agent_session.value`. */
  sessionId?: string;
}

export interface FakeAgent {
  name: string;
  kind: string;
  paneId: string;
  status: string;
  sessionId: string;
}

export interface FakeHerdrOptions {
  paneListFailsTimes?: number;
  keyWriteFails?: boolean;
  /** Legacy allowlist for `agent send-keys` targets not registered via start. */
  agentNames?: string[];
  /** Deterministic native session ids keyed by Herdr agent name. */
  agentSessionIds?: Record<string, string>;
  /** Default agent status reported by `agent get` / `pane list`. */
  agentStatus?: string;
  /** Make every `agent start` fail (for failure-path tests). */
  startFails?: boolean;
  /** Scripted pane screen output keyed by pane ID or function. */
  paneOutput?: Record<string, string> | ((paneId: string) => string);
  /** Scripted agent terminal output keyed by target or function. */
  agentOutput?: Record<string, string> | ((target: string) => string);
}

export function herdrError(code: string, message: string): string {
  return `Command failed: herdr\n{"error":{"code":"${code}","message":"${message}"}}`;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function createFakeHerdr(
  initial: Record<string, FakePane>,
  options?: FakeHerdrOptions,
) {
  const panes = new Map<string, FakePane>(Object.entries(initial));
  const agents = new Map<string, FakeAgent>();
  const extraAgentNames = new Set(options?.agentNames ?? []);
  const calls: string[][] = [];
  const keyWrites: string[][] = [];
  const prompts: Array<{ target: string; text: string }> = [];
  const runCommands: Array<{ paneId: string; command: string }> = [];
  let paneListFailures = options?.paneListFailsTimes ?? 0;
  let splitCounter = 0;

  // Seed agents for panes that already carry a native session id.
  for (const [paneId, pane] of panes) {
    if (pane.agent && pane.sessionId) {
      agents.set(pane.agent, {
        name: pane.agent,
        kind: pane.agent,
        paneId,
        status: pane.agentStatus ?? options?.agentStatus ?? "idle",
        sessionId: pane.sessionId,
      });
    }
  }

  const run = (args: string[]): string => {
    calls.push(args);
    const [group, verb] = args;

    // The authoritative inventory. A failure here must surface as "cannot
    // tell" — never as "the pane is gone".
    if (group === "pane" && verb === "list") {
      if (paneListFailures > 0) {
        paneListFailures -= 1;
        throw new Error(herdrError("internal_error", "pane inventory unavailable"));
      }
      return JSON.stringify({
        result: {
          panes: Array.from(panes.entries()).map(([paneId, pane]) => ({
            pane_id: paneId,
            ...(pane.agent ? { agent: pane.agent } : {}),
            ...(pane.agent
              ? { agent_status: pane.agentStatus ?? options?.agentStatus ?? "idle" }
              : {}),
            ...(pane.sessionId ? { agent_session: { value: pane.sessionId } } : {}),
          })),
        },
      });
    }

    if (group === "pane" && verb === "current") {
      return JSON.stringify({
        result: { pane: { pane_id: process.env.HERDR_PANE_ID ?? "caller-pane" } },
      });
    }

    if (group === "pane" && verb === "split") {
      splitCounter += 1;
      const paneId = `pane-split-${splitCounter}`;
      panes.set(paneId, {});
      return JSON.stringify({ result: { pane: { pane_id: paneId } } });
    }

    if (group === "tab" && verb === "create") {
      splitCounter += 1;
      const paneId = `pane-tab-${splitCounter}`;
      panes.set(paneId, {});
      return JSON.stringify({ result: { root_pane: { pane_id: paneId } } });
    }

    if (group === "pane" && verb === "close") {
      const paneId = args[2];
      const pane = panes.get(paneId);
      if (!pane) throw new Error(herdrError("pane_not_found", `pane ${paneId} not found`));
      if (pane.closeFails) {
        throw new Error(herdrError("pane_close_failed", `pane ${paneId} could not be closed`));
      }
      panes.delete(paneId);
      for (const [name, agent] of agents) {
        if (agent.paneId === paneId) agents.delete(name);
      }
      return JSON.stringify({ result: {} });
    }

    if (group === "pane" && verb === "run") {
      runCommands.push({ paneId: args[2], command: args[3] ?? "" });
      return JSON.stringify({ result: {} });
    }

    if (group === "pane" && verb === "read") {
      const paneId = args[2];
      if (typeof options?.paneOutput === "function") return options.paneOutput(paneId);
      if (options?.paneOutput && typeof options.paneOutput === "object") {
        return options.paneOutput[paneId] ?? "";
      }
      return "";
    }

    if (group === "agent" && verb === "read") {
      const target = args[2];
      const agent = agents.get(target);
      const pane = panes.get(target);
      if (!agent && !pane && !extraAgentNames.has(target)) {
        throw new Error(herdrError("agent_not_found", `agent target ${target} not found`));
      }
      if (typeof options?.agentOutput === "function") return options.agentOutput(target);
      if (options?.agentOutput && typeof options.agentOutput === "object") {
        return options.agentOutput[target] ?? "";
      }
      return "";
    }

    if (group === "agent" && verb === "start") {
      const name = args[2];
      const kind = flagValue(args, "--kind") ?? "pi";
      const paneId = flagValue(args, "--pane");
      if (!paneId) throw new Error(herdrError("invalid_request", "missing --pane"));
      const pane = panes.get(paneId);
      if (!pane) throw new Error(herdrError("pane_not_found", `pane ${paneId} not found`));
      if (options?.startFails) {
        throw new Error(herdrError("agent_start_failed", `agent ${name} failed to start`));
      }
      const occupying = Array.from(agents.values()).find((agent) => agent.paneId === paneId);
      if (agents.has(name) || occupying) {
        throw new Error(
          herdrError("agent_pane_busy", `pane ${paneId} already has an agent`),
        );
      }
      const sessionId =
        options?.agentSessionIds?.[name] ?? `${name}-session-${splitCounter}-${agents.size}`;
      const status = options?.agentStatus ?? "idle";
      pane.agent = kind;
      pane.agentStatus = status;
      pane.sessionId = sessionId;
      agents.set(name, { name, kind, paneId, status, sessionId });
      return JSON.stringify({ result: {} });
    }

    if (group === "agent" && verb === "prompt") {
      const target = args[2];
      const agent = agents.get(target);
      if (!agent && !extraAgentNames.has(target)) {
        throw new Error(herdrError("agent_not_found", `agent target ${target} not found`));
      }
      prompts.push({ target, text: args[3] ?? "" });
      return JSON.stringify({ result: {} });
    }

    if (group === "agent" && verb === "get") {
      const agent = agents.get(args[2]);
      if (!agent) {
        throw new Error(herdrError("agent_not_found", `agent target ${args[2]} not found`));
      }
      return JSON.stringify({
        result: {
          agent: {
            name: agent.name,
            agent: agent.kind,
            agent_status: agent.status,
            pane_id: agent.paneId,
            agent_session: { value: agent.sessionId },
          },
        },
      });
    }

    if ((group === "agent" || group === "pane") && verb === "send-keys") {
      if (options?.keyWriteFails) {
        throw new Error(herdrError("invalid_key", "unsupported key"));
      }
      if (group === "agent" && !agents.has(args[2]) && !extraAgentNames.has(args[2])) {
        throw new Error(herdrError("agent_not_found", `agent target ${args[2]} not found`));
      }
      keyWrites.push([`${group}:${args[2]}`, ...args.slice(3)]);
      return JSON.stringify({ result: {} });
    }

    throw new Error(herdrError("invalid_request", `unhandled fake call: ${args.join(" ")}`));
  };

  const deps = {
    available: () => true,
    run,
    runAsync: async (args: string[]) => run(args),
  };

  return { panes, agents, calls, keyWrites, prompts, runCommands, deps };
}

/**
 * Install an empty fake Herdr world so a stop is deterministic in any
 * environment: every surface reads as "confirmed absent" rather than depending
 * on whether the suite happens to run inside a real Herdr pane.
 */
export function useEmptyFakeHerdr(): () => void {
  return setHerdrExecDeps(createFakeHerdr({}).deps);
}
