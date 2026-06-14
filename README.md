# oc2

`oc2` is a local-first TypeScript/Bun coding harness built from `SPEC.md`.

The project is implemented as a single Bun package with a small runtime core and thin CLI entry point. It is still in early implementation: foundational services are present, while prompt execution, tools, TUI, MCP runtime, subagents, and agent teams are not available yet.

## Current Status

Implemented foundations:

- CLI parser and output formatting for `version`, `diagnostics`, `config`, `tools list`, and `run --help`.
- JSONC configuration loading, defaults, path discovery, validation, and `config set` updates.
- Diagnostics for environment, config loading, dependencies, and report formatting.
- Typed runtime events, an in-process event bus, and event projection helpers.
- SQLite persistence schema, migrations, and repositories for sessions, messages, tool calls, runtime events, and MCP metadata.
- Session service and transcript export helpers.
- Bounded task scheduler with priority, timeout, cancellation, and parent abort support.
- Model provider abstractions, stream collection, fake provider, AI SDK adapter, and model service events.
- Tool registry primitives, execution result helpers, permission policy checks, workspace root validation, and safe built-in tool definitions.
- Logging redaction helpers and test fixtures.

Not implemented yet:

- `oc2 run` prompt execution.
- Interactive TUI.
- MCP server runtime and tool invocation.
- Subagents, agent teams, daemon teammates, and team reports.

See `SPEC.md` and `IMPLEMENTATION_PLAN.md` for the target architecture and remaining slices.

## Project Design

`oc2` follows the architecture described in `SPEC.md`: a local-first runtime core with thin adapters around it. The current package keeps the runtime explicit and in-process instead of copying the larger `opencode` monolith or introducing a monorepo before it is needed.

The intended dependency direction is:

```text
CLI/TUI adapters
  -> runtime services
  -> model, scheduler, tools, MCP, subagents, teams
  -> events and persistence
```

Only part of that stack exists today. The code already establishes the shared contracts that future slices will use: typed events, bounded scheduling, JSONC config, SQLite repositories, session/message shapes, model streaming abstractions, and safe tool execution boundaries.

Design principles from the spec that are already reflected in the code:

- Local-first operation: state is stored locally and runtime services run in-process.
- Thin adapters: `src/cli` parses commands and delegates to config, diagnostics, and output helpers instead of owning domain logic.
- Typed events: user-visible runtime changes are modeled as events so CLI, TUI, persistence, and tests can observe the same contract.
- Explicit persistence: SQLite schema and repositories are kept separate from service orchestration.
- Bounded concurrency: the scheduler centralizes queueing, priorities, cancellation, and timeouts for model/tool/MCP/subagent/team-member work.
- Provider boundaries: model calls go through a streaming provider interface, with a fake provider for tests and local development.
- Secret hygiene: logging and model errors redact sensitive values before output or persistence.

## `src/` Guide

- `src/index.ts` is the Bun executable entry point and public barrel export for implemented runtime modules. It runs the CLI only when invoked directly.
- `src/version.ts` contains the package version constant used by the CLI and public exports.
- `src/cli` contains command parsing, command dispatch, and text/JSON output formatting. Current commands cover help, version, diagnostics, config, tools listing, and `run --help`; actual prompt execution is deferred.
- `src/config` owns JSONC configuration discovery, loading, merging, validation, defaults, path handling, and environment overrides. Its schema already includes future-facing sections for models, tools, MCP, agents, runtime limits, and TUI settings.
- `src/diagnostics` collects environment and dependency health information and turns it into structured reports for `oc2 diagnostics`.
- `src/events` defines the runtime event contract, in-process event bus, and projector helpers. Event categories include implemented session/model/scheduler events plus planned tool, permission, MCP, subagent, and team events.
- `src/logging` provides a small structured logger with log-level filtering and redaction utilities for sensitive values.
- `src/model` defines model provider interfaces, streaming event types, stream collection helpers, provider error handling, a fake provider, an AI SDK compatible adapter, and the model service that publishes model lifecycle events.
- `src/persistence` owns local SQLite setup, migrations, schema SQL, and repository classes. It currently persists sessions, workspace roots, messages and parts, tool calls, runtime events, and MCP snapshots.
- `src/session` provides the session service façade over persistence repositories, publishes session/message events, defines session message shapes, and exports transcripts as Markdown or JSON.
- `src/scheduler` implements bounded async task scheduling with priorities, per-kind limits, cancellation propagation, timeouts, snapshots, and scheduler events. It is the planned coordination primitive for model, tool, MCP, subagent, and team-member work.
- `src/tools` defines the built-in tool contract, registry, permission handling, workspace-root checks, output shaping, and safe built-ins for file search, file IO, shell execution, patching, web fetches, questions, and todo tracking. Tool invocation is implemented at the subsystem level and is ready to be wired into prompt execution.
- `src/testing` contains shared fixtures used by tests.

The spec also calls for future top-level areas such as `runtime`, `mcp`, `agent`, `subagent`, `team`, `tui`, and `skills`. Those folders are not present yet; their contracts are being prepared through config, events, persistence, tools, and scheduler primitives.

## CLI

Run the CLI through Bun:

```sh
bun run src/index.ts --help
```

Available commands:

- `oc2 version [--json]` prints the package version.
- `oc2 diagnostics [--json]` prints environment and configuration diagnostics.
- `oc2 config path [--json]` prints user, project, explicit, and data paths.
- `oc2 config get [key] [--json]` prints the full config or a dotted key.
- `oc2 config set <key> <value> [--json]` writes a dotted key to the project config.
- `oc2 tools list [--json]` lists configured tools.
- `oc2 run --help` prints the planned one-shot prompt interface.

`oc2 run` currently returns a planned-implementation message for prompt execution.

## Configuration

Configuration is JSONC and is merged in this order:

```text
defaults < user config < project config < explicit config
```

Supported paths:

- User config: `~/.config/oc2/config.jsonc`
- Project config: `./oc2.jsonc`
- Project directory config: `./.oc2/config.jsonc`
- Explicit config: `OC2_CONFIG`

Defaults use the fake model provider:

```json
{
  "model": {
    "provider": "fake",
    "model": "test"
  },
  "tools": {},
  "mcp": {},
  "agents": {},
  "runtime": {
    "maxConcurrentTools": 4,
    "maxConcurrentSubAgents": 2,
    "maxConcurrentTeamMembers": 4,
    "defaultTimeoutMs": 120000,
    "logLevel": "info"
  },
  "tui": {
    "sidePanel": true
  }
}
```

## Scripts

- `bun test` runs the test suite.
- `bun run typecheck` runs strict TypeScript checks.
- `bun run lint` runs oxlint.
- `bun run format` formats the repository with Prettier.
- `bun run diagnostics` runs typecheck, lint, and tests.

## Development

This repository uses Bun, strict TypeScript, oxlint, and Prettier. Public runtime modules are exported from `src/index.ts`; tests live under `test/` and cover the implemented CLI, config, diagnostics, event, scheduler, persistence, session, model, and logging slices.
