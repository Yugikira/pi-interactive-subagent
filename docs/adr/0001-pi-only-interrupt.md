# ADR-0001: `subagent_interrupt` is Pi-only

## Status

Accepted (2026-10-26).

## Context

`subagent_message` steers a running subagent by typing into its live pane. That cannot stop a
turn that is already heading in the wrong direction; the orchestrator needs a way to abort the
current turn without destroying the pane, session, or watcher.

An earlier version of this extension had a `subagent_interrupt` tool, but it was removed when
steering landed and the tests were changed to assert it stayed absent. The upstream
`0xRichardH/pi-herdr-subagents` re-introduced a Pi-only version: send Escape to the active turn,
mark the lifecycle `interrupted`, and keep the pane/session/watcher alive.

## Decision

Add `subagent_interrupt` for the Pi runner only. The adapter exposes
`supportsTurnInterrupt: true`; every other adapter refuses with a clear message. Interrupting:

- sends Escape through `herdr pane send-keys` (falling back to the agent target),
- forces the status projection to `waiting` with the `interrupted` label,
- does not abort the watcher or delete the running entry, and
- does not emit a result solely because of the interrupt.

## Consequences

- A follow-up `subagent_message` continues the same session; the watcher delivers the next
  genuine turn result.
- Non-Pi runners require their own verified interrupt contract before they can opt in.
- The tests that asserted `subagent_interrupt` was absent now assert the Pi-only contract.
