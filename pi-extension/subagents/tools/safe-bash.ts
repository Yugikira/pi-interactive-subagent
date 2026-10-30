/**
 * Safe bash extension for the worker subagent.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Loaded into a child pi process via `--extension` when an agent's `tools`
 * frontmatter lists `safe_bash`. See CUSTOM_TOOL_EXTENSIONS in ../index.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { posix } from "node:path";

const RM_SEGMENT = /\brm\s+([^;&|\n]+)/g;
const RM_DESTRUCTIVE = /(?:^|\s)(?:-[a-zA-Z]*[rfR][a-zA-Z]*|--recursive|--force)(?=\s|$)/;
const TEMP_ROOT = /^\/(?:tmp|var\/tmp|private\/tmp)\/*$/;
const TEMP_TARGET = /^\/(?:tmp|var\/tmp|private\/tmp)\//;

/** Whether an `rm` argument names a path the guard must protect. */
function isProtectedRmTarget(rawTarget: string): boolean {
	const target = rawTarget.replace(/^['"]+|['"]+$/g, "");
	if (target.startsWith("~")) return true;
	if (!target.startsWith("/")) return false;
	const normalized = posix.normalize(target);
	if (TEMP_ROOT.test(normalized)) return true;
	return !TEMP_TARGET.test(normalized);
}

/** Whether an `rm` invocation is recursive/forced and targets a protected path. */
function rmTouchesProtectedPath(args: string): boolean {
	if (!RM_DESTRUCTIVE.test(args)) return false;
	for (const token of args.trim().split(/\s+/)) {
		if (!token || token.startsWith("-")) continue;
		if (isProtectedRmTarget(token)) return true;
	}
	return false;
}

export const DANGEROUS_PATTERNS = [
	// `rm` needs target-path normalization and long-option handling, so it is
	// checked by rmTouchesProtectedPath() instead of a single regex here.
	/\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
];

export function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const match of normalized.matchAll(RM_SEGMENT)) {
		if (rmTouchesProtectedPath(match[1])) {
			return "Command blocked by safe_bash: recursive/forced rm targeting a protected path";
		}
	}
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Blocks dangerous commands (rm -rf /, sudo, mkfs, etc.).",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			const bashTool = createBashTool(ctx?.cwd ?? process.cwd());
			return bashTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
