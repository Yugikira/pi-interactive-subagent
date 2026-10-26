# interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in **Herdr** panes across
Windows and POSIX. Spawn a sub-agent, keep working in the main session, and get the result steered
back when it finishes. Fully non-blocking.

## Installation

```bash
pi install git:github.com/Yugikira/pi-interactive-subagent
```

Requirements:

- [pi](https://github.com/badlogic/pi-mono) (Node >= 22.19)
- [herdr](https://herdr.dev), with `pi` started inside a Herdr-managed pane (`HERDR_ENV=1`)

## How it works

`subagent()` returns immediately. The sub-agent runs in its own Herdr pane. A live widget above
the input tracks every running sub-agent, and when one finishes, its result is steered into the
main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  agy        waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each
finishes. A single async monitor polls pane state and activity once per second; it does not block
the Pi UI.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise
the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated Herdr pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its Pi session if finished |
| `subagent_interrupt` | Send Escape to the active **Pi** turn without closing the pane or session |
| `subagent_stop` | Stop a running sub-agent and close its pane (optionally keep the pane with `closePane: false`) |
| `subagents_list` | List available agent definitions and supported CLI runners |
| `ask_question` | *(Pi sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

Commands: `/subagent <agent|cli> <task>`, `/subagent stop [name]`, `/subagent status`,
`/subagent:stop [name|all]`, `/subagents`.

### Spawning

```typescript
// Spawn a Pi role-based agent
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });

// Spawn an alternate runner (Antigravity, Claude Code, OpenAI Codex, Grok, OpenCode)
subagent({ cli: "agy", task: "List git status and diagnose issues" });
subagent({ cli: "claude", task: "Review this pull request diff" });
subagent({ cli: "codex", task: "Refactor database query optimization" });
subagent({ cli: "grok", task: "Explain the architecture of this project" });
subagent({ cli: "opencode", task: "Scan package dependencies" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `task` | string | required | Task prompt |
| `agent` | string | optional | Role profile to load (e.g. `worker`, `scout`, `researcher`). Optional if `cli` is provided |
| `cli` | string | `pi` | CLI runner to execute: `pi`, `agy`, `claude`, `codex` (`openai-codex`), `grok` (`grok-cli`), `opencode` |
| `name` | string | agent/runner | Display name for the pane and widget. Names are unique per session — a collision is auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | resolved (below) | Override the model for this spawn |
| `cwd` | string | caller cwd | Working directory for the sub-agent |
| `keepOpen` | boolean | `false` | Keep the pane open after the task completes. For `pi` this also suppresses the child's auto-exit, so the session stays alive and steerable; each turn's result is still delivered automatically |

### Model resolution

The bundled agents are provider-neutral. A model is resolved once per spawn, in this order:

1. explicit `subagent({ model })`
2. the agent's frontmatter `model:`
3. `models.agents.<name>` in `config.json`
4. `PI_SUBAGENT_DEFAULT_MODEL`
5. `models.default` in `config.json`
6. the parent session's active model
7. none — the child uses Pi's own configured default

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after
a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is delivered directly into the live agent session via Herdr's prompt API. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished (Pi only)** — the session is resumed with the message as the follow-up task, fire-and-forget. Non-Pi sessions cannot be resumed; spawn a fresh sub-agent instead.

### Interrupting and stopping

`subagent_interrupt({ name })` sends Escape to the active turn of a **Pi** sub-agent. The pane,
session, and watcher stay alive, so you can follow up with `subagent_message` or close it with
`subagent_stop`. Other CLIs do not expose a verified turn-interrupt contract.

`subagent_stop({ name, closePane })` aborts the watcher, terminates the child process, and closes
the pane. A stop that cannot be verified is reported as a failure rather than a success.

### ask_question

A Pi sub-agent can ask its orchestrator a single freeform question when requirements are
ambiguous or a decision materially affects the work. The session **stays open** (parked as
`waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via
`subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn.

## Supported CLI runners

| Runner | Session read | `keepOpen` | `subagent_interrupt` | Resume |
| --- | --- | --- | --- | --- |
| `pi` | native JSONL + activity | yes | yes | yes |
| `agy` | native transcript | yes | no | no |
| `claude` | native transcript | yes | no | no |
| `codex` | JSON output protocol | yes | no | no |
| `grok` | JSON output protocol | yes | no | no |
| `opencode` | JSON output protocol | yes | no | no |

The `model` override is applied to `pi`, `claude`, and `agy`. Protocol runners receive the task
text only; set their model in the CLI's own configuration.

## Layout

Sub-agents split off the caller's pane to the right by default. Control it with
`PI_SUBAGENT_LAYOUT`:

| Value | Behavior |
| --- | --- |
| *(unset)* / `right` / `split:right` | Right split off the caller (default) |
| `split` | Smart tiling: split the largest pane in the caller's tab, along its long dimension |
| `split:down` / `down` | Split below the caller |
| `tab` | Give each sub-agent its own Herdr tab |

## Configuration

`config.json` lives at the package root (or wherever `PI_SUBAGENT_CONFIG` points), falling back
to `config.json.example`:

```json
{
  "status": {
    "enabled": true,
    "lineLimit": 4
  },
  "models": {
    "default": "provider/model",
    "agents": {
      "scout": "provider/scout-model"
    }
  }
}
```

`status.enabled: false` hides the status widget labels and transition messages; the monitor still
runs because completion delivery depends on it. `status.lineLimit` caps how many transition lines
are shown at once.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery
priority: **project > global > package-bundled**.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
subagent_agents: scout, researcher
session-mode: lineage-only
auto-exit: true
interactive: false
system-prompt: append
skill: code-review
cli: pi
---

You are a specialized agent that does X...
```

`subagent_agents` grants the child the spawning toolset and restricts it to that list.
`disable-model-invocation: true` hides the profile from `subagents_list` while keeping it
directly loadable.

## Development

```bash
npm test             # unit tests (no Herdr or LLM required)
npm run typecheck    # tsc --noEmit
npm run test:integration   # real Herdr panes + LLM calls; opt-in
```

Bug reports and design notes live under `bug_report/` (gitignored) and `docs/`.
See [`docs/adding-a-runner.md`](docs/adding-a-runner.md) for the adapter workflow and
[`GLOSSARY.md`](GLOSSARY.md) for the shared vocabulary.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
and [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).

## License

MIT
