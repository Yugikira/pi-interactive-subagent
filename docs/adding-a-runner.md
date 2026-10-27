# Adding a CLI runner

A runner is now one adapter file plus one registry entry. The rest of the extension — the
`cli` tool schema, launch env, completion policy, and result extraction — reads from the
registry.

## 1. Add the canonical id and aliases

Edit `pi-extension/subagents/runner-kinds.ts`:

```ts
export const RUNNER_KINDS = [/* ... */, "mycli"] as const;

export const RUNNER_ALIASES = {
  // ...
  mycli: "mycli",
  "my-cli": "mycli",
};
```

`runner-kinds.ts` is a leaf module: the Herdr adapter and the runner registry both import it, but
it imports neither.

## 2. Create `pi-extension/subagents/runners/mycli.ts`

Implement `RunnerAdapter` from `runners/types.ts`:

```ts
import { buildCommonEnv } from "./launch-env.ts";
import type { RunnerAdapter } from "./types.ts";

export const mycliAdapter: RunnerAdapter = {
  id: "mycli",
  label: "My CLI",
  aliases: ["my-cli"],

  // How the result is read:
  resultMode: "native",          // or "protocol"
  idleCompletion: "settle",      // "never" for sidecar runners (Pi)
  nativeTranscriptFreshness: true,
  hasActivitySnapshots: false,

  // Capabilities the rest of the extension may rely on:
  supportsTurnInterrupt: false,
  supportsResume: false,
  supportsSessionStats: false,

  buildLaunch(ctx) {
    return {
      startArgs: ctx.model ? ["--model", ctx.model] : [],
      env: buildCommonEnv(ctx),
      prompt: ctx.task,
    };
  },

  extractResult(ctx) {
    // Return { summary } or null. For protocol runners, read the JSON-line
    // record file and return its last valid turn.
    return null;
  },
};
```

### Choosing the result mode

- **`native`** — the CLI writes a transcript you can read (see `session.ts` for the Pi, Agy, and
  Claude readers). Implement `extractResult` by calling the reader. Set
  `nativeTranscriptFreshness: true` if the transcript's mtime is a reliable "still writing"
  signal during idle settling.
- **`protocol`** — no stable reader. Return a per-agent record file from `buildLaunch` and use
  `formatNonPiPrompt` from `runners/protocol.ts`; `extractProtocolResult` handles the read.
  `createProtocolAdapter` is a ready-made factory for this case.

### Completion and keep-open

`idleCompletion: "never"` means Herdr `idle` is never completion; the child must announce turn
end with a one-shot signal (Pi's `.parked`). Use `"settle"` for CLIs whose idle state reliably
means the turn ended.

### Launch, resume, and interrupt

- `buildLaunch` returns raw `startArgs` for `herdr agent start`, the complete pane env from
  `buildCommonEnv`, and either a separate `prompt` or (for Pi) a shell fallback command.
- `buildResume` is optional. It returns a `RunnerResumePlan`, a transport union:
  - `{ mode: "agent", startArgs, env, prompt, cwd }` — register the CLI with Herdr and deliver the
    follow-up through `agent prompt`. Claude uses `["--resume", sessionId, ...launchArgs]`; Agy uses
    `["--conversation", sessionId, ...launchArgs]`. Replaying `launchArgs` preserves the model,
    permissions, and system-prompt-file identity from the original launch.
  - `{ mode: "shell", command, cwd }` — type a complete command into the new pane. Pi keeps its
    verified `--session <file>` path.
  The handler switches on `mode`, never on a runner id. Set `supportsResume: false` for runners with
  no native session contract; `subagent_message` returns a clear error instead of relaunching a
  blank session.
- Resume prerequisites come from the name registry: `sessionId` is the runner-native handle (Pi
  header id, Claude UUID, Agy conversation id), and non-Pi runners also persist `cwd` and
  `launchArgs`. The extension captures the id at spawn, from the monitor's pane inventory, and in
  the watcher before the pane closes; a runner that cannot supply one must refuse.
- `supportsTurnInterrupt: true` requires a verified Escape/interrupt contract. Only Pi sets it.

### Platform quoting

Never build shell strings by hand. Use `shellEscape(value, platform)` from `shell.ts` and the
`renderPiCommand` pattern in `runners/pi.ts`. Spawn and resume must go through the same renderer
so Windows/POSIX quoting cannot drift.

## 3. Register it

Edit `pi-extension/subagents/runners/registry.ts`:

```ts
import { mycliAdapter } from "./mycli.ts";

const ADAPTERS = [/* ... */, mycliAdapter];
```

`describeRunnerChoices()` and the `subagents_list` output update automatically.

## 4. Add tests

In `test/runners.test.ts`:

- Resolve the id and every alias through `getRunner`.
- Assert the launch `startArgs`, the env (`PI_SUBAGENT_ALLOWED`, `PI_CODING_AGENT_DIR`, and
  `PI_SUBAGENT_AUTO_EXIT` correctness), and the result extraction with a fixture.
- If the runner supports resume or interrupt, add a focused test.

## 5. Update the docs

Add a row to the capability matrix in `README.md`. That matrix is the user-facing contract for
which profile fields and control operations each CLI actually honors.
