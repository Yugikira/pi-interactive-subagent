# ADR-0003: Resume transport is a runner-owned plan; replay is the launch argv

## Status

Accepted (2026-10-27).

## Context

`subagent_message` historically resumed only Pi, by constructing a shell command
(`pi --session <file>`) and typing it into a new pane. Claude Code and Agy also expose native
resume contracts (`claude --resume <session-id>`, `agy --conversation <id>`), and the extension
already reads their native transcripts. Their CLIs are started through Herdr (`agent start` plus
`agent prompt`), not by typing into a shell.

Resume needs facts that spawn did not previously persist: the runner-native session id, the launch
cwd (Claude transcript lookup is cwd-scoped), and the original model/permissions/identity argv.
Herdr exposes the native id as `agent_session.value` on `agent get` and `pane list`.

## Decision

- **One adapter method, two transports.** `buildResume(ctx)` returns a `RunnerResumePlan` union:
  - `{ mode: "agent", startArgs, env, prompt, cwd }` for Claude/Agy, started through
    `startAgentOnSurface` and prompted through Herdr.
  - `{ mode: "shell", command, cwd }` for Pi, preserving its verified command builder and shell
    typing.
  The resume handler switches on `mode`, never on a runner id. Pi's command text and behavior are
  unchanged.
- **Replay is the recorded launch argv.** Non-Pi spawns persist `launchArgs` (the exact argv after
  `herdr agent start ... --`) in the name registry; resume appends `--resume` / `--conversation`
  and replays the rest. This preserves the model, permissions, and Claude's
  `--append-system-prompt-file` identity without a parallel non-Pi loadout schema. `launchArgs` is
  never stored for Pi (its argv contains task text).
- **`sessionId` is the runner-native handle.** Pi's header id, Claude's transcript UUID, and Agy's
  conversation id share the existing registry field. A separate `nativeSessionId` is not
  introduced, and the transcript path is resolved on demand with `getNativeSessionFile`.
- **Three-layer capture.** The spawn readiness poll records the first id, the monitor persists a
  late first sight or change, and the watcher persists the id before result extraction/pane close.
  Missing metadata is a hard “spawn a fresh subagent” error, never a blank relaunch.
- **One delivery path.** `watchAndDeliver` owns the per-turn `claimDelivery`, presentation, and
  `subagent_result` steer for spawn, steer re-arm, and resume.
- **Leftover panes are owned, not assumed.** A resumed agent-mode start closes a leftover pane only
  when the inventory confirms it belongs to the recorded agent (matching either the custom name or
  the runner kind). `agent_pane_busy` is treated as deterministic and is not retried.

## Consequences

- Pi resume behavior is unchanged; a new runner can choose either transport without changing the
  handler.
- Claude's system-prompt snapshot (`--system-prompt-snapshot`, default `on`) records the identity
  from the first request and re-sends it on resume; replaying the identity file remains safe.
- Protocol runners (codex, grok, opencode) remain unresumable until they expose a stable native
  session contract.
- Resume from a different process cwd works because the original cwd is persisted.
