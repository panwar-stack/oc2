# oc2 Technical Specification

## 1. Executive Summary

`oc2` is a new lightweight local coding harness inspired by the local `opencode` repository at `/Users/srpanwar/Documents/Workspace/brain/opencode`. It must be built from scratch under the current `oc2` folder and must keep only the parts needed for terminal user interface and command line interface usage.

`oc2` must include:

- A terminal user interface for interactive coding sessions.
- A command line interface for local prompting, session resume, diagnostics, configuration, and scriptable output.
- A lightweight agent runtime with tool execution, streaming model responses, persisted sessions, cancellation, retries, and structured events.
- `subAgent` support for bounded delegated tasks.
- Agent team support for parallel local task orchestration, mailbox coordination, shared tasks, plan approval, daemon teammates, and team reporting.
- Model Context Protocol support for local and remote MCP servers, tool discovery, permissions, invocation, status display, and CLI controls.
- Carefully selected custom features from the local `opencode` fork: agent teams, daemon teammates, team reports, multi-root sessions, OpenGrep, transcript export, repository memory, built-in planning/report skills, and guarded Docker shell sandboxing.

`oc2` must intentionally exclude:

- Web app, browser UI, marketing site, account system, billing, subscriptions, organizations, hosted service logic, desktop app, Electron shell, Slack integrations, product analytics, cloud console, and generated SDK surfaces not required by local TUI/CLI usage.

The recommended strategy is not to copy the old monolithic `packages/opencode` application. Instead, use the newer `opencode` v2 package split as reference architecture:

- Reuse or adapt the ideas from `packages/cli`, `packages/tui`, `packages/core`, `packages/server`, and `packages/llm`.
- Selectively port mature features that still live in `packages/opencode`: MCP runtime, task/subagent tool, agent-team service and tools, and custom feature logic.
- Rewrite glue and architecture into a small, explicit `oc2` runtime with thin CLI/TUI adapters.

## 2. Repository Audit Summary

### Audited Repository

- Path: `/Users/srpanwar/Documents/Workspace/brain/opencode`
- Current branch: `master`
- Worktree state: clean
- Current HEAD: `5e2f62879f feat(opencode): add daemon teammate reporting and docs`
- Remotes: `origin=https://github.com/panwar-stack/opencode.git`, `upstream=https://github.com/anomalyco/opencode.git`
- Divergence: local `master` is 175 commits ahead and 170 commits behind `upstream/dev`
- Important local branch: `oc2`, which adds runtime/core extraction work beyond `master`

### Current Architecture

The audited repository has two overlapping architectures:

- New v2 architecture:
  - `packages/cli`: lightweight Effect CLI shell.
  - `packages/tui`: Solid/OpenTUI terminal application.
  - `packages/core`: session, tools, model resolution, permissions, persistence, runtime primitives.
  - `packages/server`: local HTTP/Event API over core.
  - `packages/llm`: provider/protocol abstraction and streaming model calls.

- Older monolithic application:
  - `packages/opencode`: mature CLI/session/runtime features, MCP runtime, subagent task tool, team orchestration, legacy prompt loop, older server routes, and many product integrations.

The v2 packages are the better architectural spine. The older package contains important custom features, but it is too broad and coupled to copy wholesale.

### Relevant Code Areas

- CLI entry points:
  - `packages/cli/src/index.ts`
  - `packages/cli/src/framework/runtime.ts`
  - `packages/cli/src/commands/commands.ts`
  - `packages/cli/src/commands/handlers/default.ts`
  - `packages/cli/src/commands/handlers/serve.ts`
  - `packages/cli/src/services/daemon.ts`

- TUI:
  - `packages/tui/src/app.tsx`
  - `packages/tui/src/context/sdk.tsx`
  - `packages/tui/src/context/sync.tsx`
  - `packages/tui/src/context/sync-v2.tsx`
  - `packages/tui/src/component/prompt/index.tsx`
  - `packages/tui/src/routes/session/index.tsx`
  - `packages/tui/src/routes/session/sidebar.tsx`
  - `packages/tui/src/routes/session/footer.tsx`
  - `packages/tui/src/routes/session/permission.tsx`
  - `packages/tui/src/routes/session/question.tsx`
  - `packages/tui/src/component/dialog-team.tsx`
  - `packages/tui/src/component/dialog-mcp.tsx`
  - `packages/tui/src/feature-plugins/sidebar/team.tsx`

- Session, message, runner, and tools:
  - `packages/core/src/session.ts`
  - `packages/core/src/session/message.ts`
  - `packages/core/src/session/input.ts`
  - `packages/core/src/session/runner/llm.ts`
  - `packages/core/src/session/runner/model.ts`
  - `packages/core/src/session/run-coordinator.ts`
  - `packages/core/src/session/execution/local.ts`
  - `packages/core/src/location-layer.ts`
  - `packages/core/src/tool/tool.ts`
  - `packages/core/src/tool/registry.ts`
  - `packages/core/src/tool/builtins.ts`
  - `packages/core/src/tool/application-tools.ts`

- Model provider runtime:
  - `packages/llm/src/index.ts`
  - `packages/llm/src/llm.ts`
  - `packages/llm/src/provider.ts`
  - `packages/llm/src/providers/index.ts`
  - `packages/llm/src/protocols/*`

- Agents and subagents:
  - `packages/core/src/agent.ts`
  - `packages/core/src/plugin/agent.ts`
  - `packages/opencode/src/tool/task.ts`
  - `packages/opencode/src/agent/subagent-permissions.ts`
  - `packages/opencode/src/tool/registry.ts`

- Agent teams:
  - `packages/opencode/src/team/team.ts`
  - `packages/opencode/src/team/team.sql.ts`
  - `packages/opencode/src/team/eval.ts`
  - `packages/opencode/src/team/README.md`
  - `packages/opencode/src/tool/team_*.ts`
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/team.ts`
  - `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts`
  - `packages/core/src/database/migration/20260511182000_team_tables.ts`
  - `packages/core/src/database/migration/20260612000000_add_team_member_daemon_lifecycle.ts`

- MCP:
  - `packages/opencode/src/mcp/index.ts`
  - `packages/opencode/src/mcp/auth.ts`
  - `packages/opencode/src/mcp/oauth-provider.ts`
  - `packages/opencode/src/mcp/oauth-callback.ts`
  - `packages/opencode/src/cli/cmd/mcp.ts`
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts`
  - `packages/core/src/config/mcp.ts`

### Reusable Code And Patterns

Reuse directly or closely adapt:

- Effect-based CLI command composition from `packages/cli`.
- OpenTUI/Solid renderer lifecycle, keymap, providers, and prompt component patterns from `packages/tui`.
- v2 session/message/tool abstractions from `packages/core`.
- LLM provider/protocol abstraction from `packages/llm`.
- SQLite persistence style and transaction patterns from core and team tables.
- Tool schema validation and output bounding from `packages/core/src/tool/*`.
- Permission ask UX and status propagation patterns.

Port selectively:

- MCP runtime from `packages/opencode/src/mcp/*`.
- Subagent task behavior from `packages/opencode/src/tool/task.ts`.
- Team service, mailbox, task tables, and team tools from `packages/opencode/src/team/*` and `packages/opencode/src/tool/team_*.ts`.
- Team reporting from `packages/opencode/src/team/eval.ts` and `packages/opencode/src/tool/team_report.ts`.
- Custom tools and skills such as OpenGrep, repository memory, planning/spec skills, and transcript export.

Rewrite from scratch:

- The oc2 package/module boundaries.
- Runtime scheduler API and bounded concurrency behavior.
- Team runtime integration into core, rather than app-level prompt-loop hooks.
- TUI session screen composition. `packages/tui/src/routes/session/index.tsx` is valuable but too large and must be split into smaller oc2 panels/controllers.
- MCP config normalization. Existing v1/v2 naming differences must not be preserved.
- CLI command set. Mine behavior and flags, but do not copy the legacy yargs CLI.

Exclude:

- `packages/app`, `packages/console`, `packages/desktop`, `packages/stats`, `packages/slack`, `packages/storybook`, marketing/web docs, billing/account/auth surfaces, cloud deployment scripts, generated SDK files, Slack/GitHub review product features, and desktop/browser UI code.

### Custom Features Found

Direct custom local features:

- Agent team orchestration.
- Team tools.
- Team reporting/evaluation.
- Daemon teammates.
- Teammate model variants.
- Structured team handoffs/plans on divergent local branch.
- Repository memory.
- Multi-root sessions.
- TUI team UI.
- Recursive TUI/transcript export.
- AI processing time/prompt footer elapsed time.
- OpenGrep tool.
- Docker shell sandboxing.
- Built-in commands and skills such as clarify, spec-planner, spec-implement, team-report, initialize, and learn.
- Runtime SDK/core extraction on local `oc2` branch.

Inferred or branch-only custom features:

- Browser-use MCP default/skill from `feature/browser-use`.
- Session token optimization from `feature/session-optimizer`.
- Historical supervisor features replaced by agent teams.

### Dependency Findings

Dependencies worth keeping for oc2:

- `typescript`
- `bun`
- `effect`
- `@effect/platform-node`
- `@effect/sql-sqlite-bun`
- `drizzle-orm`
- `zod`
- `ai`
- Selected `@ai-sdk/*` providers only as needed.
- `@modelcontextprotocol/sdk`
- `@opentui/core`
- `@opentui/keymap`
- `@opentui/solid`
- `solid-js`
- `@lydell/node-pty` or equivalent PTY bridge only if shell tool/TUI needs pseudo-terminal behavior.
- `cross-spawn`
- `jsonc-parser`
- `minimatch`
- `ignore`
- `ulid`

Dependencies to avoid unless a feature proves they are necessary:

- Electron and native desktop shell dependencies.
- Cloud/serverless tooling such as `sst`.
- Sentry/product telemetry dependencies.
- OpenAuth/account/auth dependencies unrelated to local MCP OAuth.
- Slack, GitHub review, GitLab product integration dependencies.
- Browser app stacks such as Vite/Tailwind/Solid Start for non-terminal surfaces.
- Distributed queue dependencies such as BullMQ.
- CPU worker pools such as Piscina for the first implementation.

### Architecture Risks

- The mature local features are split across old and new package architectures.
- Team orchestration currently lacks a central scheduler and relies on model/tool behavior.
- Some parallel team spawning uses unbounded concurrency.
- MCP config naming differs between v1 runtime and v2 schema.
- MCP OAuth has global process-level state.
- Permission inheritance differs between task subagents and team teammates.
- The large TUI session route is difficult to maintain if copied as-is.
- Generated SDK/OpenAPI files must not be manually copied.
- The v2 runner has gaps around durable ownership, retry/status, full MCP/plugin tool materialization, cancellation, snapshots/patches, and maintenance.

## 3. oc2 Product Scope

### Terminal User Interface Scope

`oc2` TUI must support:

- Interactive user sessions.
- Streaming assistant responses.
- Message history display.
- Prompt input box with multiline input, paste handling, and command hints.
- Keyboard navigation.
- Side panel for session state, tools, MCP servers, agents, team activity, errors, and diagnostics.
- Tool call visibility with pending/running/succeeded/failed/cancelled states.
- Agent and subagent status visibility.
- Team activity display.
- Permission prompts.
- Question prompts.
- Error display with recoverable/non-recoverable distinction.
- Session state display including session id, workspace roots, provider/model, current run status, token/time counters, and persistence status.
- Long-running task display with elapsed time and cancellation affordance.
- Clean cancellation of model streams, tool calls, subagents, team members, and MCP invocations.

### Command Line Interface Scope

`oc2` CLI must support:

- Start interactive TUI session.
- Run a single prompt non-interactively.
- Resume a session.
- Configure model/provider.
- Enable/disable built-in tools.
- Enable/disable MCP servers.
- Run diagnostics.
- Print version and environment information.
- Scriptable output for automation.
- Export transcript/session report.

### Agent Runtime Scope

`oc2` runtime must support:

- Main coding agent.
- Named agent profiles.
- `subAgent` support.
- Agent team support.
- Tool execution.
- Parallel task execution with bounded concurrency.
- Task queueing and priorities.
- Cancellation and timeout handling.
- Retry handling for retry-safe operations.
- Structured runtime events for TUI and CLI updates.
- Structured logs.
- Session/message persistence.
- Provider abstraction for model calls.

### MCP Scope

`oc2` MCP support must include:

- Local stdio servers.
- Remote Streamable HTTP servers.
- SSE fallback if required by the SDK and server capability.
- OAuth only for remote MCP servers that require it.
- Server discovery from config.
- Server startup and shutdown.
- Tool discovery and dynamic `tools/list_changed` refresh.
- Tool invocation with permission checks.
- Status and logs in TUI.
- CLI enable/disable and diagnostics.
- Minimal tests for config, startup, discovery, invocation, permission denial, failure, and shutdown.

## 4. Non Goals

Do not build:

- Web application.
- Browser-based UI.
- Desktop app.
- Electron or native desktop shell.
- Account system.
- Login/onboarding unrelated to local MCP OAuth.
- Billing, subscription, organizations, team billing.
- Hosted service control plane.
- Marketing site.
- Product analytics.
- Cloud telemetry by default.
- Slack integration.
- GitHub review memory feature.
- Generated SDK package as a first-class deliverable.
- Cloud deployment or serverless runtime.
- Distributed job queue.
- Multi-user hosted collaboration.

## 5. Proposed Architecture

### Architecture Principle

`oc2` must be a local-first TypeScript application with one runtime core and thin adapters. CLI and TUI must not own business logic. Server/Event APIs must exist only to support process separation and TUI synchronization when useful.

### Module Overview

- `cli`: command parsing, flags, command handlers, output formatting.
- `tui`: terminal rendering, input, side panel, dialogs, keybindings.
- `runtime`: process-level orchestration, lifecycle, cancellation scopes, scheduler, event bus.
- `session`: sessions, messages, message parts, run state, persistence integration.
- `agent`: main agent and agent profile definitions.
- `subagent`: child-agent task runtime.
- `team`: agent team runtime, members, mailbox, shared tasks, plan approval, reports.
- `tools`: tool definitions, registry, permissions, execution, built-in tools.
- `mcp`: MCP config, clients, server lifecycle, tool discovery, invocation.
- `model`: provider abstraction and model streaming.
- `scheduler`: bounded parallelism and task lifecycle.
- `events`: typed event bus for runtime/TUI/CLI/server.
- `persistence`: SQLite schema, migrations, repositories.
- `config`: config files, env overrides, validation.
- `logging`: structured logs, diagnostics, redaction.
- `diagnostics`: health checks, environment, dependency status.
- `tests`: unit, integration, and TUI smoke tests.

### Runtime Shape

The core runtime must expose explicit services:

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

The runtime must run in one local process for the first implementation. A local API server is optional and should only wrap the same services.

### Event Bus

All user-visible runtime changes must be emitted as typed events. TUI should render from event-derived state, not by polling runtime internals.

Event categories:

- Session created/resumed/closed.
- Message appended/updated.
- Model stream started/delta/completed/failed/cancelled.
- Tool call started/progress/completed/failed/cancelled.
- Permission requested/resolved.
- Subagent created/progress/completed/failed/cancelled.
- Team created/member updated/task updated/message delivered/report generated/shutdown.
- MCP server status/tool list changed/tool invocation events.
- Scheduler task queued/started/progress/completed/failed/cancelled/timed out.
- Diagnostic warning/error.

### Persistence

Use local SQLite via Drizzle or Effect SQL. Persist:

- Sessions.
- Workspace roots.
- Messages and message parts.
- Tool calls and results.
- Agent profiles used by sessions.
- Subagent tasks.
- Team, team members, team tasks, team messages, team usage events.
- MCP server status snapshots and auth metadata references.
- Config-derived state only where needed.

Do not persist secrets in the session database. Store API keys and MCP OAuth secrets in OS-appropriate secure storage when available, or in a clearly documented local auth file with restrictive permissions as a fallback.

## 6. Proposed Project Structure

```text
oc2/
  package.json
  bun.lock
  tsconfig.json
  oxlint.json
  README.md
  specs/
    01-oc2-spec.md
    02-implementation-plan.md
  src/
    index.ts
    cli/
      index.ts
      commands.ts
      output.ts
      commands/
        run.ts
        tui.ts
        resume.ts
        config.ts
        mcp.ts
        tools.ts
        diagnostics.ts
        export.ts
        version.ts
    tui/
      app.tsx
      keymap.ts
      state.ts
      components/
        SessionView.tsx
        MessageList.tsx
        PromptInput.tsx
        SidePanel.tsx
        ToolCallView.tsx
        AgentStatus.tsx
        TeamPanel.tsx
        McpPanel.tsx
        PermissionDialog.tsx
        ErrorBanner.tsx
        Footer.tsx
      routes/
        session.tsx
      render/
        markdown.ts
        diff.ts
    runtime/
      index.ts
      create-runtime.ts
      lifecycle.ts
      cancellation.ts
      errors.ts
    events/
      event-bus.ts
      events.ts
      projector.ts
    config/
      config.ts
      schema.ts
      load.ts
      paths.ts
      env.ts
    session/
      session-service.ts
      message.ts
      input-queue.ts
      run.ts
      context.ts
      transcript.ts
    model/
      model-service.ts
      provider.ts
      ai-sdk-provider.ts
      stream.ts
    agent/
      agent.ts
      profiles.ts
      main-agent.ts
      prompts.ts
    subagent/
      subagent-service.ts
      subagent-tool.ts
      permissions.ts
    team/
      team-service.ts
      team-tools.ts
      mailbox.ts
      team-task.ts
      report.ts
      prompts.ts
    tools/
      tool.ts
      registry.ts
      permissions.ts
      execution.ts
      builtins/
        apply-patch.ts
        bash.ts
        edit.ts
        glob.ts
        grep.ts
        opengrep.ts
        read.ts
        write.ts
        question.ts
        todowrite.ts
        webfetch.ts
        skill.ts
        memory.ts
    mcp/
      config.ts
      mcp-service.ts
      client.ts
      auth.ts
      tools.ts
      status.ts
    scheduler/
      scheduler.ts
      task.ts
      queue.ts
      priority.ts
    persistence/
      db.ts
      schema.ts
      migrations.ts
      repositories/
        sessions.ts
        messages.ts
        teams.ts
        mcp.ts
    logging/
      logger.ts
      redaction.ts
    diagnostics/
      diagnostics.ts
      environment.ts
      dependency-checks.ts
    skills/
      spec-planner.md
      spec-implement.md
      team-report.md
      clarify.md
      initialize.md
    testing/
      fakes.ts
      fixtures.ts
  test/
    cli/
    tui/
    runtime/
    session/
    agent/
    subagent/
    team/
    tools/
    mcp/
    scheduler/
    persistence/
```

The first implementation may keep everything under one package. Do not introduce a monorepo until there is a concrete need.

## 7. Data Model

### Common Types

```ts
type ID = string
type Timestamp = string

type RuntimeStatus = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out"
```

### Session

```ts
interface Session {
  id: ID
  title: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  workspaceRoots: WorkspaceRoot[]
  providerId: string
  modelId: string
  agentId: string
  status: RuntimeStatus
  parentSessionId?: ID
  teamId?: ID
  metadata: Record<string, unknown>
}

interface WorkspaceRoot {
  id: ID
  path: string
  label?: string
  readonly: boolean
}
```

### Message

```ts
type MessageRole = "system" | "user" | "assistant" | "tool" | "synthetic"

interface Message {
  id: ID
  sessionId: ID
  role: MessageRole
  createdAt: Timestamp
  updatedAt: Timestamp
  parts: MessagePart[]
  status: RuntimeStatus
  parentMessageId?: ID
  modelId?: string
  usage?: TokenUsage
  error?: RuntimeError
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; redacted?: boolean }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "tool-result"; result: ToolResult }
  | { type: "file"; path: string; mime?: string; text?: string }
  | { type: "event"; eventId: ID }
```

### Agent

```ts
interface AgentProfile {
  id: string
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  systemPrompt: string
  defaultModel?: string
  allowedTools: ToolPermissionRule[]
  maxIterations: number
  timeoutMs?: number
}
```

### subAgent

```ts
interface SubAgentTask {
  id: ID
  parentSessionId: ID
  childSessionId: ID
  agentId: string
  prompt: string
  status: RuntimeStatus
  createdAt: Timestamp
  startedAt?: Timestamp
  completedAt?: Timestamp
  result?: SubAgentResult
  error?: RuntimeError
  permissions: ToolPermissionRule[]
  timeoutMs?: number
}

interface SubAgentResult {
  summary: string
  messageId: ID
  artifacts?: ArtifactRef[]
}
```

### Agent Team

```ts
interface AgentTeam {
  id: ID
  leadSessionId: ID
  name: string
  goal: string
  status: RuntimeStatus
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface TeamMember {
  id: ID
  teamId: ID
  name: string
  role: "lead" | "teammate" | "daemon"
  sessionId: ID
  agentId: string
  lifecycle: "task" | "daemon"
  status: RuntimeStatus
  dependsOn: ID[]
  modelVariant?: string
  planMode: boolean
  metadata: Record<string, unknown>
}

interface TeamTask {
  id: ID
  teamId: ID
  description: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  assigneeMemberId?: ID
  dependencyTaskIds: ID[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface TeamMessage {
  id: ID
  teamId: ID
  senderMemberId: ID
  recipientMemberIds: ID[]
  body: string
  createdAt: Timestamp
  deliveredAt?: Timestamp
}
```

### Task Scheduler

```ts
interface RuntimeTask<T = unknown> {
  id: ID
  kind: "model" | "tool" | "subagent" | "team-member" | "mcp" | "diagnostic"
  sessionId?: ID
  priority: number
  status: RuntimeStatus
  timeoutMs?: number
  signal: AbortSignal
  run: (ctx: TaskContext) => Promise<T>
}

interface TaskContext {
  taskId: ID
  signal: AbortSignal
  emit: (event: RuntimeEvent) => void
  log: LogService
}
```

### Tool

```ts
interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<Input>
  permission: ToolPermissionSpec
  timeoutMs?: number
  run(input: Input, context: ToolContext): Promise<Output>
}

interface ToolCall {
  id: ID
  name: string
  input: unknown
  status: RuntimeStatus
  startedAt?: Timestamp
  completedAt?: Timestamp
}

interface ToolResult {
  toolCallId: ID
  output?: unknown
  error?: RuntimeError
  metadata?: Record<string, unknown>
}
```

### Model Provider

```ts
interface ModelProvider {
  id: string
  name: string
  listModels(): Promise<ModelInfo[]>
  stream(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent>
}

interface ModelRequest {
  sessionId: ID
  modelId: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  temperature?: number
  maxTokens?: number
  signal: AbortSignal
}

type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" }
```

### MCP Server

```ts
interface McpServerConfig {
  id: string
  name?: string
  enabled: boolean
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig
  toolPermissions?: ToolPermissionRule[]
  startupTimeoutMs?: number
}

interface McpServerStatus {
  id: string
  status: "disabled" | "starting" | "connected" | "auth_required" | "failed" | "stopped"
  tools: McpToolInfo[]
  lastError?: RuntimeError
}
```

### Runtime Event

```ts
type RuntimeEvent =
  | { type: "session.created"; session: Session }
  | { type: "message.updated"; message: Message }
  | { type: "model.delta"; sessionId: ID; messageId: ID; delta: string }
  | { type: "tool.started"; sessionId: ID; call: ToolCall }
  | { type: "tool.completed"; sessionId: ID; result: ToolResult }
  | { type: "subagent.updated"; task: SubAgentTask }
  | { type: "team.updated"; team: AgentTeam }
  | { type: "team.member.updated"; member: TeamMember }
  | { type: "mcp.status"; status: McpServerStatus }
  | { type: "task.updated"; taskId: ID; status: RuntimeStatus }
  | { type: "error"; error: RuntimeError }
```

### Error Type

```ts
interface RuntimeError {
  code: string
  message: string
  recoverable: boolean
  cause?: unknown
  details?: Record<string, unknown>
}
```

### Configuration

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

## 8. Runtime Flow

### Starting oc2

1. CLI starts from `src/index.ts`.
2. CLI parses command and flags.
3. Config service loads project config, user config, and environment overrides.
4. Runtime creates logging, persistence, scheduler, event bus, tool registry, model service, MCP service, and session service.
5. Diagnostics run lightweight startup checks.
6. Command handler starts TUI, one-shot prompt, resume, diagnostics, or config command.

### Loading Configuration

1. Load default config.
2. Load user config from `~/.config/oc2/config.jsonc`.
3. Load project config from `./oc2.jsonc` or `./.oc2/config.jsonc`.
4. Apply environment variables.
5. Validate with Zod.
6. Normalize paths and MCP config keys.
7. Emit config warnings for unknown keys, disabled servers, missing commands, or missing API keys.

### Starting Interactive TUI Session

1. CLI command `oc2` or `oc2 tui` starts runtime.
2. Runtime creates or resumes a session.
3. TUI subscribes to event bus and builds projected state.
4. TUI renders session layout, message list, side panel, prompt input, and footer.
5. MCP servers configured as enabled start in background tasks.
6. Tool registry materializes built-in and MCP tools.

### Sending A User Message

1. Prompt input submits text and optional file/context attachments.
2. Session service appends a user message.
3. Session run is queued through the scheduler.
4. TUI updates message history and run status.
5. Agent runtime builds model context and available tools.

### Calling The Model

1. Model service resolves provider and model.
2. Model request includes messages, system prompt, tool definitions, and abort signal.
3. Streaming deltas append to assistant message parts.
4. Tool calls emitted by model become scheduler tasks.
5. Usage and completion events update message/session state.

### Running Tools

1. Tool registry validates tool name and input schema.
2. Permission service checks configured allow/deny rules.
3. If needed, runtime emits permission request and pauses the tool task.
4. Tool executes with bounded timeout and abort signal.
5. Tool result is persisted and appended to the assistant turn.
6. Agent runtime continues model loop when tool results require another model call.

### Starting subAgents

1. Main agent invokes the `task`/`subagent` tool.
2. SubAgent service validates requested agent profile and permissions.
3. Child session is created with parent link.
4. Child task is queued through the scheduler.
5. Progress events are visible to the parent session and TUI.
6. Result summary is returned as a tool result.

### Running Agent Team Tasks

1. Lead agent creates a team with name and goal.
2. Lead agent creates shared tasks where useful.
3. Lead agent spawns teammates through bounded scheduler queues.
4. Teammates run as child sessions with isolated context and permissions.
5. Mailbox messages are persisted and delivered as synthetic context blocks on the next teammate turn.
6. Dependencies delay teammates until required members complete.
7. Lead synthesizes final output from teammate results and team state.

### Streaming Progress To TUI

1. Runtime emits typed events for model, tool, subagent, team, scheduler, and MCP changes.
2. TUI projector updates local state incrementally.
3. Message list shows streaming assistant text.
4. Side panel shows active tasks, team members, MCP status, errors, and permissions.
5. Footer shows provider/model, roots, elapsed processing time, and cancellation hint.

### Persisting Session State

1. Session/message/tool/team events are committed to SQLite in transactional boundaries.
2. Streaming text can be persisted in coalesced batches to avoid write amplification.
3. On restart, session service reconstructs state from persisted records.

### Cancelling A Task

1. User presses cancel in TUI or sends CLI interrupt.
2. Runtime resolves active task scope for current session.
3. Abort signal propagates to model stream, running tools, MCP calls, subagents, and team members when requested.
4. Tasks transition to `cancelled` unless already completed.
5. Partial output remains visible and marked cancelled.
6. Runtime releases resources and emits cancellation events.

### Handling Errors

1. Expected errors return `RuntimeError` with code and recoverability.
2. Tool/model/MCP errors are persisted on the relevant result/message.
3. TUI displays concise error banners and detailed expandable error state.
4. CLI non-interactive mode exits with non-zero status for failed prompt execution.
5. Runtime logs structured error details with secrets redacted.

### Exiting Cleanly

1. TUI stops accepting input.
2. Runtime cancels or drains active tasks based on command mode.
3. MCP servers stop.
4. SQLite connection closes.
5. Event bus completes.
6. Process exits with appropriate status code.

## 9. Terminal User Interface Specification

### Layout

Default layout:

- Main panel: message history and streaming assistant output.
- Bottom prompt: multiline input box, command hints, current mode.
- Right side panel: session, tools, agents, team, MCP, errors, diagnostics.
- Footer: workspace roots, provider/model, token usage, elapsed run time, MCP count, active task count, cancel hint.

The side panel must be collapsible. The TUI must remain usable in narrow terminals by hiding the side panel and exposing details via dialogs.

### Message History

- Render user, assistant, tool, synthetic, and error messages distinctly.
- Stream assistant deltas without flicker.
- Collapse long tool output by default and allow expansion.
- Show cancelled/incomplete messages clearly.
- Preserve transcript order across resumed sessions.

### Prompt Input

- Multiline editing.
- Paste handling.
- Submit on configured keybinding.
- Command palette prefix support for local commands.
- File/path context insertion.
- Clear disabled state while shutdown is in progress.

### Keyboard Shortcuts

Required defaults:

- `Enter`: submit when not in multiline insert mode.
- `Shift+Enter`: newline.
- `Ctrl+C`: cancel active run; second `Ctrl+C` exits.
- `Ctrl+L`: clear visible scrollback without deleting session.
- `Ctrl+R`: resume/select session.
- `Ctrl+S`: toggle side panel.
- `Ctrl+T`: open team dialog.
- `Ctrl+M`: open MCP dialog.
- `Esc`: close dialog or cancel pending prompt focus.

### Side Panel

Side panel sections:

- Session: id, title, roots, status, provider/model.
- Current run: elapsed time, active model stream, active tools, cancel control.
- Tools: enabled tools, active calls, permission state.
- Agents: active main agent, subagents, agent status.
- Team: active team, members, shared tasks, mailbox events, daemon labels.
- MCP: server status, tools discovered, auth required, errors.
- Diagnostics: warnings and recent recoverable errors.

### Tool Call Visibility

Every tool call must show:

- Tool name.
- Input summary.
- Status.
- Elapsed time.
- Permission state.
- Output summary or error.
- Cancellation status.

### Agent Status Visibility

Show:

- Main agent status.
- subAgent task status.
- Team member status.
- Pending dependency/wait reason.
- Daemon teammate idle/running/error state.
- Model/provider variant if selected.

### Error States

- Recoverable errors should not crash TUI.
- Fatal errors should show final screen with log path and exit code.
- MCP auth errors should show server-specific remediation.
- Permission denials should be visible in message history and tool state.

### Long Running Tasks

- Display elapsed time in footer and task rows.
- Emit progress events when tools/subagents/teams can report progress.
- Allow cancellation from TUI.
- Do not block input rendering while tasks run.

## 10. Command Line Interface Specification

### Commands

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

### Flags

- `--model <provider/model>` overrides configured model.
- `--provider <id>` and `--model-id <id>` may be accepted as explicit alternatives.
- `--root <path>` adds a workspace root.
- `--json` emits scriptable JSON.
- `--no-tui` forces non-interactive mode.
- `--timeout <ms>` sets run timeout.
- `--max-concurrency <n>` overrides scheduler concurrency for the process.
- `--tool <name>` enables a tool for the run.
- `--no-tool <name>` disables a tool for the run.
- `--mcp <id>` enables an MCP server for the run.
- `--no-mcp <id>` disables an MCP server for the run.

### Configuration Files

Supported config paths:

- User: `~/.config/oc2/config.jsonc`
- Project: `./oc2.jsonc`
- Project directory: `./.oc2/config.jsonc`

Project config overrides user config. CLI flags override both.

### Environment Variables

- `OC2_CONFIG`: explicit config path.
- `OC2_DATA_DIR`: local data directory.
- `OC2_LOG_LEVEL`: log level.
- `OC2_MODEL`: `provider/model` default.
- Provider-specific API keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or configured provider env names.
- `OC2_EXPERIMENTAL_DOCKER_SANDBOX`: opt-in shell sandbox.

### Scriptable Output

`oc2 run --json` must emit newline-delimited or final JSON with:

- Session id.
- Final assistant text.
- Tool calls.
- Errors.
- Usage.
- Exit status.

## 11. Agent Runtime Specification

### Main Agent Behavior

- Each session has one active primary agent.
- The primary agent builds a model request from system prompt, persisted messages, selected tools, active roots, and optional team context.
- The primary agent can call tools, create subagents, and manage teams only if allowed by config and permissions.
- The primary agent must emit events for every material state change.

### Tool Use

- Tool calls must be schema-validated before execution.
- Tools must receive an abort signal.
- Tools must have timeout defaults.
- Tools must return structured results.
- Tool output must be bounded before re-entering model context.
- File-writing tools must respect workspace roots and permission rules.

### Planning And Execution

- Do not require a separate planning framework.
- Provide optional built-in skills/prompts for planning and spec implementation.
- Keep planning text as normal messages unless a tool requires structured output.

### Error Handling

- Retriable provider/network errors may retry with bounded backoff.
- Tool validation errors must not retry.
- Permission denials must be surfaced as normal tool results.
- Fatal runtime errors must stop the current run and keep the session resumable.

### Session Integration

- Every agent run belongs to a session.
- Child agent sessions must link to parent session.
- Synthetic context messages must be clearly marked and not confused with user messages.

## 12. subAgent Specification

### Creation

A subAgent is created by a tool call from the main agent:

```ts
interface CreateSubAgentInput {
  agentId: string
  prompt: string
  description?: string
  context?: string
  timeoutMs?: number
  background?: boolean
}
```

The service must:

- Validate the agent exists and has mode `subagent` or `all`.
- Create a child session with `parentSessionId`.
- Derive permissions from parent session and agent profile.
- Queue the child run through the scheduler.

### Receiving A Task

The subAgent receives:

- Its system prompt.
- The explicit task prompt.
- A bounded summary of parent context.
- Explicit workspace roots.
- Explicit allowed tools.
- Optional file/context attachments.

It must not receive the full parent hidden state by default.

### Reporting Progress

SubAgent progress must be reported through runtime events:

- `subagent.updated`
- `message.updated` for child session messages.
- `tool.started` and `tool.completed` for child tools.
- `task.updated` for scheduler state.

### Returning Output

Foreground subagents return a structured tool result:

```ts
interface SubAgentToolOutput {
  taskId: ID
  childSessionId: ID
  status: RuntimeStatus
  summary: string
  error?: RuntimeError
}
```

Background subagents return immediately with task id and report completion through events. Background mode must be explicitly enabled in config.

### Supervision

The main agent supervises subAgents by:

- Setting task instructions.
- Receiving progress events.
- Cancelling child tasks when parent is cancelled.
- Reading final output as tool result.
- Deciding whether to incorporate results into final response.

### Context Sharing

- Parent-to-child sharing is explicit and bounded.
- Child-to-parent sharing happens through result summary and persisted child session link.
- Shared file changes happen through tools and are visible in workspace.

### Isolation

- Each subAgent has a child session.
- Each subAgent has its own message history.
- Tool permissions are scoped per child session.
- Child agents cannot spawn teams by default.
- Recursive subagents are disabled unless explicitly allowed.

### Permission Scope

Normalize opencode’s divergent permission behavior:

- Inherit parent session deny rules.
- Inherit external-directory restrictions.
- Apply child agent allow/deny rules.
- Deny `team_create` and `team_spawn` inside subagents by default.
- Deny write/edit/bash/apply_patch in plan-only subagents.

### Failure And Cancellation

- SubAgent failure becomes a tool result error and TUI side-panel error.
- Parent cancellation propagates to child task by default.
- Child timeout does not crash parent runtime.
- Partial child transcript remains available.

## 13. Agent Team Specification

### Team Roles

- Lead: the primary session that creates and supervises the team.
- Teammate: finite task worker with a child session.
- Daemon teammate: long-lived monitor/checklist/sentinel worker.
- Reviewer: ordinary teammate role convention for read-only review.
- Verifier: ordinary teammate role convention for running tests/checks.

Roles are behavior conventions in prompts plus permissions, not separate runtime classes except for daemon lifecycle.

### Work Decomposition

- The lead creates shared tasks before broad work when multiple steps exist.
- The lead spawns focused teammates for independent work.
- Dependencies must be explicit by member id/name or shared task id.
- The runtime must not rely on unbounded sibling tool-call execution for safe parallelism.

### Task Assignment

Team tools:

- `team_create`
- `team_spawn`
- `team_send_message`
- `team_broadcast`
- `team_get_messages`
- `team_task_create`
- `team_task_claim`
- `team_task_update`
- `team_task_list`
- `team_plan_submit`
- `team_plan_decide`
- `team_report`
- `team_shutdown`

Shared task rules:

- Only dependency-satisfied tasks can be claimed.
- Task claims are transactional.
- Only lead or assignee can update an assigned task.
- Shared tasks are bookkeeping; spawning teammates is separate.

### Coordination

- Mailbox messages are persisted.
- Messages wake idle teammate sessions.
- Busy teammates receive messages at the next prompt boundary.
- Lead receives teammate final results as team events and messages.
- Daemon teammates report only on configured criteria to avoid spam.

### Conflict Resolution

- Avoid concurrent writes to the same file by instruction and tool permissions.
- TUI must show active writers/tool calls.
- Runtime should not merge conflicting edits automatically.
- If conflict is detected, surface it to lead and require a decision.

### Shared Context

- Team goal is shared with all members.
- Shared tasks and mailbox are shared.
- Each teammate has isolated message history.
- Teammates can read workspace files through tools subject to permissions.
- Teammates do not receive every other teammate’s full transcript unless lead shares summaries.

### Final Output Synthesis

- Lead synthesizes final response.
- Team report can provide run summary, member statuses, task outcomes, usage, and deterministic findings.
- TUI export should include recursive team transcripts when requested.

### TUI Team Display

Show:

- Active team name and goal.
- Member list with status, model, lifecycle, dependency wait state.
- Shared tasks and assignees.
- Mailbox messages.
- Pending plan approvals.
- Daemon teammate state.
- Team report link/export action.

### CLI Team Mode

Examples:

```text
oc2 run "audit this repo" --team
oc2 tui --team
oc2 export <session-id> --format markdown --recursive
```

Team mode should be opt-in for `run`, available by default inside TUI only when config enables team tools.

### Keeping Teams Lightweight

- Use local SQLite and in-process scheduler.
- No Redis, no distributed queue, no hosted coordinator.
- No multi-user collaboration.
- No nested teams.
- Bounded concurrency by default.
- Clear cancellation and shutdown.

## 14. Model Context Protocol Specification

### Configuration Format

Use one canonical config shape. Do not preserve v1/v2 naming drift.

```jsonc
{
  "mcp": {
    "filesystem": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": ".",
      "env": {},
      "startupTimeoutMs": 10000,
    },
    "remote-example": {
      "enabled": false,
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": {},
      "oauth": {
        "clientId": "...",
        "clientSecretEnv": "REMOTE_MCP_CLIENT_SECRET",
        "redirectUri": "http://127.0.0.1:17777/callback",
        "callbackPort": 17777,
      },
    },
  },
}
```

### Server Discovery

- Load servers from config.
- Ignore disabled servers unless explicitly enabled by CLI flag.
- Validate required fields by transport.
- Emit diagnostic warnings for invalid server configs.

### Server Startup

- Start enabled servers during runtime startup or lazily before first tool discovery.
- Local stdio servers run with configured cwd/env.
- Remote servers connect via Streamable HTTP; SSE fallback is allowed if the SDK requires it.
- Startup has timeout and structured error.

### Tool Discovery

- On connect, list tools and map MCP schema to oc2 tool definitions.
- Prefix or namespace tool names to avoid collisions, e.g. `mcp_<server>_<tool>`.
- Watch `tools/list_changed` and refresh discovered tools.

### Tool Invocation

- MCP tools execute through normal tool scheduler.
- Each invocation receives abort signal and timeout.
- Permission key must include server id and tool name.
- Result content must be normalized into text/json/blob metadata that can be displayed and passed back to the model.

### Permission Model

- Server startup permission is controlled by config.
- Tool invocation permission is checked per call.
- Default policy is ask for MCP tools unless explicitly allowed.
- Sensitive env vars and auth tokens must be redacted from logs and TUI.

### Error Handling

- Auth required: mark server `auth_required`, show in TUI, expose `oc2 mcp auth <id>` in future if needed.
- Startup failure: mark server failed; do not crash session.
- Tool failure: return tool result error.
- Tool list changes: refresh without interrupting active calls.

### Logging

- Log server lifecycle, tool discovery, invocation start/end, errors.
- Redact headers, tokens, env secrets.

### TUI Display

- Show server status.
- Show discovered tool count.
- Show auth-required state.
- Show last error.
- Show active MCP tool calls in tool list.

### CLI Controls

```text
oc2 mcp list
oc2 mcp enable <id>
oc2 mcp disable <id>
oc2 mcp test <id>
```

### Minimal Test Plan

- Config validation for stdio and HTTP servers.
- Disabled server is not started.
- Invalid server emits diagnostic.
- Fake stdio server connects and lists tools.
- Fake tool invocation succeeds.
- Permission denial returns tool error.
- Startup timeout marks server failed.
- Tool list changed refreshes tool registry.

## 15. Task Scheduling And Parallelism Specification

### Recommendation

Primary approach: use `Effect` fibers, scopes, queues, semaphores, timeout, retry, and interruption as the structured concurrency runtime.

Fallback approach: use a tiny native Promise-based limiter at non-Effect boundaries, backed by `AbortController`, explicit timeout wrappers, and typed events.

Do not add `p-limit`, `p-queue`, Bottleneck, Piscina, BullMQ, or worker threads in the first implementation.

### Option Comparison

| Option              | Fit                                      | Cancellation                   | Timeout      | Priority         | Progress          | Overhead | TS Quality    | Complexity | oc2 Decision                |
| ------------------- | ---------------------------------------- | ------------------------------ | ------------ | ---------------- | ----------------- | -------- | ------------- | ---------- | --------------------------- |
| Effect              | Excellent for local structured runtime   | Strong interruption model      | Strong       | Build via queues | Strong via events | Medium   | Strong        | Medium     | Primary                     |
| Native Promise pool | Good for small boundaries                | Manual AbortController         | Manual       | Manual           | Manual            | Low      | Good if typed | Low-medium | Fallback                    |
| p-limit             | Good for simple concurrency caps         | Manual                         | Manual       | No               | External          | Low      | Good          | Low        | Avoid unless tiny edge case |
| p-queue             | Good queue utility                       | Manual                         | Some support | Yes              | External          | Low      | Good          | Medium     | Not needed if using Effect  |
| Bottleneck          | Rate limiting, not runtime orchestration | Weak/manual                    | Manual       | Some             | External          | Medium   | OK            | Medium     | Avoid                       |
| Piscina             | CPU-bound worker pool                    | Worker cancellation complexity | Yes          | Queue options    | External          | High     | Good          | High       | Avoid until CPU-bound need  |
| BullMQ              | Distributed durable queue                | Job-level, Redis-dependent     | Yes          | Yes              | Events            | High     | Good          | High       | Exclude                     |
| worker_threads      | CPU isolation                            | Manual                         | Manual       | Manual           | Manual            | High     | Native        | High       | Exclude first pass          |

### How Concurrency Is Limited

Defaults:

- Model runs per session: 1 active run.
- Tool calls per session: 4.
- Global tool calls: 8.
- Subagents per parent session: 3.
- Team members active per team: 4.
- MCP calls per server: 2.

These limits must be configurable.

### Cancellation

- Each runtime task has an AbortSignal.
- Effect interruption must trigger AbortController abort for underlying JS APIs.
- Parent cancellation propagates to child scopes.
- Team shutdown cancels active member sessions and daemon tasks.

### Timeouts

- Every model/tool/MCP/subagent/team-member task can have timeout.
- Timeout emits `timed_out` state and cancels underlying task.
- Timeout errors must include task id and kind.

### Priorities

Priority classes:

- User cancellation and shutdown: highest.
- Permission/question response handling: high.
- Active foreground model/tool run: normal.
- Background subagents/team members: lower.
- Diagnostics/background MCP refresh: low.

### Task Events

Scheduler must emit:

- queued
- started
- progress
- completed
- failed
- cancelled
- timed_out

### Failure Isolation

- Tool failure does not crash session runtime.
- One teammate failure does not cancel the whole team unless configured.
- MCP server failure does not disable other servers.
- Scheduler should preserve task error details and continue draining unrelated tasks.

### Workload Coordination

- Parallel subAgent tasks use subagent queue limits.
- Agent team members use team-member queue limits and dependency gates.
- Tool calls use tool queue limits and per-server MCP limits.
- Long-running coding tasks emit heartbeat/progress events.
- TUI receives progress from event bus projector.

## 16. Migration Plan From opencode To oc2

### Phase 1: Project Skeleton

- Goal: create minimal TypeScript/Bun project with tests and lint/typecheck scripts.
- Inspect: root `package.json`, `packages/cli/package.json`, `packages/core/package.json`.
- Copy: no runtime code.
- Adapt: package scripts and compiler settings.
- Rewrite: project layout.
- Exclude: monorepo complexity unless required.
- Tests: smoke test imports and config loader.
- Acceptance: `bun test`, `bun run typecheck`, and `bun run lint` pass.

### Phase 2: Config, Logging, Persistence, Events

- Goal: build runtime foundation.
- Inspect: `packages/core/src/config/*`, database migrations, event projector patterns.
- Copy: only schema ideas.
- Adapt: SQLite/Drizzle transaction style.
- Rewrite: config schema and event bus.
- Exclude: product config keys.
- Tests: config precedence, migration, event projection.
- Acceptance: runtime can initialize and close cleanly.

### Phase 3: CLI

- Goal: implement local command set.
- Inspect: `packages/cli/src/index.ts`, `commands.ts`, handlers.
- Copy: command composition style if licensing permits.
- Adapt: default TUI/run/resume/diagnostics flows.
- Rewrite: command list and output.
- Exclude: old yargs CLI spine.
- Tests: CLI parser, JSON output, exit codes.
- Acceptance: `oc2 version`, `oc2 diagnostics`, `oc2 run --help` work.

### Phase 4: Model Provider Runtime

- Goal: streaming model abstraction.
- Inspect: `packages/llm/src/*`, `packages/core/src/session/runner/model.ts`.
- Copy/adapt: provider/protocol separation.
- Rewrite: oc2 provider registry with selected providers.
- Exclude: unnecessary provider packages initially.
- Tests: fake provider streaming, tool-call event conversion, cancellation.
- Acceptance: one-shot prompt streams fake model response.

### Phase 5: Session And Agent Runtime

- Goal: main agent loop with persisted messages.
- Inspect: `packages/core/src/session.ts`, `session/message.ts`, `session/input.ts`, `session/runner/llm.ts`.
- Copy/adapt: message model and run-coordinator concepts.
- Rewrite: simpler agent loop.
- Exclude: incomplete v2 TODO paths unless implemented cleanly.
- Tests: message persistence, run serialization, cancellation, retry-safe errors.
- Acceptance: session can run, persist, resume, and cancel.

### Phase 6: Tool Registry And Built-ins

- Goal: schema-validated tool execution.
- Inspect: `packages/core/src/tool/*`, `packages/opencode/src/tool/opengrep.ts`, shell sandbox specs.
- Copy/adapt: tool definition wrapper, output bounding, OpenGrep behavior.
- Rewrite: permissions and execution service.
- Exclude: product tools not needed for local coding.
- Tests: read/write/edit/bash/glob/grep/opengrep/apply_patch permissions and cancellation.
- Acceptance: model can call tools and receive results.

### Phase 7: TUI

- Goal: interactive terminal session.
- Inspect: `packages/tui/src/app.tsx`, prompt, sidebar, footer, sync contexts.
- Copy/adapt: OpenTUI/Solid patterns and prompt component ideas.
- Rewrite: session screen into smaller oc2 components.
- Exclude: plugin complexity unless needed for side panel slots.
- Tests: state projector, render smoke, keybindings, stream updates.
- Acceptance: TUI can submit prompt, stream response, show tools, cancel run.

### Phase 8: MCP

- Goal: first-class MCP service.
- Inspect: `packages/opencode/src/mcp/*`, `packages/core/src/config/mcp.ts`, MCP HTTP tests.
- Copy/adapt: SDK transport usage, tool discovery, OAuth concepts.
- Rewrite: canonical config, auth lifecycle, tool materialization.
- Exclude: global mutable OAuth maps where avoidable.
- Tests: fake stdio server, HTTP failure, permission denial, list_changed.
- Acceptance: MCP tools appear in registry and execute with permission checks.

### Phase 9: subAgents

- Goal: child session delegated tasks.
- Inspect: `packages/opencode/src/tool/task.ts`, `subagent-permissions.ts`, task tests.
- Copy/adapt: child session and permission derivation concepts.
- Rewrite: service around oc2 scheduler and event bus.
- Exclude: hidden experimental env gates; use config.
- Tests: foreground/background task, cancellation, permission inheritance, timeout.
- Acceptance: main agent can launch subagent and receive result.

### Phase 10: Agent Teams

- Goal: bounded local parallel team orchestration.
- Inspect: `packages/opencode/src/team/*`, `tool/team_*.ts`, team tests, local specs.
- Copy/adapt: database model, mailbox, task claim transaction, plan mode, daemon lifecycle.
- Rewrite: scheduler integration and bounded concurrency.
- Exclude: nested teams and hosted collaboration.
- Tests: team create/spawn/message/task/plan/report/shutdown, dependency gates, daemon lifecycle.
- Acceptance: TUI and CLI team mode can run bounded teammates and synthesize report.

### Phase 11: Custom Feature Migration

- Goal: add selected local custom features.
- Inspect: specs and paths listed in the custom feature table.
- Copy/adapt: OpenGrep, transcript export, skills, repository memory concepts.
- Rewrite: config and integration.
- Exclude: GitHub review memory, supervisor revival, branch-only browser-use default unless requested.
- Tests: feature-specific unit and integration tests.
- Acceptance: custom features are documented and covered.

## 17. Dependency Plan

### Use

- `bun`: runtime and test runner for first implementation.
- `typescript`: strict TypeScript.
- `effect`: structured runtime, concurrency, cancellation, retry, timeout.
- `zod`: config and tool input validation.
- `drizzle-orm` with SQLite: local persistence.
- `@effect/sql-sqlite-bun`: if using Effect SQL integration.
- `ai`: model streaming and provider interoperability.
- Selected `@ai-sdk/*` providers: start with OpenAI, Anthropic, OpenAI-compatible, and Google if needed.
- `@modelcontextprotocol/sdk`: MCP support.
- `@opentui/core`, `@opentui/keymap`, `@opentui/solid`, `solid-js`: TUI.
- `jsonc-parser`: config parsing.
- `cross-spawn`: process execution.
- `minimatch` and `ignore`: permission/path matching.
- `ulid`: ids.

### Avoid

- `yargs`: do not copy legacy CLI unless command parser choice forces it. Prefer Effect CLI or a minimal parser.
- `BullMQ`: distributed queue is out of scope.
- `Piscina`: CPU worker pool is unnecessary.
- `Bottleneck`: rate limiter is not the right core scheduler.
- `p-queue` and `p-limit`: unnecessary if Effect is the runtime; acceptable only as tiny boundary fallback.
- `sst`, Sentry, Electron, Solid Start, Tailwind, Slack, browser app dependencies.
- Generated SDK dependencies unless an API client package is explicitly added later.

### Remove From Consideration

- Account/auth platform dependencies except MCP OAuth helpers.
- Product analytics.
- Cloud deployment scripts.
- Web docs framework.
- Desktop packaging dependencies.

## 18. Testing Plan

### CLI Tests

- Command parsing.
- Config precedence.
- JSON output shape.
- Exit codes.
- `run`, `resume`, `diagnostics`, `mcp`, `tools`, `export`, `version`.

### TUI Tests

- State projector from runtime events.
- Streaming message rendering.
- Tool call rendering.
- Side panel collapse and narrow terminal behavior.
- Permission dialog.
- Team panel.
- MCP panel.
- Cancellation keybinding.

### Agent Runtime Tests

- Fake provider streaming.
- Tool-call loop.
- Run serialization per session.
- Retry-safe provider failure.
- Message persistence.
- Cancellation and timeout.

### subAgent Tests

- Child session creation.
- Context boundary.
- Permission inheritance.
- Foreground result.
- Background result event.
- Parent cancellation propagation.
- Timeout.

### Agent Team Tests

- Team creation.
- Member spawn.
- Dependency waiting.
- Mailbox delivery.
- Shared task claim/update transaction.
- Plan submit/approve/reject.
- Daemon lifecycle.
- Team shutdown.
- Team report generation.
- Failure isolation.

### Scheduler Tests

- Bounded concurrency.
- Priority ordering.
- Cancellation propagation.
- Timeout transition.
- Progress events.
- Failure isolation.

### MCP Tests

- Config validation.
- Disabled server not started.
- Fake stdio server connects.
- Fake HTTP server failure.
- Tool discovery.
- Tool invocation success.
- Permission denial.
- Auth-required status.
- Tool list refresh.

### Tool Execution Tests

- Schema validation.
- Output bounding.
- Filesystem root restrictions.
- Bash cancellation.
- Apply patch success/failure.
- OpenGrep availability fallback.
- Docker sandbox opt-in behavior.

### Persistence Tests

- Migrations.
- Session/message round trip.
- Tool result round trip.
- Team tables.
- MCP status snapshot.
- Corrupt database handling.

### Error Handling Tests

- Recoverable vs fatal errors.
- Provider errors.
- Tool errors.
- MCP errors.
- Permission denials.
- TUI error projection.

## 19. Quality Gates

Implementation is not complete until these pass:

- TypeScript strict typecheck.
- Lint with no ignored architectural violations.
- Unit tests for runtime, config, scheduler, tools, MCP, team, subagent.
- CLI integration tests.
- TUI render smoke tests.
- Manual TUI smoke test in a real terminal.
- Dependency review confirms no excluded product stacks were added.
- Architecture review confirms CLI/TUI adapters contain no business logic.
- No circular dependencies between major modules.
- No hidden global mutable runtime state.
- All long-running operations accept cancellation.
- All tool/model/MCP operations have timeout behavior.
- Permission rules are tested for allow, deny, and ask.
- Logs redact secrets.
- Generated files are regenerated, not manually copied.
- Custom features have explicit include/exclude decisions and tests.

## 20. Custom Feature Decisions

| Feature                      | Where In opencode                                                  |   Belongs In oc2 | Decision                                             | Dependencies             | Risks                                                             | Test Coverage Needed                  |
| ---------------------------- | ------------------------------------------------------------------ | ---------------: | ---------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- | ------------------------------------- |
| Agent team orchestration     | `packages/opencode/src/team/team.ts`, `src/tool/team_*.ts`         |              Yes | Adapt/rewrite into `src/team` with bounded scheduler | Effect, SQLite, Drizzle  | Current implementation is prompt/tool-driven and partly unbounded | Team service/tool/scheduler/TUI tests |
| Team reporting/evaluation    | `packages/opencode/src/team/eval.ts`, `src/tool/team_report.ts`    |              Yes | Adapt                                                | SQLite                   | Reports can become noisy or non-deterministic                     | Deterministic report fixture tests    |
| Daemon teammates             | `specs/daemon-teammates.md`, `team_spawn.ts`                       |              Yes | Adapt                                                | Team runtime             | Spam, lifecycle leaks                                             | Daemon idle/run/error/shutdown tests  |
| Teammate model variants      | `variant-aware-agent-team-orchestration.md`, `team_spawn.ts`       |              Yes | Adapt                                                | Model service            | Invalid variant selection                                         | Validation and persistence tests      |
| Structured handoffs/plans    | `structured-team-handoffs.md`, branch `feature/teams-v2`           |          Partial | Use as design input, not direct copy                 | Team runtime             | Divergent branch design                                           | Plan approval tests                   |
| Repository memory            | `packages/opencode/src/memory/*`, `src/tool/memory.ts`             |       Yes, small | Adapt as explicit local memory tool                  | SQLite or files          | Stale memory influencing edits                                    | Memory retrieval/update tests         |
| Removed GitHub review memory | `remove-github-review-memory.md`                                   |               No | Exclude                                              | None                     | Reintroduces stale product behavior                               | None                                  |
| Multi-root sessions          | `specs/multi-root-sessions.md`, core migration, TUI dialog         |              Yes | Adapt                                                | Persistence, permissions | Root confusion and unsafe writes                                  | Root permission/session tests         |
| TUI team UI                  | `packages/tui/src/component/dialog-team.tsx`, sidebar team plugin  |              Yes | Adapt UI patterns                                    | OpenTUI, Solid           | Coupled to old API state                                          | TUI projector/panel tests             |
| Transcript export            | `packages/tui/src/util/session-export.ts`, `transcript.ts`         |              Yes | Adapt                                                | Persistence              | Sensitive data in export                                          | Export redaction/format tests         |
| Prompt footer elapsed time   | `tui-prompt-footer-elapsed-time.md`, footer                        |              Yes | Reimplement                                          | TUI events               | Timing drift                                                      | TUI state tests                       |
| OpenGrep tool                | `packages/core/src/filesystem/opengrep.ts`, `src/tool/opengrep.ts` |              Yes | Adapt                                                | OpenGrep binary optional | Binary missing, path issues                                       | Availability/fallback tests           |
| Docker shell sandbox         | shell config/specs/tests                                           | Optional guarded | Adapt only behind opt-in                             | Docker                   | Security, mounts, network                                         | Sandbox security tests                |
| Built-in skills              | command templates and core skills                                  |              Yes | Adapt text to oc2                                    | Files                    | Prompt drift                                                      | Skill loading tests                   |
| Browser-use MCP default      | branch `feature/browser-use`                                       |    No first pass | Exclude unless requested                             | MCP/browser tooling      | Scope creep                                                       | None                                  |
| Runtime SDK extraction       | branch `oc2`, `packages/runtime/*`                                 | Yes as direction | Use as architectural input                           | None specific            | Branch may be incomplete                                          | Architecture review                   |
| Session token optimization   | branch `feature/session-optimizer`                                 |   Not first pass | Defer                                                | Model/session            | Premature complexity                                              | Future tests                          |
| Supervisor features          | historical                                                         |               No | Exclude                                              | None                     | Duplicates teams                                                  | None                                  |
| Generated SDK/OpenAPI        | `packages/sdk/*`                                                   |    No first pass | Exclude/regenerate only                              | SDK tooling              | Stale generated code                                              | Regeneration only if added            |

## 21. Quality Bar Rules

- Prefer simple modules with explicit interfaces.
- Keep CLI and TUI thin.
- Keep runtime services testable without terminal rendering.
- Use strict TypeScript and validated external inputs.
- Avoid circular dependencies.
- Avoid hidden global mutable state.
- Avoid unnecessary framework usage.
- Avoid duplicated abstractions.
- Do not import product/web/account/billing code.
- Do not copy coupled code just because it exists.
- Every long-running operation must support cancellation.
- Every external operation must have clear error handling and logs.
- Parallel work must have bounded concurrency.
- Team/subagent failure must be isolated by default.
- TUI rendering must remain responsive during model/tool/team work.
- Documentation must describe config, CLI, TUI shortcuts, MCP, teams, and permissions.
- Clever code is a bug unless it removes real complexity and is tested.

## 22. Open Questions

- Should `oc2` expose a local HTTP API server in the first implementation, or keep TUI and CLI in-process only? Default recommendation: in-process only first, add local API only when TUI process separation is needed.
- Which model providers are required in the first usable version? Default recommendation: OpenAI, Anthropic, OpenAI-compatible, and one local/custom endpoint path.
- Should MCP OAuth be included in the first MCP slice? Default recommendation: support status/config shape first; implement OAuth after stdio and unauthenticated HTTP MCP are stable.
- Should Docker shell sandboxing ship in the first version? Default recommendation: no; include config and design, then add after security review.
- Should repository memory be file-based or SQLite-backed? Default recommendation: SQLite-backed with explicit export/import later.
