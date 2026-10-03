# Changelog

All notable changes to `interactive-subagents` will be documented in this file.

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
