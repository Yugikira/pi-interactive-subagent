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
- `buildResume` is optional and currently only implemented by Pi. Set `supportsResume: false` for
  everything else; `subagent_message` will return a clear error instead of relaunching the wrong
  CLI.
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
