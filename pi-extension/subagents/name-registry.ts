/**
 * Persistence for a running subagent's name-registry handle.
 *
 * The registry itself lives in `session.ts`/`signals.ts`. This module owns the
 * mapping from a live `RunningSubagent` to its persistent entry, so spawn,
 * resume, the monitor, and the watcher all write the same fields and later
 * patches can never drop fields written earlier (notably `launchArgs`).
 */
import type { RunningSubagent } from "./runtime.ts";
import { getSessionId, registerName, updateNameRegistryEntry } from "./session.ts";
import type { NameRegistryEntry } from "./signals.ts";

function nativeSessionId(running: RunningSubagent): string | null {
  if (running.sessionId !== undefined) return running.sessionId;
  return running.cli === "pi" ? getSessionId(running.sessionFile) : null;
}

/** The fields a live entry contributes to its persistent registry handle. */
export function registryEntryForRunning(
  running: RunningSubagent,
  opts?: { create?: boolean },
): NameRegistryEntry {
  const sessionId = nativeSessionId(running);
  return {
    sessionFile: running.sessionFile,
    sessionId,
    runner: running.cli,
    surface: running.surface,
    herdrAgentName: running.herdrAgentName,
    ...(running.cwd ? { cwd: running.cwd } : {}),
    ...(running.cli !== "pi" && running.launchArgs ? { launchArgs: running.launchArgs } : {}),
  };
}

/**
 * Write the live entry's handle. `create` registers a new name; otherwise the
 * existing entry is merged, preserving any fields the live entry does not own.
 */
export function persistRunning(
  running: RunningSubagent,
  opts?: { create?: boolean; patch?: Partial<NameRegistryEntry> },
): void {
  if (!running.artifactDir) return;

  const entry = { ...registryEntryForRunning(running, opts), ...opts?.patch };

  if (opts?.create) {
    registerName(running.artifactDir, running.name, entry);
    return;
  }

  // A non-create patch must not erase a previously captured native id when the
  // live entry has not learned it yet.
  const patch: Partial<NameRegistryEntry> = { ...entry };
  if (running.sessionId === undefined && running.cli !== "pi") {
    delete patch.sessionId;
  }
  updateNameRegistryEntry(running.artifactDir, running.name, patch);
}
