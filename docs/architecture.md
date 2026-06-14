# Architecture Notes

`oc2` runs as a single local Bun package. CLI and TUI entry points are thin adapters over in-process runtime services; there is no shipped web app, desktop app, hosted control plane, generated SDK, or stable HTTP API.

## Runtime Boundary

The current runtime is in-process by design. Commands create or load local services for configuration, diagnostics, persistence, scheduling, models, tools, MCP, sessions, subagents, teams, and TUI projection. This keeps local execution explicit and avoids a server boundary before there is a stable external API contract.

The HTTP/event API described as future work in the specs is deferred. Do not depend on an HTTP control plane or remote session API in this release slice.

## Event Bus

User-visible runtime state changes are emitted as typed events. The CLI, TUI projector, persistence tests, and runtime services share the same event contract instead of polling internal service fields.

The event categories cover sessions, messages, model streaming, tool execution, permission decisions, MCP status, subagents, teams, mailbox delivery, scheduler tasks, diagnostics, and errors.

## Scheduler Limits

The scheduler enforces bounded work instead of allowing unbounded sibling tool or agent calls. Defaults come from `src/config/schema.ts`:

- `runtime.maxConcurrentTools`: `4`
- `runtime.maxConcurrentSubAgents`: `2`
- `runtime.maxConcurrentTeamMembers`: `4`
- `runtime.defaultTimeoutMs`: `120000`

Model, tool, MCP, subagent, and team-member work uses cancellation and timeout-aware task execution. Parent cancellation propagates to child work where the feature slice supports it.

## Local State

Sessions, messages, workspace roots, tool calls, MCP snapshots, teams, members, shared tasks, and mailbox messages are persisted locally. Secrets are not intentionally stored in session tables; config and logs use redaction helpers for secret-shaped values.
