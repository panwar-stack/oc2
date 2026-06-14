# oc2 Implementation Plan

## Goal

Build `oc2` as a local-first TypeScript/Bun coding harness from the existing `SPEC.md`. The implementation must start from a blank project directory and deliver a small, explicit runtime core with thin CLI and TUI adapters.

Use `/Users/srpanwar/Documents/Workspace/brain/opencode` as a reference repository, not a source tree to copy wholesale. Default to the split v2 packages for architecture (`packages/cli`, `packages/tui`, `packages/core`, `packages/llm`, `packages/server`) and selectively port mature local-only features from `packages/opencode`.

## Current State

- `/Users/srpanwar/Documents/Workspace/brain/oc2/SPEC.md` is the only file currently present in `oc2`.
- `/Users/srpanwar/Documents/Workspace/brain/oc2` is not a git repository.
- There is no `package.json`, `bun.lock`, `tsconfig.json`, `oxlint.json`, `src/`, `test/`, CLI, runtime, TUI, persistence layer, or tooling yet.
- `SPEC.md` already defines the target architecture, data shapes, runtime flows, TUI/CLI behavior, MCP behavior, team behavior, migration phases, dependencies, test expectations, and quality gates.
- The reference repo is `/Users/srpanwar/Documents/Workspace/brain/opencode` on `master` at `5e2f62879f`.
- The reference repo has two overlapping eras:
- Split v2 packages: `packages/cli`, `packages/tui`, `packages/core`, `packages/server`, `packages/llm`.
- Mature feature implementation in `packages/opencode`, including MCP runtime, subagents, teams, team reporting, repository memory, OpenGrep, Docker shell sandboxing, transcript export, and legacy CLI commands.

## Non-Negotiables

- Start with a single package in `oc2`; do not introduce a monorepo until there is a concrete need.
- Build local-first behavior only; do not implement web app, desktop app, hosted control plane, accounts, billing, analytics, Slack, generated SDK surfaces, or cloud deployment.
- CLI and TUI must be thin adapters over runtime services.
- All model, tool, MCP, subagent, and team operations must support cancellation and timeout.
- Runtime state changes visible to users must emit typed events.
- Tool calls must validate input schemas, enforce permissions, bound output before model re-entry, and respect workspace roots.
- Team and subagent failures must be isolated from the parent runtime unless explicitly configured otherwise.
- Use bounded concurrency; do not rely on unbounded sibling model tool calls.
- Do not persist secrets in the session database.
- MCP config must use one canonical `oc2` shape; do not preserve opencode v1/v2 naming drift.
- Docker shell sandboxing is deferred behind design and security review; do not enable it in the first runtime slices.
- Every PR slice must be reviewed by a fresh read-only reviewer against the plan and diff before it is considered complete.

## Reference Map

- CLI framework: `opencode/packages/cli/src/index.ts`, `packages/cli/src/commands/commands.ts`, `packages/cli/src/framework/spec.ts`, `packages/cli/src/framework/runtime.ts`.
- Legacy CLI behavior: `opencode/packages/opencode/src/cli/cmd/run.ts`, `tui.ts`, `mcp.ts`, `export.ts`, `memory.ts`.
- TUI shell: `opencode/packages/tui/src/app.tsx`, `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/keymap.tsx`, `packages/tui/src/context/runtime.tsx`.
- Core sessions/runtime: `opencode/packages/core/src/session.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/message.ts`, `packages/core/src/session/store.ts`.
- Persistence schema: `opencode/packages/core/src/session/sql.ts`, `packages/opencode/src/session/session.sql.ts`.
- Tools: `opencode/packages/core/src/tool/registry.ts`, `tool.ts`, `builtins.ts`, `bash.ts`, `read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `glob.ts`, `grep.ts`, `webfetch.ts`, `todowrite.ts`.
- LLM abstraction: `opencode/packages/llm/src/llm.ts`, `provider.ts`, `providers/index.ts`, `protocols/index.ts`.
- MCP: `opencode/packages/core/src/config/mcp.ts`, `packages/opencode/src/mcp/index.ts`, `auth.ts`, `oauth-provider.ts`, `packages/opencode/src/cli/cmd/mcp.ts`.
- Subagents: `opencode/packages/opencode/src/tool/task.ts`, `task.txt`, `agent/subagent-permissions.ts`.
- Teams: `opencode/packages/opencode/src/team/team.ts`, `team.sql.ts`, `team/README.md`, `tool/team_*.ts`.
- Team reporting: `opencode/packages/opencode/src/team/eval.ts`, `tool/team_report.ts`, `command/template/team-report.txt`.
- OpenGrep: `opencode/packages/opencode/src/tool/opengrep.ts`, `packages/core/src/filesystem/opengrep.ts`.
- Repository memory: `opencode/packages/opencode/src/memory/memory.ts`, `memory.sql.ts`, `tool/memory.ts`.
- Transcript export: `opencode/packages/opencode/src/cli/cmd/export.ts`, `packages/tui/src/util/transcript.ts`, `session-export.ts`.
- Multi-root sessions: `opencode/specs/multi-root-sessions.md`, `packages/core/src/session/sql.ts`, `packages/opencode/src/session/session.ts`, `tool/path.ts`.
- Docker sandbox reference only: `opencode/packages/opencode/src/tool/shell.ts`, `packages/containers/README.md`.

## First-Pass Architecture

Create the project as one package:

```text
oc2/
  package.json
  bun.lock
  tsconfig.json
  oxlint.json
  README.md
  SPEC.md
  src/
    index.ts
    cli/
    config/
    diagnostics/
    events/
    runtime/
    scheduler/
    persistence/
    session/
    model/
    agent/
    tools/
    mcp/
    subagent/
    team/
    tui/
    skills/
    logging/
    testing/
  test/
```

Core runtime boundary:

```ts
interface Oc2Runtime {
  sessions: SessionService
  agents: AgentService
  subagents: SubAgentService
  teams: AgentTeamService
  tools: ToolRegistry
  mcp: McpService
  models: ModelService
  scheduler: TaskScheduler
  events: RuntimeEventBus
  config: ConfigService
  logs: LogService
  shutdown(reason: string): Promise<void>
}
```

First-pass runtime stays in-process. A local HTTP API is deferred unless TUI/process separation proves necessary.

## Config

Support these paths:

- User config: `~/.config/oc2/config.jsonc`
- Project config: `./oc2.jsonc`
- Project directory config: `./.oc2/config.jsonc`
- Explicit config: `OC2_CONFIG`

Precedence:

```text
defaults < user config < project config < CLI flags
```

Initial config shape:

```ts
interface Oc2Config {
  model: {
    provider: string
    model: string
  }
  tools: Record<string, { enabled: boolean; permissions?: ToolPermissionRule[] }>
  mcp: Record<string, McpServerConfig>
  agents: Record<string, AgentProfile>
  runtime: {
    maxConcurrentTools: number
    maxConcurrentSubAgents: number
    maxConcurrentTeamMembers: number
    defaultTimeoutMs: number
    logLevel: "debug" | "info" | "warn" | "error"
  }
  tui: {
    sidePanel: boolean
    theme?: string
  }
}
```

## Runtime Events

Define events before building services so CLI, TUI, persistence, and tests share one contract.

Minimum event categories:

- `session.created`
- `session.updated`
- `message.updated`
- `model.started`
- `model.delta`
- `model.completed`
- `model.failed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `permission.requested`
- `permission.resolved`
- `subagent.updated`
- `team.updated`
- `team.member.updated`
- `team.task.updated`
- `team.message.delivered`
- `mcp.status`
- `scheduler.task.updated`
- `diagnostic.warning`
- `error`

## CLI Surface

First-pass commands:

```text
oc2 [prompt]
oc2 tui [--session <id>] [--model <provider/model>] [--root <path>...]
oc2 run <prompt> [--json] [--model <provider/model>] [--tool <name>] [--no-tool <name>] [--mcp <id>] [--no-mcp <id>]
oc2 resume <session-id> [--tui | --run <prompt>]
oc2 config get [key]
oc2 config set <key> <value>
oc2 config path
oc2 mcp list
oc2 mcp enable <id>
oc2 mcp disable <id>
oc2 mcp test <id>
oc2 tools list
oc2 tools enable <name>
oc2 tools disable <name>
oc2 diagnostics [--json]
oc2 export <session-id> [--format markdown|json]
oc2 version [--json]
```

Do not use the old yargs spine. Use the split package command framework as the reference.

## Implementation Slices

### PR 1: Project Skeleton And Quality Gates

- Create `package.json`, `bun.lock`, `tsconfig.json`, `oxlint.json`, `README.md`, `src/index.ts`, `src/testing/fixtures.ts`, and `test/smoke.test.ts`.
- Add package scripts: `test`, `typecheck`, `lint`, `format`, `diagnostics`.
- Configure strict TypeScript.
- Add a minimal exported version constant and smoke test.
- Do not add runtime services yet.

Verification:

- `bun install`
- `bun test`
- `bun run typecheck`
- `bun run lint`

Review:

A fresh read-only reviewer must verify that the skeleton does not introduce monorepo structure, web/desktop dependencies, generated SDKs, telemetry, or copied opencode runtime code.

### PR 2: Config, Paths, Logging, And Diagnostics Foundation

- Add `src/config/schema.ts`, `load.ts`, `paths.ts`, `env.ts`.
- Implement JSONC config loading using `jsonc-parser`.
- Implement precedence: defaults, user config, project config, env, CLI override object.
- Add Zod validation and diagnostic warnings for unknown or invalid keys.
- Add `src/logging/logger.ts` and `redaction.ts`.
- Add `src/diagnostics/diagnostics.ts`, `environment.ts`, `dependency-checks.ts`.
- Add tests for config precedence, invalid JSONC, path expansion, env overrides, and secret redaction.

Verification:

- `bun test test/config test/diagnostics test/logging`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must compare config behavior against `SPEC.md` sections 7, 8, 10, and 14 and confirm no opencode v1/v2 MCP naming drift was preserved.

### PR 3: Runtime Events And Scheduler

- Add `src/events/events.ts`, `event-bus.ts`, `projector.ts`.
- Add `src/scheduler/task.ts`, `queue.ts`, `priority.ts`, `scheduler.ts`.
- Implement bounded queues for model, tool, MCP, subagent, and team-member task kinds.
- Implement task status transitions: `queued`, `started`, `progress`, `completed`, `failed`, `cancelled`, `timed_out`.
- Implement parent cancellation via `AbortController`.
- Add timeout handling with structured `RuntimeError`.
- Add tests for concurrency limits, priority ordering, timeout, cancellation, and failure isolation.

Verification:

- `bun test test/events test/scheduler`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify there is no hidden global mutable runtime state and no dependency on `p-limit`, `p-queue`, Bottleneck, Piscina, BullMQ, Redis, or worker threads.

### PR 4: Persistence And Session Storage

- Add `src/persistence/db.ts`, `schema.ts`, `migrations.ts`.
- Add repositories for sessions, messages, tool calls, workspace roots, runtime events, and MCP snapshots.
- Add `src/session/message.ts`, `session-service.ts`, `transcript.ts`.
- Persist sessions, roots, messages, message parts, tool calls, and run status.
- Implement session create, resume, append message, update message, list sessions, and transcript export primitives.
- Add corrupt DB and migration tests.

Verification:

- `bun test test/persistence test/session`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify secrets are not stored in session tables and workspace roots are modeled explicitly for multi-root support.

### PR 5: CLI Framework And Basic Commands

- Add `src/cli/index.ts`, `commands.ts`, `output.ts`.
- Add handlers for `version`, `diagnostics`, `config path`, `config get`, `config set`, `tools list`, and `run --help`.
- Wire `src/index.ts` as the executable entry point.
- Implement JSON output shape for `version --json` and `diagnostics --json`.
- Add parser tests, output tests, and exit-code tests.

Verification:

- `bun test test/cli`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts version --json`
- `bun src/index.ts diagnostics --json`
- `bun src/index.ts run --help`

Review:

Reviewer must verify command behavior is implemented through runtime/config services where applicable and that old yargs code was not copied.

### PR 6: Model Provider Abstraction With Fake Provider

- Add `src/model/provider.ts`, `model-service.ts`, `stream.ts`, `ai-sdk-provider.ts`.
- Implement `ModelProvider`, `ModelRequest`, and `ModelEvent` contracts from `SPEC.md`.
- Add a fake provider for deterministic tests.
- Support streaming text deltas, reasoning deltas, tool-call events, usage events, done, cancellation, and retry-safe error classification.
- Add OpenAI, Anthropic, OpenAI-compatible, and custom local endpoint config shapes, but gate real provider calls behind env/API key checks.

Verification:

- `bun test test/model`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify fake-provider tests cover streaming, cancellation, usage, and tool-call conversion without requiring real API keys.

### PR 7: Tool Registry, Permissions, And Safe Built-Ins

- Add `src/tools/tool.ts`, `registry.ts`, `permissions.ts`, `execution.ts`.
- Implement schema validation, permission decisions, timeout, cancellation, output bounding, and root checks.
- Add built-ins: `read`, `glob`, `grep`, `write`, `edit`, `apply_patch`, `bash`, `todowrite`, `question`, `webfetch`.
- Add OpenGrep as optional/fallback-aware tool using `opencode/packages/opencode/src/tool/opengrep.ts` and `packages/core/src/filesystem/opengrep.ts` as references.
- Keep Docker sandboxing out of this PR except for a disabled config placeholder.
- Add tests for validation, deny/allow/ask, output bounding, root restrictions, cancellation, and apply_patch behavior.

Verification:

- `bun test test/tools`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify write/edit/apply_patch/bash respect workspace roots and that denied tools return structured tool errors instead of throwing through the runtime.

### PR 8: Main Agent And One-Shot Run

- Add `src/agent/agent.ts`, `profiles.ts`, `main-agent.ts`, `prompts.ts`.
- Add `src/session/run.ts`, `context.ts`, `input-queue.ts`.
- Implement one active model run per session.
- Build model context from system prompt, persisted messages, workspace roots, selected tools, and agent profile.
- Implement model/tool loop with persisted assistant messages and tool results.
- Wire `oc2 run <prompt>` and `oc2 resume <session-id> --run <prompt>`.
- Implement `--json` final output with session id, final assistant text, tool calls, errors, usage, and exit status.

Verification:

- `bun test test/agent test/session test/cli/run.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts run "hello" --json --model fake/test`

Review:

Reviewer must verify fatal runtime errors keep sessions resumable and non-interactive failed runs exit non-zero.

### PR 9: Minimal TUI Shell

- Add `src/tui/app.tsx`, `keymap.ts`, `state.ts`.
- Add components: `SessionView`, `MessageList`, `PromptInput`, `SidePanel`, `ToolCallView`, `Footer`, `ErrorBanner`.
- Subscribe TUI state to the runtime event bus/projector.
- Support prompt submit, streaming assistant text, visible tool status, cancellation via `Ctrl+C`, side panel toggle via `Ctrl+S`, and basic resume.
- Keep session route split into small components; do not copy the large opencode session route directly.
- Add render/projector tests and a manual smoke script.

Verification:

- `bun test test/tui`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts tui --model fake/test`

Review:

Reviewer must verify TUI renders from projected event state rather than polling runtime internals and remains usable without MCP/team features enabled.

### PR 10: MCP Config, Runtime, And Tool Materialization

- Add `src/mcp/config.ts`, `mcp-service.ts`, `client.ts`, `tools.ts`, `status.ts`, `auth.ts`.
- Implement canonical config for `stdio`, `http`, and optional `sse`.
- Start enabled servers with timeout and structured status.
- Discover MCP tools and register them as namespaced oc2 tools, e.g. `mcp_<server>_<tool>`.
- Refresh on `tools/list_changed`.
- Route MCP invocation through the normal tool scheduler and permission service.
- Implement `oc2 mcp list`, `enable`, `disable`, and `test`.
- Mark OAuth-required servers as `auth_required`; defer full OAuth callback flow until stdio and unauthenticated HTTP stabilize.

Verification:

- `bun test test/mcp`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts mcp list`
- `bun src/index.ts mcp test <fake-server-id>`

Review:

Reviewer must verify MCP failures do not crash sessions, disabled servers are not started, and headers/tokens/env secrets are redacted from logs and TUI state.

### PR 11: subAgent Runtime

- Add `src/subagent/subagent-service.ts`, `subagent-tool.ts`, `permissions.ts`.
- Implement `CreateSubAgentInput` with `agentId`, `prompt`, `description`, `context`, `timeoutMs`, and `background`.
- Create child sessions with `parentSessionId`.
- Derive permissions from parent deny rules, external directory restrictions, and child profile allow/deny rules.
- Disable recursive subagents and team spawning from subagents by default.
- Implement foreground structured result and explicitly configured background mode.
- Add cancellation and timeout propagation.

Verification:

- `bun test test/subagent`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify child sessions do not receive full hidden parent state by default and that parent cancellation cancels child tasks.

### PR 12: Agent Team Core

- Add `src/team/team-service.ts`, `mailbox.ts`, `team-task.ts`, `team-tools.ts`, `prompts.ts`.
- Implement team create, spawn, shutdown, send message, broadcast, get messages, task create/list/claim/update.
- Persist teams, members, shared tasks, mailbox messages, and member lifecycle.
- Enforce bounded active team members per team.
- Implement dependency gates by member and shared task.
- Implement daemon lifecycle as long-lived child sessions with explicit reporting criteria.
- Add tool definitions: `team_create`, `team_spawn`, `team_send_message`, `team_broadcast`, `team_get_messages`, `team_task_create`, `team_task_claim`, `team_task_update`, `team_task_list`, `team_shutdown`.

Verification:

- `bun test test/team`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify task claims are transactional, daemon teammates cannot spam the lead without criteria, nested teams are disallowed, and one teammate failure does not cancel the whole team by default.

### PR 13: Team Plan Approval And Reporting

- Add `team_plan_submit`, `team_plan_decide`, and `team_report`.
- Add plan-mode member status and approval state.
- Implement team report summary with member statuses, shared task outcomes, mailbox counts, daemon states, deterministic findings, runtime/cost placeholders, and residual failures.
- Use `opencode/packages/opencode/src/team/eval.ts`, `tool/team_report.ts`, and `command/template/team-report.txt` as references.
- Add TUI projected state for pending plan approvals and report availability.

Verification:

- `bun test test/team/plan.test.ts test/team/report.test.ts`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify plan approval cannot be bypassed and report generation is deterministic for the same persisted team state.

### PR 14: Team, MCP, Agent, And Permission TUI Panels

- Add `AgentStatus`, `TeamPanel`, `McpPanel`, `PermissionDialog`, and question prompt UI.
- Show active team name/goal, members, lifecycle, dependencies, shared tasks, mailbox activity, daemon state, plan approvals, and report link/export action.
- Show MCP server status, tool count, auth required, last error, and active MCP tool calls.
- Show permission requests and denials in both message history and side panel.
- Add keyboard shortcuts: `Ctrl+T`, `Ctrl+M`, `Esc`.

Verification:

- `bun test test/tui`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts tui --model fake/test`

Review:

Reviewer must verify recoverable errors do not crash the TUI and narrow terminal behavior hides side panels without blocking prompt input.

### PR 15: Transcript Export, Multi-Root, Skills, And Repository Memory

- Implement `oc2 export <session-id> --format markdown|json`.
- Add `--recursive` export for child subagent/team transcripts.
- Implement multi-root session APIs and CLI `--root <path>...`.
- Add built-in skills under `src/skills/`: `spec-planner.md`, `spec-implement.md`, `team-report.md`, `clarify.md`, `initialize.md`.
- Add small SQLite-backed repository memory using `opencode/packages/opencode/src/memory/*` as reference.
- Add memory tool and CLI memory command only if it stays small; otherwise defer CLI memory to a follow-up.

Verification:

- `bun test test/session test/cli/export.test.ts test/tools/memory.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts export <fixture-session-id> --format markdown`
- `bun src/index.ts export <fixture-session-id> --format json`

Review:

Reviewer must verify recursive export preserves transcript order, memory is local-only, and repository memory does not include excluded GitHub review memory behavior.

### PR 16: Documentation, Hardening, And Release Readiness

- Update `README.md` with install, config, CLI, TUI, MCP, teams, permissions, diagnostics, and export docs.
- Add docs for config file examples and MCP examples.
- Add architecture notes explaining in-process runtime, event bus, scheduler limits, and deferred HTTP API.
- Add manual smoke checklist.
- Add dependency review notes documenting why each dependency is present.
- Add circular dependency check if practical.
- Add final quality-gate script if useful, e.g. `bun run check`.

Verification:

- `bun test`
- `bun run typecheck`
- `bun run lint`
- `bun run diagnostics`
- `bun src/index.ts version --json`
- `bun src/index.ts diagnostics --json`
- `bun src/index.ts run "hello" --json --model fake/test`

Review:

Reviewer must verify docs match actual commands and no deferred/out-of-scope feature is documented as shipped.

## Adversarial Review Process

For every PR slice:

- Spawn or assign a fresh read-only reviewer after the implementation diff exists.
- Reviewer input must include the slice tasks, `SPEC.md`, and the diff.
- Reviewer must check for scope creep, missing tests, hidden globals, unbounded concurrency, secret persistence, permission bypasses, and copied legacy architecture.
- Implementation is not complete until reviewer findings are resolved or explicitly accepted with rationale.

## Future Work

- Local HTTP/Event API over the same runtime services.
- Full MCP OAuth callback flow after stdio and unauthenticated HTTP are stable.
- Docker shell sandboxing after security review.
- Token/session optimization.
- Generated SDK/OpenAPI only if a server API becomes a stable external surface.
- Browser-use MCP default only after core MCP behavior is mature.
- Repository memory export/import.

## Open Questions

- Should `oc2` initialize as its own git repository in PR 1? Default: yes, if this is intended to be developed independently; otherwise leave git initialization to the user.
- Should real provider packages be installed in PR 6 or deferred behind fake provider only? Default: install minimal OpenAI, Anthropic, OpenAI-compatible support when the model service is introduced.
- Should repository memory CLI commands ship in PR 15? Default: include storage and tool first, defer CLI memory if it expands the review size.
