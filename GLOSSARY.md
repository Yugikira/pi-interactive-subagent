# Glossary

Terms used throughout the extension and its docs.

- **Runner** — a coding-agent CLI the extension can launch (`pi`, `agy`, `claude`, `codex`,
  `grok`, `opencode`). A runner's ids, aliases, launch plan, completion policy, and result
  extraction live in one adapter under `pi-extension/subagents/runners/`.
- **Profile** — a Markdown agent definition (`agents/*.md` or a project/global override) with
  frontmatter describing model, tools, prompt, session mode, and whether it may spawn children.
- **Turn** — one task or steered follow-up executed by a running subagent. A kept-open session
  can have many turns; completion is per-turn, not per-process.
- **Signal** (or **sidecar**) — a one-shot file next to a child session (`.exit`, `.parked`,
  `.ask`). Signals are freshness-bound to a turn, written atomically, and consumed exactly once.
- **Monitor** — the single async 1 Hz loop that observes pane state, activity snapshots, signals,
  and questions for every running subagent. It is the only production poller.
- **Completion controller** — a promise fed by the monitor. It owns the per-turn reducer that
  decides done/error/stalled without doing I/O or owning a timer.
- **Lifecycle projection** — `status.ts`'s pure mapping from observations to the widget's
  `active`/`waiting`/`stalled`/`starting` labels.
- **Delivery** — steering a subagent's result or error back to the parent as one message per
  turn. Duplicate delivery is suppressed per turn.
- **Resume** — relaunching a finished subagent against its native session (`pi --session`,
  `claude --resume`, `agy --conversation`). The runner adapter returns a **resume plan** whose
  transport is either `agent` (Herdr `agent start` + `agent prompt`) or `shell` (a command typed
  into the new pane).
- **Name registry** — the persistent per-spawner map from a display name to its runner, native
  session id, cwd, surface, and launch argv. It is the handle that lets `subagent_message` steer a
  live run or resume a finished one after the in-memory entry is gone.
- **Layout** — how a subagent pane is created: a right/down split or a new tab, controlled by
  `PI_SUBAGENT_LAYOUT`.
