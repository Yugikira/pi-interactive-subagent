/** Canonical filesystem locations for the extension. One source of truth. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `pi-extension/subagents`. */
export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the package root (contains `agents/` and `config.json`). */
export const PACKAGE_ROOT = join(SUBAGENTS_DIR, "../..");

/** Artifact directory for one spawner session. */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}
