# pi-interactive-subagent (`interactive-subagents`)

Async subagents for Pi running in Herdr panes across Windows and POSIX (`pi`, `agy`, `claude`, `codex`, `grok`, `opencode`). Upstream fork of `amosblomqvist/pi-interactive-subagents`; preserve existing source layout (`pi-extension/`, `test/`, `agents/`).

## Required Reading

Read [GLOSSARY.md](GLOSSARY.md) and `docs/adr/` before changing lifecycle, monitor, delivery, or resume behavior.

## Commands (`pnpm`)

```bash
pnpm install
pnpm test                 # Unit tests (node --test)
pnpm run test:integration # Integration tests (sequential)
pnpm run typecheck
```

## Invariants

- **Single poller:** The async 1 Hz monitor is the only production polling loop; completion controllers are pure reducers with no I/O or timers.
- **Signals:** Sidecar files (`.exit`, `.parked`, `.ask`) are freshness-bound to a turn, written atomically, and consumed once.
- **Delivery:** Steer each turn's result or error back to the parent at most once per turn.
