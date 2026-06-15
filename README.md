# oc2

`oc2` is a local-first TypeScript/Bun coding harness built from `specs/01-oc2-spec.md`.

The project is implemented as a single Bun package with a small runtime core and thin CLI/TUI entry points. It is still in early implementation: foundational services, one-shot prompt execution, a minimal interactive TUI shell, the first MCP runtime slice, subagent runtime primitives, and agent team core services are present.

## Current Status

Implemented foundations:

- CLI parser and output formatting for `version`, `diagnostics`, `config`, `commands`, `sessions list`, `tools`, `memory list`, `mcp`, `run`, `resume --run`, and transcript export.
- JSONC configuration loading, defaults, path discovery, validation, and `config set` updates.
- Diagnostics for environment, config loading, dependencies, and report formatting.
- Typed runtime events, an in-process event bus, and event projection helpers.
- SQLite persistence schema, migrations, and repositories for sessions, messages, tool calls, runtime events, and MCP metadata.
- Session service and Markdown/JSON transcript export helpers.
- Bounded task scheduler with priority, timeout, cancellation, and parent abort support.
- Model provider abstractions, stream collection, fake provider, AI SDK adapter, and model service events.
- Tool registry primitives, execution result helpers, permission policy checks, workspace root validation, and safe built-in tool definitions.
- Main agent profile resolution, model context construction, model/tool loop execution, and persisted one-shot session runs.
- Minimal terminal TUI shell with projected runtime state, prompt submission, streaming assistant text, tool status display, team/MCP/agent/permission panels, question prompts, resume, cancellation, and side-panel toggle.
- MCP config, status events, startup/test lifecycle, tool discovery, `tools/list_changed` refresh, namespaced MCP tool registration, and normal tool-executor invocation with permissions.
- Subagent service, permission derivation, and tool adapter for child sessions with `parentSessionId`, bounded scheduling, timeout/cancellation propagation, and recursive delegation disabled by default.
- Agent team service, mailbox delivery, shared task claims, teammate child sessions, daemon lifecycle state, dependency gates, shutdown handling, plan approval gates, and deterministic team reports.
- TUI projected state for team membership, shared tasks, mailbox activity, daemon status, plan approvals, generated reports, MCP server status, permission requests/denials, question prompts, and agent task status.
- Repository-shipped built-in skill instruction files and slash commands under `src/skills` and `src/commands` for review, clarification, spec planning, spec implementation, team reports, and repository initialization.
- Logging redaction helpers and test fixtures.

Not implemented yet:

- Dynamic root updates during long-running TUI sessions (roots are static per run).

See `specs/01-oc2-spec.md`, `specs/02-implementation-plan.md`, and the release docs in `docs/` for the target architecture and shipped behavior.

## Project Design

`oc2` follows the architecture described in `specs/01-oc2-spec.md`: a local-first runtime core with thin adapters around it. The current package keeps the runtime explicit and in-process instead of copying the larger `opencode` monolith or introducing a monorepo before it is needed.

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
- `src/cli` contains command parsing, command dispatch, and text/JSON output formatting. Current commands cover help, version, diagnostics, config, slash command listing, session/memory listing, tool toggling/listing, MCP listing/testing/toggling, `run`, `resume --run`, transcript export, and `tui`.
- `src/config` owns JSONC configuration discovery, loading, merging, validation, defaults, path handling, and environment overrides. Its schema already includes future-facing sections for models, tools, MCP, agents, runtime limits, and TUI settings.
- `src/diagnostics` collects environment and dependency health information and turns it into structured reports for `oc2 diagnostics`.
- `src/events` defines the runtime event contract, in-process event bus, and projector helpers. Event categories include session/model/scheduler/tool/permission/MCP/subagent/team events used by CLI, TUI, persistence, and tests.
- `src/logging` provides a small structured logger with log-level filtering and redaction utilities for sensitive values.
- `src/model` defines model provider interfaces, streaming event types, stream collection helpers, provider error handling, a fake provider, an AI SDK compatible adapter, and the model service that publishes model lifecycle events.
- `src/persistence` owns local SQLite setup, migrations, schema SQL, and repository classes. It currently persists sessions, workspace roots, messages and parts, tool calls, runtime events, MCP snapshots, teams, members, shared tasks, and mailbox messages.
- `src/session` provides the session service façade over persistence repositories, publishes session/message events, defines session message shapes, exports transcripts as Markdown or JSON, supports recursive child-session export, and owns one-shot session run orchestration.
- `src/agent` defines the main agent profile, system prompt, model context loop, and persisted tool-result handling for non-interactive runs.
- `src/scheduler` implements bounded async task scheduling with priorities, per-kind limits, cancellation propagation, timeouts, snapshots, and scheduler events. It is the planned coordination primitive for model, tool, MCP, subagent, and team-member work.
- `src/tools` defines the built-in tool contract, registry, permission handling, workspace-root checks, output shaping, and safe built-ins for file search, file IO, shell execution, patching, web fetches, questions, and todo tracking. MCP tools are materialized into the same registry and executor path.
- `src/mcp` manages canonical MCP config entries, stdio/HTTP/SSE-style client startup, server statuses, tool discovery, `tools/list_changed` refresh, auth-required status detection, and conversion of MCP tools into namespaced oc2 tools.
- `src/subagent` creates child sessions for subagent profiles, derives child tool permissions from parent denies and child allows, disables recursive subagent/team tools by default, and exposes the runtime through a normal `subagent` tool definition.
- `src/team` coordinates one active team per lead session, teammate child sessions scheduled as `team-member` work, mailbox send/broadcast/delivery, transactional shared task claims, dependency-gated spawns, daemon lifecycle state, plan approval state, deterministic reporting, and shutdown.
- `src/skills` contains built-in Markdown skill instructions used by built-in slash commands and the `skill` tool. Plugin discovery remains intentionally deferred until there is an explicit loader contract.
- `src/tui` contains the minimal terminal UI shell, keymap, projected UI state, and small text-rendered session components. It renders from runtime event state instead of polling runtime internals, including team, MCP, agent, permission, and question-prompt panels.
- `src/testing` contains shared fixtures used by tests.

The spec also calls for future top-level areas such as `runtime`. Those contracts are being prepared through config, events, persistence, tools, agent, scheduler, MCP, subagent, team, skills, and TUI primitives.

## CLI

Install dependencies with the Bun version pinned in `package.json`:

```sh
bun install
```

Run the CLI through the package script while the package is private:

```sh
bun run start --help
```

Available commands:

- `oc2 version [--json]` prints the package version.
- `oc2 diagnostics [--json]` prints environment and configuration diagnostics.
- `oc2 config path [--json]` prints user, project, explicit, and data paths.
- `oc2 config get [key] [--json]` prints the full config or a dotted key.
- `oc2 config set <key> <value> [--json]` writes a dotted key to the project config.
- `oc2 commands [--json]` lists registered slash commands.
- `oc2 sessions list [--json]` lists saved sessions.
- `oc2 tools list [--json]` lists configured tools.
- `oc2 tools enable <name> [--json]` enables a configured tool in the project config.
- `oc2 tools disable <name> [--json]` disables a configured tool in the project config.
- `oc2 memory list [--json]` lists persisted memory retrieval logs.
- `oc2 mcp list [--json]` lists configured MCP server statuses without starting new processes.
- `oc2 mcp enable <id> [--json]` enables a configured MCP server in the project config.
- `oc2 mcp disable <id> [--json]` disables a configured MCP server in the project config.
- `oc2 mcp test <id> [--json]` starts one configured MCP server, discovers tools, and reports its status.
- `oc2 run <prompt> [--json] [--model <provider/model>] [--root <path>...] [--tool <name>] [--no-tool <name>] [--mcp <id>] [--no-mcp <id>] [--team] [--timeout <ms>] [--max-concurrency <n>]` runs a one-shot prompt through the main agent. Prompts beginning with a registered slash command, such as `/review diff`, dispatch that command.
- `oc2 resume <session-id> --run <prompt> [--json]` appends a prompt to an existing session and runs the main agent.
- `oc2 export <session-id> --format markdown|json [--recursive]` exports a saved session transcript.
- `oc2 tui [--session <id>] [--model <provider/model>] [--root <path>...]` opens the minimal interactive terminal UI.

In the TUI, `Ctrl+P` opens the model picker, where typing filters providers/models and `Enter` selects the highlighted row. If the selected model exposes variants, the picker switches to variant selection; `Default` clears any active variant. `Ctrl+V` cycles the active model variant without opening the picker once model metadata has loaded.

The default `fake/test` model returns a deterministic response for local smoke tests:

```sh
bun run start run "hello" --json --model fake/test
```

Use repeated `--root <path>` values with `run` or `tui` to add allowed workspace roots for file tools. Repeated `--tool`, `--no-tool`, `--mcp`, and `--no-mcp` flags override configured tools and MCP servers for that run only. Export transcripts as Markdown or JSON:

```sh
bun run start export <session-id> --format markdown
bun run start export <session-id> --format json --recursive
```

### Slash Commands

Built-in slash commands are available from `oc2 commands`, one-shot `oc2 run`, and the TUI:

- `/review <diff>` wraps review requests as a focused subtask.
- `/clarify [request]` loads the clarification workflow.
- `/spec-planner [goal]` loads the specification planning workflow.
- `/spec-implement [slice]` loads the specification implementation workflow.
- `/team-report [baseline-session-id...]` loads the agent team report workflow and instructs the agent to call `team_report`.
- `/init [context]` loads the project initialization workflow.

Project and user config can add or override commands through the `commands` object. Command templates replace `$ARGUMENTS` with the user-provided arguments and may reference built-in skill files with `skill:<name>`.

TUI-local commands run client-side and are not accepted by non-interactive `run`: `/help`, `/clear`, `/skills`, and `/exit` plus `/quit` and `/q` aliases. While typing in the TUI, `/` opens command suggestions, prefix text filters them, `Tab` completes the first match, and `Esc` closes suggestions.

MCP servers use the canonical `oc2` config shape. Enabled servers start before one-shot agent runs; `oc2 mcp test <id>` starts one configured server and reports discovered tools, resource/prompt counts when discovered, and OAuth status when authorization is required. Discovered tools are exposed as `mcp_<server>_<tool>` and are invoked through the normal tool scheduler, permission service, and output bounding path. Remote HTTP/SSE servers with OAuth metadata use the browser PKCE flow and report an actionable auth URL when user authorization is needed. Stdio servers use environment/config credentials by default.

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
      "startupTimeoutMs": 10000,
    },
    "remoteSearch": {
      "enabled": false,
      "transport": "http",
      "url": "https://example.test/mcp",
      "headers": { "authorization": "Bearer ${TOKEN}" },
      "oauth": {
        "enabled": true,
        "clientId": "my-mcp-client",
        "callbackPort": 7331,
        "scopes": ["mcp:tools"],
      },
    },
  },
}
```

### MCP Protocol Support Matrix

| Feature                                 | Stdio | HTTP | SSE | Tested |
| --------------------------------------- | ----- | ---- | --- | ------ |
| `initialize` with capabilities          | yes   | yes  | yes | yes    |
| `tools/list` + `tools/call`             | yes   | yes  | yes | yes    |
| `resources/list` + `resources/read`     | yes   | yes  | yes | yes    |
| `prompts/list` + `prompts/get`          | yes   | yes  | yes | yes    |
| `notifications/tools/list_changed`      | yes   | yes  | yes | yes    |
| `notifications/resources/list_changed`  | yes   | yes  | yes | yes    |
| `notifications/prompts/list_changed`    | yes   | yes  | yes | yes    |
| `roots/list` (host handler)             | yes   | —    | —   | yes    |
| `sampling/createMessage` (host handler) | yes   | —    | —   | yes    |
| `elicitation/create` (host handler)     | yes   | —    | —   | yes    |
| JSON-RPC error normalization            | yes   | yes  | yes | yes    |
| Request cancellation (AbortSignal)      | yes   | yes  | yes | yes    |
| Malformed output resilience             | yes   | yes  | —   | yes    |
| OAuth 2.1 PRM discovery                 | —     | yes  | yes | yes    |
| OAuth 2.1 PKCE + token exchange         | —     | yes  | yes | yes    |
| Bearer token request retry              | —     | yes  | yes | yes    |

`Tested` means covered by deterministic repo tests for at least one applicable transport; full per-transport compatibility matrix coverage is tracked in the next remediation slice.

Stdio servers communicate over subprocess pipes with line-delimited JSON-RPC. HTTP and SSE servers use POST-based JSON-RPC 2.0, with SSE offering an optional event stream for server-to-client notifications. Server-to-client request handling (roots, sampling, elicitation) is supported for stdio transports. OAuth 2.1 PKCE flow with token exchange, refresh, and bearer retry is supported for remote HTTP/SSE transports. OAuth tokens are stored under the local data directory and are redacted from status events, snapshots, logs, and errors.

### Config Examples

**Stdio server with local credentials:**

```jsonc
// oc2.jsonc
{
  "mcp": {
    "local-tools": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": { "API_KEY": "${MY_API_KEY}" },
      "toolPermissions": [{ "match": "mcp.invoke:local-tools/*", "decision": "ask" }],
      "startupTimeoutMs": 15000,
    },
  },
}
```

**Remote server with OAuth:**

```jsonc
// oc2.jsonc
{
  "mcp": {
    "remote-api": {
      "enabled": true,
      "transport": "http",
      "url": "https://mcp.example.com/api",
      "oauth": {
        "enabled": true,
        "clientId": "oc2-${USER}",
        "callbackPort": 7331,
        "scopes": ["mcp:tools", "mcp:resources"],
      },
      "toolPermissions": [{ "match": "mcp.invoke:remote-api/*", "decision": "allow" }],
      "startupTimeoutMs": 20000,
    },
  },
}
```

Open the minimal TUI shell with the same fake model:

```sh
bun run start tui --model fake/test
```

The TUI supports prompt submission, streamed assistant text, visible tool status, slash command autocomplete, pending team plan approval projection, team report availability projection, MCP server status, permission requests and denials, question prompt display, agent task status, `Ctrl+C` cancellation/exit, `Ctrl+S` side-panel toggle, `Ctrl+T` team panel toggle, `Ctrl+M` MCP panel toggle when distinguishable, `Ctrl+A` agent panel toggle, `Ctrl+L` clear messages, `Ctrl+R` session switcher, `Alt+Enter` newline insertion, `Tab` slash completion, empty-prompt Enter as the raw-terminal fallback for `Ctrl+M`, `Esc` panel/dialog close, and basic resume with `--session <id>`. Narrow terminals hide side panels during rendering so prompt input remains available.

Team runtime tools include `team_create`, `team_spawn`, `team_send_message`, `team_broadcast`, `team_get_messages`, `team_task_create`, `team_task_claim`, `team_task_update`, `team_task_list`, `team_shutdown`, `team_plan_submit`, `team_plan_decide`, and `team_report`. Plan-mode teammates remain in `plan_pending` until the lead approves the submitted plan; rejected plans stay gated. Team reports are generated from persisted team state with stable member/task/mailbox counts, daemon state, deterministic findings, runtime/cost placeholders, and residual failures.

## Configuration

Configuration is JSONC and is merged in this order:

```text
defaults < user config < project config < explicit config
```

CLI flags are applied as command-scoped overrides where supported, such as `--model`, `--root`, `--tool`, `--no-tool`, `--mcp`, and `--no-mcp` for one-shot runs.

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

See `docs/config.md` for full config examples and permission rule matching details. See `docs/mcp.md` for MCP transport examples and auth behavior.

## Permissions

Tool permissions use rules shaped as `{ "match": string, "decision": "allow" | "deny" | "ask" }`. Match candidates include the tool name, action, resource, `toolName:resource`, and `action:resource`. If no rule matches, the operation is allowed. In non-interactive paths, an `ask` decision without a resolver is denied with a structured tool error rather than bypassing the permission gate.

## Diagnostics And Export

`oc2 diagnostics [--json]` reports environment, config path, data path, and dependency warnings without printing secrets. `oc2 export <session-id> --format markdown|json [--recursive]` exports a persisted transcript; `--recursive` includes child subagent and teammate sessions in transcript order.

## Release Docs

- `docs/architecture.md` explains the in-process runtime, event bus, scheduler limits, and deferred HTTP API.
- `docs/config.md` contains practical JSONC config examples.
- `docs/mcp.md` contains stdio, HTTP, SSE, permission, and auth-required MCP examples.
- `docs/smoke.md` contains the manual smoke checklist for release verification.
- `docs/dependencies.md` documents why each runtime and development dependency is present.

## Scripts

- `bun test` runs the test suite.
- `bun run typecheck` runs strict TypeScript checks.
- `bun run lint` formats the repository with Prettier, then runs oxlint.
- `bun run format` formats the repository with Prettier.
- `bun run format:check` checks Prettier formatting without writing files.
- `bun run check` runs the non-mutating release quality gate: typecheck, format check, oxlint, and tests.
- `bun run diagnostics` runs typecheck, lint, format check, and tests.
- `bun run smoke:tui` opens the manual TUI smoke command with the fake model.

## Development

This repository uses Bun, strict TypeScript, oxlint, and Prettier. Public runtime modules are exported from `src/index.ts`; tests live under `test/` and cover the implemented CLI, config, diagnostics, event, scheduler, persistence, session, model, agent, tool, TUI, and logging slices.
