/**
 * Canonical runner ids and aliases.
 *
 * This is a leaf module so both the Herdr adapter and `runners/registry.ts`
 * can use it without importing each other. The adapters themselves live under
 * `runners/`.
 */
export const RUNNER_KINDS = [
  "pi",
  "agy",
  "claude",
  "codex",
  "grok",
  "opencode",
] as const;

export type CanonicalRunner = (typeof RUNNER_KINDS)[number];

export const RUNNER_ALIASES: Readonly<Record<string, CanonicalRunner>> = {
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
