# Adding a Native Session Result Retriever for a CLI Runner

This document outlines how to add native session/transcript extraction support for a new CLI coding agent runner (e.g. `opencode`, `codex`, `grok`, `gemini`, etc.) in `interactive-subagents`.

---

## Overview

When `interactive-subagents` executes a subagent in Herdr, it extracts the final assistant response to steer it back to the parent session.

There are two runner categories in the extension:
1. **Native Session Runners** (`pi`, `agy`, `claude`):
   - Receive clean prompts without any artificial instructions.
   - Outputs are extracted directly from native disk storage / session transcripts (e.g. `transcript_full.jsonl`, `.claude/projects/`).
2. **Protocol Runners** (`opencode`, `codex`, `grok`):
   - Prompts are appended with an `[Output Protocol]` asking the runner to append a JSON line `{"turn": n, "timestamp": ..., "content": "..."}` to `.pi/temp/subagent-records/<name>.jsonl`.

If native reading or protocol reading returns no content, the extension falls back to:
- Claude Stop hook sentinel file (if applicable).
- Herdr terminal capture: `sanitizeTerminalOutput(readAgentOutput(agentName, 1000))` (strips ANSI escapes, spinners, prompt chrome).
- Screen buffer capture: `sanitizeTerminalOutput(readScreen(surface, 1000))`.

---

## 4-Step Guide to Add Native Support for a Runner

Follow these four steps to promote a runner from protocol-based extraction to native session extraction:

### Step 1: Identify Where the Runner Persists Sessions

Inspect the runner's native storage locations on disk:
- Does the runner create JSONL transcripts, JSON session dumps, or SQLite databases?
- Where is the base directory?
  - Common locations: `~/.<runner>/`, `~/.config/<runner>/`, or `%LOCALAPPDATA%/<runner>/`.
- How is the session tied to the running process?
  - **Via Herdr**: If Herdr has an integration hook installed for that runner (e.g. `herdr integration install <runner>`), Herdr tracks `agent_session` in `getAgentState(agentName)`. For example, for `agy`, `agent_session.value` contains the exact conversation ID UUID!
  - **Via Project Directory**: Runners like Claude Code derive a project slug from `cwd` (e.g. `~/.claude/projects/<slug>/<sessionId>.jsonl`).
  - **Via Timestamp / File Scan**: Identify the newest session file modified since `afterTimestamp`.

---

### Step 2: Implement `read<Runner>Session` in `session.ts`

Open `pi-extension/subagents/session.ts` and add your dedicated extraction function:

```typescript
export interface ReadMyRunnerSessionOptions {
  sessionId?: string;
  cwd?: string;
  afterTimestamp?: number;
  baseDir?: string; // allow overriding for testing
}

export function readMyRunnerSession(options: ReadMyRunnerSessionOptions): string | null {
  const baseDir = options.baseDir ?? join(homedir(), ".myrunner", "sessions");
  if (!existsSync(baseDir)) return null;

  // 1. Locate the session file (by sessionId or newest modified since afterTimestamp)
  let sessionFile: string | null = null;
  if (options.sessionId) {
    const candidate = join(baseDir, `${options.sessionId}.jsonl`);
    if (existsSync(candidate)) sessionFile = candidate;
  }
  if (!sessionFile) {
    sessionFile = findNewestSessionFile(baseDir, options.afterTimestamp);
  }
  if (!sessionFile) return null;

  // 2. Parse lines from the bottom up to extract the last assistant turn
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (options.afterTimestamp && item.timestamp && Date.parse(item.timestamp) < options.afterTimestamp) {
          continue;
        }

        // Extract assistant text
        if (item.role === "assistant" && typeof item.content === "string" && item.content.trim()) {
          return item.content.trim();
        }
      } catch {}
    }
  } catch {
    return null;
  }

  return null;
}
```

Key points to handle:
- **`afterTimestamp`**: Always filter or check that entries were created during or after the current turn to support multi-turn steering (`subagent_message`).
- **Error States**: If the entry has a failure or error stop reason (e.g., `stopReason: "error"` or `status: "ERROR"`), return `Subagent error: ${errorMessage}`.

---

### Step 3: Register in `NATIVE_SESSION_RUNNERS` and `readRunnerSession`

In `pi-extension/subagents/session.ts`:

1. Add your runner to `NATIVE_SESSION_RUNNERS`:
   ```typescript
   export const NATIVE_SESSION_RUNNERS = new Set<string>([
     "pi",
     "agy",
     "claude",
     "myrunner", // <-- Added
   ]);
   ```

2. Add a `case` in `readRunnerSession`:
   ```typescript
   export function readRunnerSession(options: ReadRunnerSessionOptions): string | null {
     const runner = options.runner.toLowerCase();
     switch (runner) {
       case "pi":
         return options.sessionFile ? readPiSession(options.sessionFile, options.afterLine) : null;
       case "agy":
         return readAgySession({ ... });
       case "claude":
         return readClaudeSession({ ... });
       case "myrunner": // <-- Added
         return readMyRunnerSession({
           sessionId: options.sessionId,
           cwd: options.cwd,
           afterTimestamp: options.afterTimestamp,
         });
       default:
         return null;
     }
   }
   ```

Because `isNativeSessionRunner(runner)` checks `NATIVE_SESSION_RUNNERS`:
- `launchSubagent` automatically stops injecting `formatNonPiPrompt`.
- `steerSubagent` automatically sends clean messages.
- `watchSubagent` automatically routes to `readRunnerSession`.

---

### Step 4: Add Unit Tests in `test/test.ts`

Add test coverage for your new reader using a temporary fixture directory:

```typescript
describe("readMyRunnerSession", () => {
  it("extracts the last assistant response from native session", () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "session-1.jsonl");
    const lines = [
      JSON.stringify({ role: "user", content: "hello" }),
      JSON.stringify({ role: "assistant", content: "Here is the final result." }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

    const result = readMyRunnerSession({ baseDir: dir, sessionId: "session-1" });
    assert.equal(result, "Here is the final result.");
  });

  it("filters out older turns using afterTimestamp", () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "session-1.jsonl");
    const lines = [
      JSON.stringify({ timestamp: "2026-09-18T10:00:00Z", role: "assistant", content: "Old response" }),
      JSON.stringify({ timestamp: "2026-09-18T11:00:00Z", role: "assistant", content: "New response" }),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

    const afterTime = Date.parse("2026-09-18T10:30:00Z");
    const result = readMyRunnerSession({ baseDir: dir, sessionId: "session-1", afterTimestamp: afterTime });
    assert.equal(result, "New response");
  });
});
```

Run tests to ensure everything passes:
```bash
npm test
```

---

## Existing Implementations Reference

- **`agy` (Antigravity CLI)**: `readAgySession` in `session.ts`.
  Reads from `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`.
- **`claude` (Claude Code)**: `readClaudeSession` in `session.ts`.
  Reads from `~/.claude/projects/<slug>/<sessionId>.jsonl` with `on-stop.sh` sentinel file fast path.
- **`pi` (Pi Coding Agent)**: `readPiSession` in `session.ts`.
  Reads from Pi's native session JSONL using `findLastAssistantMessage`.
