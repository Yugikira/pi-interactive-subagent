# Changelog

All notable changes to `interactive-subagents` will be documented in this file.

## [3.10.2] - 2026-10-26

### Fixed

- **Spawn → stop → spawn no longer splits the wrong pane.** Right/down splits now anchor to
  the caller's pane (`HERDR_PANE_ID`) instead of Herdr's `--current`. Closing a subagent shifts
  focus, so subsequent spawns could split an unrelated tab.
- **The observation monitor restarts after the last subagent exits.** The ticker stops itself
  when there is nothing to observe but the wrapper object stayed non-null; `ensureMonitorStarted`
  now checks whether it is actually running and recreates it.
- **Stop no longer addresses an unregistered agent.** `terminateSurface` checks the pane
  inventory first and uses pane keys when the expected agent is not registered there, avoiding
  Herdr's `agent target not found` error cascade after a child dies during startup.
- **Agent startup is async and bounded.** `herdr agent start` is now awaited through the async
  seam with a 15s readiness timeout instead of a 30s+ synchronous `execFileSync` block, so a
  failed child reports a clean failure instead of `spawnSync herdr.exe ETIMEDOUT`.

## [3.10.1] - 2026-10-26

### Fixed

- **Third-party model providers survive the child sandbox.** A Pi child launched with
  `--no-extensions` had no `antigravity` (or other extension-installed) provider, so an inherited
  parent model failed with `Model "antigravity/gemini-3.8-flash:low" not found` even though it
  worked in the parent. The launch now discovers the matching provider package under the agent's
  npm/git package directories and re-enables only its extension files alongside the tool sandbox.
- **Windows fallback sentinel always carries an exit code.** When `pi` resolves to a PowerShell
  function or shim, `$LASTEXITCODE` can be unset, producing `__SUBAGENT_DONE_` with no digits and
  hiding the child's result. The script now falls back to `$?` and always emits a numeric code.

## [3.10.0] - 2026-10-26

### Changed

- **Architecture: runner adapters, async monitor, and typed signals.** Runner knowledge is now
  behind one adapter per CLI (`runners/`), with a registry that generates the `cli` schema and
  `subagents_list` output. `herdr.ts` is a pure mux adapter again.
- **One async observation loop.** A single monitor polls pane state, activity, signals, and
  questions once per second with an in-flight guard. It replaces the synchronous status interval
  and the watcher's `onTick`, so the Pi UI is no longer blocked by `execFileSync` on the hot path.
- **Completion is a pure reducer.** Sidecar freshness, idle settling, pane-loss grace, and stall
  policy live in `completion.ts`; the monitor feeds it observations. Stalls notify by default and
  do not settle the turn, so a late result is never lost.
- **Atomic, typed signals.** `.exit`, `.parked`, `.ask`, loadouts, and the name registry share
  `signals.ts` (temp+rename writes, validate-before-consume, bounded poison-file reaping).
- **Model resolution.** Bundled agents are provider-neutral. Precedence: explicit > frontmatter >
  `models.agents.<name>` > `PI_SUBAGENT_DEFAULT_MODEL` > `models.default` > parent model.
- **Config.** One lazily loaded `config.json` (`PI_SUBAGENT_CONFIG` supported) with `status` and
  `models`; `status.lineLimit` is now honored.
- **Pane layout.** `PI_SUBAGENT_LAYOUT` supports `right` (default), `split` (smart tiling),
  `split:down`, and `tab`.

### Added

- **`subagent_interrupt` (Pi only):** send Escape to the active turn without closing the pane or
  session. See `docs/adr/0001-pi-only-interrupt.md`.
- **Pi session resume by name** is explicitly Pi-only; other runners return a clear error.
- **`npm run typecheck`** and a shared `tsconfig.json`.
- **`GLOSSARY.md`** and ADRs under `docs/adr/`.

### Fixed

- `keepOpen` no longer auto-exits the Pi child: `PI_SUBAGENT_AUTO_EXIT` follows the effective
  (keepOpen-aware) value.
- `PI_SUBAGENT_ALLOWED` and `PI_CODING_AGENT_DIR` are now present on the normal `startAgent`
  path, so nested-spawn restrictions and the resolved agent dir are not lost.
- Stale `active` activity snapshots now age into `stalled` after 60 s instead of showing
  `active` forever.
- Consumers validate a signal before deleting it; a partial write is retried, not lost.
- `session_shutdown` only clears the subagents spawned by that session, and name-based control
  operations are scoped to the calling session.
- Explicit duplicate names are auto-suffixed like defaulted names.
- Removed the unreachable Claude sentinel/transcript-copy path and the unused `PI_DENY_TOOLS`
  handling.

## [3.9.0] - 2026-10-03

### Fixed
- **Pi runner: kept-open subagents now deliver turn results automatically**:
  - A `pi` subagent that parks at the end of a completed turn (`keepOpen: true`, `interactive: true`, or any non-auto-exit session) previously left the orchestrator widget showing `waiting` forever — its completion never arrived, and recovering the result required stopping the subagent and reading its session log. Herdr "idle" is never treated as completion for Pi (it can equally mean waiting on child subagents or an `ask_question` reply), so no parent-side completion signal existed.
  - The child extension (`subagent-done.ts`) now writes a one-shot `${sessionFile}.parked` sidecar at a genuine turn end (nothing pending, turn not aborted), and the watcher (`pollForExit`) consumes it as turn completion for the Pi runner — mirroring how `agy`/`claude` kept-open sessions deliver per-turn results. Steering re-arms the per-turn watcher, so each follow-up message's result is delivered the same way.
  - Freshness validation (`parkedAt`/`writtenAt` vs the current turn start) keeps steer↔result 1:1: a leftover signal from a previous turn can never be delivered as the current turn's result.
  - The `agy`/`claude` idle-settle detection and the Pi idle-never-completes guard are unchanged; the parked-completion signal is added alongside them.

### Changed
- **`keepOpen` now suppresses the Pi child's auto-exit**: previously `keepOpen: true` on an auto-exit agent profile (worker/scout/researcher) still launched the child with `PI_SUBAGENT_AUTO_EXIT=1`, so the child shut down and left a dead pane and a stale widget entry. The child now auto-exits only when the session is not effectively interactive, matching how `agy`/`claude` keep their session alive under `keepOpen`.

### Added
- **Errored kept-open turns are reported**: a parked Pi session whose turn ends with `stopReason: "error"` (provider overload, retry exhausted) writes the existing `.exit` error sidecar, so the orchestrator receives a clear failure message instead of silence.

## [3.8.1] - 2026-09-30

### Fixed
- **Migrated Deprecated Pi Scopes (`@mariozechner/*` -> `@earendil-works/*`)**:
  - Replaced deprecated `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` with official `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` across `package.json`, source files (`pi-extension/subagents/index.ts`, `pi-extension/subagents/subagent-done.ts`, `pi-extension/subagents/tools/safe-bash.ts`), and tests (`test/test.ts`).
  - Resolves npm deprecation notices (`npm warn deprecated @mariozechner/*: please use @earendil-works/* instead going forward`).
- **Eliminated Unwanted Peer Dependency Installation & Install-Script Warnings**:
  - Added `peerDependenciesMeta` marking `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@sinclair/typebox` as `optional: true`.
  - In npm v7+, peer dependencies are installed by default unless declared optional in `peerDependenciesMeta`. When users installed `interactive-subagents`, npm was auto-downloading the entire Pi coding agent harness (~200 packages) into the consumer environment, executing build/install lifecycle scripts (`koffi` and `protobufjs`), and generating warnings.
  - Marking peer dependencies optional tells npm that the host harness (Pi) supplies these packages at runtime via its built-in module loader, preventing bloat and eliminating install-script warnings entirely.
- **Resolved `npm audit` Vulnerabilities**:
  - Replaced legacy dependencies that previously triggered 13 security advisories (1 Critical, 9 High, 3 Moderate).
  - Consumer installs now report **0 vulnerabilities**.
- **Synchronized Package Manifest and Lockfile**:
  - Rebuilt `package-lock.json` cleanly to align package metadata and lock modern `@earendil-works/*` dependencies (`^0.87.1`).
