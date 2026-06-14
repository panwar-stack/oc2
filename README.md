# oc2

`oc2` is a local-first TypeScript/Bun coding harness built from `SPEC.md`.

This repository is currently at PR 1 of the implementation plan: project skeleton and quality gates only. Runtime services, CLI commands, TUI, MCP, subagents, and teams are intentionally not implemented yet.

## Scripts

- `bun test` runs the test suite.
- `bun run typecheck` runs strict TypeScript checks.
- `bun run lint` runs oxlint.
- `bun run format` formats the repository with Prettier.
- `bun run diagnostics` runs typecheck, lint, and tests.
