# ADR-0002: `status.ts` remains the projection; completion is a separate seam

## Status

Accepted (2026-10-26).

## Context

The upstream `0xRichardH/pi-herdr-subagents` models process and turn state in a single pure
`lifecycle.ts` FSM (`starting`/`running`/`finalizing`/`completed`/`failed`, plus turn states).
This repository already has `status.ts`, a well-tested pure projection state machine that maps
activity snapshots and pane observations to the widget's labels and stall transitions.

Porting the upstream FSM wholesale would duplicate the projection logic, replace 60+ passing
tests, and couple UI presentation to completion bookkeeping.

## Decision

- `status.ts` stays the **projection authority**: it answers "what should the widget show?"
- `completion.ts` is a separate pure reducer that answers "is this turn over?" and is fed by the
  monitor. It owns sidecar freshness, idle settling, pane-loss grace, and the stall policy.
- `monitor.ts` is the sole poller and the only module that performs observation I/O.
- The upstream lifecycle FSM is not ported. The upstream capability flags and two-tier
  observation model are adopted behind our existing seams.

## Consequences

- Status formatting tests survive unchanged (except the deliberate stale-active fix).
- Completion can be tested as a table of observations without Herdr.
- A future process-level FSM can be introduced inside `completion.ts` without touching the
  projection.
