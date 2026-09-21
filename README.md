# interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in **Herdr** multiplexer panes across Windows and POSIX. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

Supports multiple coding agent runners:
- **Pi (`pi`)** (default, with role profiles and sandbox allowlists)
- **Antigravity CLI (`agy`)**
- **Claude Code (`claude`)**
- **OpenAI Codex (`codex` / `openai-codex`)**
- **Grok CLI (`grok` / `grok-cli`)**
- **OpenCode (`opencode` / `open_code`)**

## How it works

`subagent()` returns immediately. The sub-agent runs in its own Herdr pane — a right split off the parent pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  agy        waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated Herdr pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions and supported CLI runners |
| `ask_question` | *(Pi sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent|cli> <task>` command for spawning directly.

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
| `name` | string | agent/runner | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | caller cwd | Working directory for the sub-agent |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is delivered directly into the live agent session via Herdr's prompt API. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later.

### ask_question

A Pi sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn.

## Supported CLI Runners

- **`pi`**: The native Pi coding agent. Supports tool sandboxing, system prompt modes, auto-exit, and `ask_question`.
- **`agy`**: Google Antigravity CLI. Runs in a dedicated Herdr pane with native lifecycle tracking.
- **`claude`**: Anthropic Claude Code CLI. Runs with `--dangerously-skip-permissions`.
- **`codex`**: OpenAI Codex CLI. Automatically integrates with Herdr's Windows bracketed-paste boundary handling.
- **`grok`**: xAI Grok CLI.
- **`opencode`**: OpenCode CLI.

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
cli: pi
---

You are a specialized agent that does X...
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [herdr](https://herdr.dev) (`HERDR_ENV=1`)

Start pi inside a Herdr-managed pane or workspace.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) and [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).

## License

MIT
