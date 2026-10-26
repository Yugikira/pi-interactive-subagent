/**
 * Which tool names may be granted to a child, and which extension file backs
 * each one.
 *
 * A child launched with `--no-extensions` sees no global tools; the launcher
 * re-enables only the extensions for the whitelisted tools. Built-in Pi tools
 * need no extension. The spawning tools are registered by THIS extension's
 * `index.ts` — the path is explicit because this module is not `index.ts`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentConfigDir } from "./agents.ts";
import { SUBAGENTS_DIR } from "./paths.ts";

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its frontmatter declares a non-empty `subagent_agents`.
 */
export const SPAWNING_TOOLS = [
  "subagent",
  "subagent_message",
  "subagents_list",
] as const;

/** Built-in tools pi provides natively — no extension needs to be loaded. */
export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which simply won't be granted).
 */
export function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // The spawning tools are registered by `pi-extension/subagents/index.ts`.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return join(SUBAGENTS_DIR, "index.ts").replace(/\\/g, "/");
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(extBase, "web-search", "index.ts").replace(/\\/g, "/"),
    web_fetch: join(extBase, "web-fetch", "index.ts").replace(/\\/g, "/"),
    video_extract: join(extBase, "video-extract", "index.ts").replace(/\\/g, "/"),
    youtube_search: join(extBase, "youtube-search", "index.ts").replace(/\\/g, "/"),
    google_image_search: join(extBase, "google-image-search", "index.ts").replace(/\\/g, "/"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts").replace(/\\/g, "/"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool) ?? builtin;
}
