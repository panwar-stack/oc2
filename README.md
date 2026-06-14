# oc2

`oc2` is a local-first TypeScript/Bun coding harness built from `SPEC.md`.

The project is implemented as a single Bun package with a small runtime core and thin CLI/TUI entry points. It is still in early implementation: foundational services, one-shot prompt execution, a minimal interactive TUI shell, the first MCP runtime slice, subagent runtime primitives, and agent team core services are present.

## Current Status

Implemented foundations:

- CLI parser and output formatting for `version`, `diagnostics`, `config`, `tools list`, `mcp`, `run`, and `resume --run`.
- JSONC configuration loading, defaults, path discovery, validation, and `config set` updates.
- Diagnostics for environment, config loading, dependencies, and report formatting.
- Typed runtime events, an in-process event bus, and event projection helpers.
- SQLite persistence schema, migrations, and repositories for sessions, messages, tool calls, runtime events, and MCP metadata.
- Session service and transcript export helpers.
- Bounded task scheduler with priority, timeout, cancellation, and parent abort support.
- Model provider abstractions, stream collection, fake provider, AI SDK adapter, and model service events.
- Tool registry primitives, execution result helpers, permission policy checks, workspace root validation, and safe built-in tool definitions.
- Main agent profile resolution, model context construction, model/tool loop execution, and persisted one-shot session runs.
- Minimal terminal TUI shell with projected runtime state, prompt submission, streaming assistant text, tool status display, resume, cancellation, and side-panel toggle.
- MCP config, status events, startup/test lifecycle, tool discovery, `tools/list_changed` refresh, namespaced MCP tool registration, and normal tool-executor invocation with permissions.
- Subagent service, permission derivation, and tool adapter for child sessions with `parentSessionId`, bounded scheduling, timeout/cancellation propagation, and recursive delegation disabled by default.
- Agent team service, mailbox delivery, shared task claims, teammate child sessions, daemon lifecycle state, dependency gates, shutdown handling, and PR 12 team tool definitions.
- Logging redaction helpers and test fixtures.

Not implemented yet:

- Team plan approval, team reports, and TUI team panels.
- Full MCP OAuth callback flow. OAuth-required servers are surfaced as `auth_required` until that later slice is implemented.

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
- `src/cli` contains command parsing, command dispatch, and text/JSON output formatting. Current commands cover help, version, diagnostics, config, tools listing, MCP listing/testing/toggling, `run`, `resume --run`, and `tui`.
- `src/config` owns JSONC configuration discovery, loading, merging, validation, defaults, path handling, and environment overrides. Its schema already includes future-facing sections for models, tools, MCP, agents, runtime limits, and TUI settings.
- `src/diagnostics` collects environment and dependency health information and turns it into structured reports for `oc2 diagnostics`.
- `src/events` defines the runtime event contract, in-process event bus, and projector helpers. Event categories include implemented session/model/scheduler events plus planned tool, permission, MCP, subagent, and team events.
- `src/logging` provides a small structured logger with log-level filtering and redaction utilities for sensitive values.
- `src/model` defines model provider interfaces, streaming event types, stream collection helpers, provider error handling, a fake provider, an AI SDK compatible adapter, and the model service that publishes model lifecycle events.
- `src/persistence` owns local SQLite setup, migrations, schema SQL, and repository classes. It currently persists sessions, workspace roots, messages and parts, tool calls, runtime events, MCP snapshots, teams, members, shared tasks, and mailbox messages.
- `src/session` provides the session service façade over persistence repositories, publishes session/message events, defines session message shapes, exports transcripts as Markdown or JSON, and owns one-shot session run orchestration.
- `src/agent` defines the main agent profile, system prompt, model context loop, and persisted tool-result handling for non-interactive runs.
- `src/scheduler` implements bounded async task scheduling with priorities, per-kind limits, cancellation propagation, timeouts, snapshots, and scheduler events. It is the planned coordination primitive for model, tool, MCP, subagent, and team-member work.
- `src/tools` defines the built-in tool contract, registry, permission handling, workspace-root checks, output shaping, and safe built-ins for file search, file IO, shell execution, patching, web fetches, questions, and todo tracking. MCP tools are materialized into the same registry and executor path.
- `src/mcp` manages canonical MCP config entries, stdio/HTTP/SSE-style client startup, server statuses, tool discovery, `tools/list_changed` refresh, auth-required status detection, and conversion of MCP tools into namespaced oc2 tools.
- `src/subagent` creates child sessions for subagent profiles, derives child tool permissions from parent denies and child allows, disables recursive subagent/team tools by default, and exposes the runtime through a normal `subagent` tool definition.
- `src/team` coordinates one active team per lead session, teammate child sessions scheduled as `team-member` work, mailbox send/broadcast/delivery, transactional shared task claims, dependency-gated spawns, daemon lifecycle state, and shutdown.
- `src/tui` contains the minimal terminal UI shell, keymap, projected UI state, and small text-rendered session components. It renders from runtime event state instead of polling runtime internals.
- `src/testing` contains shared fixtures used by tests.

The spec also calls for future top-level areas such as `runtime` and `skills`. Those folders are not present yet; their contracts are being prepared through config, events, persistence, tools, agent, scheduler, MCP, subagent, team, and TUI primitives.

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
- `oc2 mcp list [--json]` lists configured MCP server statuses without starting new processes.
- `oc2 mcp enable <id> [--json]` enables a configured MCP server in the project config.
- `oc2 mcp disable <id> [--json]` disables a configured MCP server in the project config.
- `oc2 mcp test <id> [--json]` starts one configured MCP server, discovers tools, and reports its status.
- `oc2 run <prompt> [--json] [--model <provider/model>]` runs a one-shot prompt through the main agent.
- `oc2 resume <session-id> --run <prompt> [--json]` appends a prompt to an existing session and runs the main agent.
- `oc2 tui [--session <id>] [--model <provider/model>]` opens the minimal interactive terminal UI.

The default `fake/test` model returns a deterministic response for local smoke tests:

```sh
bun src/index.ts run "hello" --json --model fake/test
```

MCP servers use the canonical `oc2` config shape. Enabled servers start before one-shot agent runs; discovered tools are exposed as `mcp_<server>_<tool>` and are invoked through the normal tool scheduler, permission service, and output bounding path. OAuth configuration is recognized, but full browser callback flow is deferred; those servers report `auth_required`.

```jsonc
{
  "mcp": {
    "localDocs": {
      "enabled": true,
      "transport": "stdio",
      "command": "docs-mcp",
      "args": [],
      "cwd": ".",
      "env": {},
      "toolPermissions": [{ "match": "mcp.invoke:localDocs/*", "decision": "ask" }],
      "startupTimeoutMs": 10000
    },
    "remoteSearch": {
      "enabled": false,
      "transport": "http",
      "url": "https://example.test/mcp",
      "headers": { "authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

Open the minimal TUI shell with the same fake model:

```sh
bun src/index.ts tui --model fake/test
```

The TUI supports prompt submission, streamed assistant text, visible tool status, `Ctrl+C` cancellation/exit, `Ctrl+S` side-panel toggle, and basic resume with `--session <id>`. MCP, team, permission, and subagent panels are intentionally deferred to later implementation slices.

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
- `bun run smoke:tui` opens the manual TUI smoke command with the fake model.

## Development

This repository uses Bun, strict TypeScript, oxlint, and Prettier. Public runtime modules are exported from `src/index.ts`; tests live under `test/` and cover the implemented CLI, config, diagnostics, event, scheduler, persistence, session, model, agent, tool, TUI, and logging slices.
