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
- Logging redaction helpers and test fixtures.

Not implemented yet:

- `oc2 run` prompt execution.
- Interactive TUI.
- Tool registry and built-in coding tools.
- MCP server runtime and tool invocation.
- Subagents, agent teams, daemon teammates, and team reports.

See `SPEC.md` and `IMPLEMENTATION_PLAN.md` for the target architecture and remaining slices.

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
