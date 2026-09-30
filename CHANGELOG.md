# Changelog

All notable changes to `interactive-subagents` will be documented in this file.

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
