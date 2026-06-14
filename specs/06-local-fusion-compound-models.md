# Local Fusion Compound Models

## Goal

Add a local-client compound model mode to `oc2` that can be selected like a normal model (`--model fusion/<recipe-id>`) and later exposed as a model-callable tool. A fusion run fans a user prompt out to a configured panel of ordinary providers/models, lets each panel member run the existing agent/tool loop, asks a judge model to summarize consensus, contradictions, partial coverage, unique insights and blind spots, then asks a synthesizer model to produce the final parent-session answer.

The implementation treats Fusion as orchestration — not as a new remote provider. Reuse the existing session, `MainAgent`, `ModelService`, scheduler, tool registry, MCP startup, and permission services. Keep Fusion-specific code under a new `src/fusion/` module and keep `SessionRunService` as a thin router into it when `providerId === "fusion"`.

## Current State

- `src/session/run.ts:67-71` — creates `TaskScheduler` with hard-coded `model: 1`.
- `src/session/run.ts:84-87` — builds `ModelService`, `ToolRegistry`, `ToolExecutor`, MCP service, `SubAgentService`, and `TeamService`, then calls `MainAgent.run`.
- `src/model/provider.ts:23-52` — `ModelProvider`, `ModelRequest`, `ModelEvent`, `ModelInfo`, normalized provider error types.
- `src/model/model-service.ts:39-44` — registers providers, emits `model.*` events, schedules `collect` calls with scheduler kind `"model"`.
- `src/model/ai-sdk-provider.ts:15-32` — OpenAI, Anthropic, OpenAI-compatible, local, and fake provider config variants.
- `src/config/schema.ts:62-81` — `Oc2Config` only exposes top-level `model.provider` and `model.model`; provider variants from `ai-sdk-provider.ts` are not wired into the config schema.
- `src/agent/agent.ts:52-188` — persisted model/tool loop in `MainAgent.run`; tool calls inside one iteration are executed sequentially.
- `src/subagent/subagent-service.ts:55-199` and `src/team/team-service.ts:57-144` — child-session patterns for inherited workspace roots, tool executors, scheduler handles, cancellation, status updates.
- `src/subagent/permissions.ts:20-46` — disables recursive subagent/team tools for child runs; `collectParentDenyRules` preserves parent deny rules by appending them last (line 36-41).
- `src/tools/permissions.ts` — last-match-wins semantics (line 79 `wildcardMatch` iterates all rules and the last matching decision wins).
- `src/session/session-service.ts:66-80` — `collectTranscripts` supports recursive child transcript collection.
- `src/persistence/repositories/sessions.ts:14-27` — `SessionRecord` supports `parentSessionId`, `teamId`, and `metadata`.
- `src/events/events.ts:1-210` — typed runtime events for sessions, models, tools, subagents, teams, MCP, scheduler tasks, diagnostics, errors. No Fusion-specific events.
- `src/tui/state.ts:147-619` — projects all `model.*` events into TUI state; `model.delta` events append text without filtering by session scope (lines 168-175).
- `src/scheduler/task.ts:3` — `SchedulerTaskKind = "model" | "tool" | "mcp" | "subagent" | "team-member"`.
- `src/scheduler/scheduler.ts:17-22` — `SchedulerLimits` has static per-kind limits created at scheduler construction time.
- `docs/config.md` documents current config shape and CLI overrides.
- `package.json` verification commands: `bun test`, `bun run typecheck`, `bun run format:check`, `bun run check`.

## Non-Negotiables

- Do not implement server-side routing, hosted model aliases, accounts, billing, analytics, generated SDKs, or OpenRouter API compatibility in the first pass.
- Do not make Fusion a pure `ModelProvider` implementation that owns sessions/tools by itself; that would mix provider adaptation with orchestration and risks scheduler re-entry deadlocks.
- A Fusion panel, judge, or synthesizer must never gain tool permissions that the parent run does not have. Parent deny rules must be re-appended **after** all recipe and profile rules in every tool policy mode (last-match-wins). Parent-disabled tools remain disabled unconditionally.
- Disable recursive orchestration tools inside Fusion child sessions: `fusion`, `subagent`, and all `team_*` tools. Force-disable these last, after all other rules.
- Preserve cancellation and timeout propagation from parent run to panels, judge, synthesizer, tool calls, and MCP calls.
- Bound concurrency. Panel fan-out must use scheduler limits. Recipe `maxParallelPanels` is enforced as `min(runtime.maxConcurrentFusionPanels, recipe.maxParallelPanels)`.
- First-pass synthesis is text-only. Child model deltas must not leak into the parent TUI streaming text. Achieve this by scoping `model.*` events with `sessionId` and having `projectTuiEvent` ignore deltas whose session does not match the active parent.
- Do not add automatic web search. Panels may use existing configured tools subject to normal permission checks.
- Do not store provider secrets in config or session metadata.

## Config And Data Model

### Schema additions in `src/config/schema.ts`

```ts
interface Oc2Config {
  model: { provider: string; model: string }
  providers: Record<string, ProviderConfig>
  fusion: Record<string, FusionRecipeConfig>
  // ...existing tools, mcp, agents, runtime, tui
}

type ProviderConfig =
  | { type: "fake"; enabled?: boolean }
  | { type: "openai"; apiKeyEnv?: string; baseURL?: string }
  | { type: "anthropic"; apiKeyEnv?: string; baseURL?: string }
  | { type: "openai-compatible"; baseURL: string; apiKeyEnv?: string; allowUnauthenticated?: boolean }
  | { type: "local"; baseURL: string; apiKeyEnv?: string; allowUnauthenticated?: boolean }

interface FusionModelRef {
  provider: string       // key into config.providers
  model: string
  temperature?: number
  maxTokens?: number
}

interface FusionPanelConfig extends FusionModelRef {
  id?: string            // defaults to "panel-<index>"
  role?: string          // brief role description injected into panel system prompt
  promptPrefix?: string
  timeoutMs?: number
  maxIterations?: number
}

interface FusionToolPolicyConfig {
  mode: "inherit" | "read-only" | "none"
  allow?: string[]       // tool names to explicitly allow (applied BEFORE deny rules)
  deny?: string[]        // tool names to explicitly deny (applied AFTER allow rules)
}

interface FusionRecipeConfig {
  description?: string
  panels: FusionPanelConfig[]       // at least 1
  judge: FusionModelRef
  synthesizer: FusionModelRef
  minSuccessfulPanels?: number      // default: 1
  maxParallelPanels?: number        // default: panels.length
  timeoutMs?: number
  toolPolicy?: FusionToolPolicyConfig  // default: { mode: "inherit" }
}
```

### Runtime additions in `src/config/schema.ts`

```ts
runtime: {
  maxConcurrentModels: number           // default: 4
  maxConcurrentFusionPanels: number     // default: 4
  // ...existing fields preserved
}
```

### Provider factory `src/model/provider-factory.ts`

- `createProvidersFromConfig(config: Oc2Config, env: Record<string, string | undefined>): ModelProvider[]`
- For each entry in `config.providers`, creates the appropriate provider instance:
  - `{ type: "fake" }` → `FakeModelProvider`
  - `{ type: "openai" }` → `AiSdkModelProvider` with fixed id `"openai"`
  - `{ type: "anthropic" }` → `AiSdkModelProvider` with fixed id `"anthropic"`
  - `{ type: "openai-compatible" }` → `AiSdkModelProvider` with `config.id` set to the record key
  - `{ type: "local" }` → `AiSdkModelProvider` with `config.id` set to the record key
- `openai` and `anthropic` type entries are only allowed under their respective record keys; any other record key using those types is a config diagnostic warning.
- Disabled providers (enabled: false) in the `fake` variant are skipped with a diagnostic.
- Provider secrets (API keys) are never stored in config; read from `env` at creation time.

### Defaults

- `providers.fake = { type: "fake" }` so `model: { provider: "fake", model: "test" }` remains valid without a config file.
- `fusion = {}` by default.
- `runtime.maxConcurrentModels = 4`, `runtime.maxConcurrentFusionPanels = 4`.
- `knownConfigKeys` must include `providers`, each provider key, provider sub-keys, `fusion`, each recipe key, recipe sub-keys (panels, judge, synthesizer, toolPolicy, etc.), and the new `runtime` keys.

### Example `docs/config.md` addition

```jsonc
{
  "model": { "provider": "fusion", "model": "research" },
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "openai": { "type": "openai", "apiKeyEnv": "OPENAI_API_KEY" },
    "local": { "type": "local", "baseURL": "http://localhost:11434/v1", "allowUnauthenticated": true }
  },
  "fusion": {
    "research": {
      "panels": [
        { "provider": "openrouter", "model": "google/gemini-3-flash", "role": "fast web-oriented researcher" },
        { "provider": "openrouter", "model": "moonshotai/kimi-k2.6", "role": "long-context critic" },
        { "provider": "local", "model": "deepseek-v4-pro", "role": "code and shell-focused analyst" }
      ],
      "judge": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" },
      "synthesizer": { "provider": "openai", "model": "gpt-5.5" },
      "minSuccessfulPanels": 2,
      "maxParallelPanels": 3,
      "toolPolicy": {
        "mode": "inherit",
        "deny": ["write", "edit", "apply_patch", "bash"]
      }
    }
  },
  "runtime": { "maxConcurrentModels": 4, "maxConcurrentFusionPanels": 4 }
}
```

### Persisted child session metadata

`SessionRecord.metadata` for Fusion children:

```ts
interface FusionSessionMetadata {
  fusion: {
    runId: string
    recipeId: string
    stage: "panel" | "judge" | "synthesizer"
    panelId?: string       // set only for panel children
    provider: string
    model: string
  }
}
```

### Judge output shape

```ts
interface FusionJudgeReport {
  consensus: string[]
  contradictions: { topic: string; positions: { panelId: string; claim: string }[] }[]
  partialCoverage: { panelId: string; covered: string[]; missing: string[] }[]
  uniqueInsights: { panelId: string; insight: string }[]
  blindSpots: string[]
  failedPanels: { panelId: string; error: string }[]
  rawText: string            // always preserved verbatim
}
```

If the judge model call succeeds but the response text cannot be parsed into the structured shape, the `FusionJudgeReport` is populated with `rawText` and empty/default arrays for all structured fields. This is non-fatal; synthesis proceeds. Judge *failure* means the model call itself failed (network error, timeout, cancellation, etc.) — only that is fatal.

### Panel result shape

```ts
interface FusionPanelResult {
  panelId: string
  provider: string
  model: string
  childSessionId: string
  status: "completed" | "failed"
  text: string
  toolCalls: readonly AgentRunToolCall[]
  errors: readonly RuntimeErrorShape[]
  usage?: TokenUsage
}
```

## Runtime Design

### `FusionRunServiceOptions` in `src/fusion/fusion-service.ts`

```ts
interface FusionRunServiceOptions {
  config: Oc2Config
  sessions: SessionService
  models: ModelService
  registry: ToolRegistry
  scheduler: TaskScheduler
  events?: RuntimeEventBus<unknown>
  memory?: RepositoryMemoryRepository
  resolveQuestion?: (input: unknown, signal: AbortSignal) => Promise<unknown>
}
```

### `FusionRunService` public API

```ts
interface FusionRunInput {
  parentSession: SessionRecord
  recipeId: string
  prompt: string
  signal: AbortSignal
}

interface FusionRunResult extends MainAgentRunResult {
  fusionRunId: string
  panelResults: FusionPanelResult[]
  judgeReport: FusionJudgeReport
}
```

### Construction and routing

- `SessionRunService` constructs `FusionRunService` inside `run()` before MCP startup, passing shared services as options (mirrors how `SubAgentService` and `TeamService` are constructed at `src/session/run.ts:153-170`).
- After `agentConfig` is built and MCP is started, `SessionRunService.run` routes to `FusionRunService.run` when `session.providerId === "fusion"`.
- For all other provider IDs, `SessionRunService.run` calls `MainAgent.run` as it does today.

### Panel fan-out

- `FusionRunService` creates one child session per recipe panel with `parentSessionId`, inherited workspace roots, panel provider/model, and `metadata.fusion` with `stage: "panel"`.
- Each panel uses `MainAgent.run` with a generated `AgentProfile` (sourced from `config.agents[panelProfileId]` or a built-in default with `maxIterations` from `FusionPanelConfig.maxIterations` or default `20`).
- Panel runs are scheduled with scheduler kind `"fusion-panel"`:
  - Add `"fusion-panel"` to `SchedulerTaskKind` in `src/scheduler/task.ts:3`.
  - Add `fusionPanel: number` to `SchedulerLimits` in `src/scheduler/scheduler.ts:17-22`.
  - `SessionRunService` passes `config.runtime.maxConcurrentFusionPanels` as the global limit.
- Fusion enforces `recipe.maxParallelPanels` by tracking an internal active panel count and only enqueuing up to `min(runtime.maxConcurrentFusionPanels, recipe.maxParallelPanels)` at once. Remaining panels remain pending until earlier panels complete.
- Panel model calls within `MainAgent.run` still use scheduler kind `"model"` through `ModelService` (governed by `runtime.maxConcurrentModels`).

### Judge and synthesizer steps

- Run only after all scheduled panels complete (or are cancelled/failed).
- Each step creates a child session with `metadata.fusion.stage = "judge"` or `"synthesizer"`, calls `ModelService.collect` directly with `tools: []`, and persists the resulting assistant message in the child session.
- The judge receives: the original user prompt + each successful panel's final text (prefixed with panel ID and role).
- The synthesizer receives: the original user prompt + the full `FusionJudgeReport` in structured text form.
- Judge and synthesizer model calls are scheduled with scheduler kind `"model"` (counts against `runtime.maxConcurrentModels`).

### Parent session message layout

Parent messages for a Fusion run, in order:

1. One `user` message: the original prompt.
2. One `assistant` message: the synthesizer output text, with status `"completed"` (success) or `"failed"` (with attached `RuntimeError`).

Panel, judge, and synthesizer messages are persisted only in their respective child sessions, accessible via `oc2 export <session-id> --recursive`.

### Child config derivation in `src/fusion/permissions.ts`

Rule precedence, in application order (last wins):

1. Start from `agentConfig` after CLI tool/MCP selections are applied.
2. Apply recipe `toolPolicy.mode` base rule set:
   - `none`: set `enabled: false` for every registered tool (including MCP tools) and every known tool name.
   - `read-only`: enable only read-oriented built-ins (`read`, `glob`, `grep`, `opengrep`, `webfetch`) and disable everything else; disable all MCP tools in this mode unless explicitly allowlisted in the recipe `allow` list.
   - `inherit`: keep parent `enabled`/`disabled` state for each tool.
3. Apply recipe `allow` list (set `enabled: true`, append `allow` permission rules).
4. Apply recipe `deny` list (append `deny` permission rules — these override allows due to last-match-wins).
5. Re-append all parent deny rules from the parent config (`collectParentDenyRules` pattern from `src/subagent/permissions.ts:36-41`) — these are the final deny word and cannot be overridden.
6. Force-disable recursive tools (`fusion`, `subagent`, and all `team_*` tools) last, regardless of all prior rules.
7. Parent-disabled tools (tools with `enabled: false` in the parent config) stay disabled unconditionally, regardless of recipe `allow` lists.

Share the recursive tool name constant list between `src/subagent/permissions.ts` and `src/fusion/permissions.ts` so they stay synchronized.

### Failure behavior

| Condition | Parent status | Parent message | RuntimeError |
|---|---|---|---|
| Unknown recipe | `failed` | Failure text with recipe ID | `invalid_task`, recoverable: true |
| `< minSuccessfulPanels` complete | `failed` | Listing each failed panel and its error | `task_failed`, recoverable: true |
| Judge model call fails | `failed` | Judge error text | `task_failed`, cause from provider |
| Judge response valid (even with empty structured fields) | proceed | — | — |
| Judge response unparseable | proceed; `rawText` preserved, empty structured arrays | — | — |
| Synthesizer model call fails | `failed` | Synthesizer error text | `task_failed`, cause from provider |
| Parent cancellation | `cancelled` | "Run was cancelled" | `cancelled`, recoverable: true |
| Overall timeout | `failed` | "Fusion run timed out after Nms" | `timed_out`, recoverable: true |

### Cancellation and timeout propagation

- Parent `AbortSignal` is linked through scheduler `parent` links to every panel, judge, and synthesizer handle.
- Recipe `timeoutMs` sets an overall `setTimeout` that aborts a parent-level `AbortController` wired to all child work.
- Individual panel `timeoutMs` is passed through `AgentProfile.timeoutMs` and the scheduler's per-task timeout mechanism.

### TUI event scoping

- `model.*` events emitted by `ModelService` (via `src/model/model-service.ts:62-96`) during Fusion child runs include the child `sessionId` as `payload.sessionId`.
- Before PR 3 lands, update `src/tui/state.ts` `projectTuiEvent` to compare `payload.sessionId` against `state.sessionId` (the active parent/root session) and skip `model.delta` events whose session ID does not match. This prevents panel/judge/synthesizer streaming deltas from polluting the parent TUI.
- If new `fusion.*` events are introduced in PR 5, they are projected in `agentTasks` only; no new TUI panel is added in the first pass.

### Resume semantics

- `SessionRunService.run` currently parses `input.model` via `parseModel()` at `src/session/run.ts:96` but uses it only for *new* sessions. For resumed sessions (line 98-99), the persisted session's provider/model is used. Therefore `resume --model fusion/research` on a non-Fusion session will not route to Fusion.
- PR 1 changes: if `input.model` is provided and the resolved session's persisted `providerId` differs, reject with `RuntimeError` code `invalid_task` and message `"Cannot override model provider for a resumed session"`. This ensures Fusion runs must start from a new session. Leave model-only changes (same provider, different model) as future work.
- `resume --run` on an existing Fusion parent session with no `--model` flag continues to route through `SessionRunService` normally; it will re-run Fusion because `session.providerId === "fusion"`.

### Tool registry lifecycle

- `SessionRunService` registers `SubAgentTool`, `TeamTools`, and `FusionTool` on the shared mutable `ToolRegistry` (lines 171-174 of `src/session/run.ts`).
- Registration must be idempotent: call `registry.unregister(toolName)` before `registry.register(tool)` to avoid duplicates across re-entrant runs (though `SessionRunService` enforces one active run per session).
- Child permission derivation in `src/fusion/permissions.ts` must enumerate tool names from the registry (`registry.list()`) when applying `none` mode, so dynamically registered tools (MCP, team, subagent, fusion) are also disabled.

## CLI, TUI, And Tool Surface

### CLI behavior

- `oc2 run "prompt" --model fusion/research --json` works; `formatRunJson` is extended with `fusionRunId`, panel status counts, and judge report `consensus` array (keep it backward compatible — omit `fusion` key when not a fusion run).
- `oc2 resume <session-id> --run "prompt" --model fusion/research` fails with "Cannot override model provider for a resumed session" unless the session was already a Fusion session.
- `oc2 config get fusion.research` works through existing dotted lookup.
- No new top-level CLI command.

### TUI behavior

- First pass shows Fusion child work through existing `scheduler.task.updated` events (kind `fusion-panel` appears in `agentTasks`).
- No new TUI panel; `model.delta` events from child sessions are filtered out.
- `projectTuiEvent` in `src/tui/state.ts:167-175` adds a guard: `if (payload.sessionId && state.sessionId && payload.sessionId !== state.sessionId) return state;`.

### Fusion tool (PR 6)

Defined in `src/fusion/fusion-tool.ts`:

```ts
// Tool name: "fusion"
// Permission action: "fusion.run", resource: recipe id (string)
// Input schema:
{
  recipe: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}
// Output shape:
{
  recipe: string
  finalText: string
  panelCount: number
  successfulPanels: number
  consensus: string[]
}
```

- Registered in `SessionRunService.run` after `FusionRunService` is constructed.
- Tool-invoked Fusion creates child sessions under the calling session and force-disables `fusion` in panel children.
- Output is bounded via existing `boundToolOutput` in `src/tools/output.ts`.

## Implementation Slices

### PR 1: Provider Config And Model Concurrency

- Add `providers` schema, zod validation, defaults (`providers.fake = { type: "fake" }`), repair logic, and `knownConfigKeys` updates in `src/config/schema.ts`.
- Add `runtime.maxConcurrentModels` and `runtime.maxConcurrentFusionPanels` to schema, defaults (both `4`), repair logic, and `knownConfigKeys`.
- Add `src/model/provider-factory.ts`:
  - `createProvidersFromConfig(config, env): ModelProvider[]`
  - Record key becomes `id` for `openai-compatible`/`local`; `openai`/`anthropic` use fixed IDs and must match the record key (diagnostic warning otherwise).
  - Tests: `openrouter` (openai-compatible), `local`, disabled `fake`, missing API key (gate failure), duplicate provider IDs (second registration wins).
- Wire provider factory into `src/cli/index.ts` (line 276-281 `runPrompt`, line 194-203 `tui`), and `src/session/run.ts` (line 85-87 `createModelService` call).
- Replace hard-coded `model: 1` in `src/session/run.ts:72` with `config.runtime.maxConcurrentModels`.
- Add `fusionPanel: config.runtime.maxConcurrentFusionPanels` to scheduler limits in `src/session/run.ts:71-77`.
- Add resume model-override rejection: if `input.model` changes provider relative to the persisted session, throw `RuntimeError` code `invalid_task`.
- Update `docs/config.md` with provider config examples including each variant type.
- Update `README.md` with provider configuration section.

Verification:

```
bun test test/config/load.test.ts test/model/model-service.test.ts test/cli/run.test.ts
bun run typecheck
bun run format:check
```

Review:

Read-only reviewer inspects only this diff for config compatibility, unknown-key diagnostics, provider factory id assignment, API key handling (never persisted), fake-model defaults without config file, and resume rejection behavior.

---

### PR 2: Fusion Config, Types, Prompts, And Permissions

- Add `fusion` schema (`FusionRecipeConfig`, `FusionPanelConfig`, `FusionModelRef`, `FusionToolPolicyConfig`), defaults (`fusion = {}`), repair logic, and `knownConfigKeys` in `src/config/schema.ts`.
- Add `src/fusion/types.ts`: `FusionPanelResult`, `FusionJudgeReport`, `FusionSessionMetadata`, `FusionModelRef`, etc.
- Add `src/fusion/prompts.ts`:
  - `buildPanelSystemPrompt(recipe, panel, userPrompt)` — deterministic assembly, no secrets.
  - `buildJudgePrompt(userPrompt, panelResults)` — instructs judge to output JSON matching `FusionJudgeReport` shape.
  - `buildSynthesizerPrompt(userPrompt, judgeReport)` — asks for grounded final answer.
- Add `src/fusion/permissions.ts`:
  - `deriveFusionChildConfig(parentConfig, recipe)` — applies the 7-rule precedence order described in Child Config Derivation above.
  - `RECURSIVE_TOOL_NAMES` constant exported and consumed from both `src/subagent/permissions.ts` and `src/fusion/permissions.ts`.
  - `defaultDisabledFusionChildTools()`.
- Add tests:
  - Schema validation: empty fusion config valid, missing required fields invalid, invalid mode rejected.
  - Permission derivation: parent deny overrides recipe allow, read-only disables bash/write/edit/mcp, none disables all, recursive tools always disabled, parent-disabled tool stays disabled regardless of allow.
  - Prompt builders produce deterministic output, contain no secrets, include panel names and roles.

Verification:

```
bun test test/config/load.test.ts test/subagent/permissions.test.ts test/fusion/permissions.test.ts test/fusion/prompts.test.ts
bun run typecheck
bun run format:check
```

Review:

Focus on permission non-escalation (parent deny is ultimate), recursive tool blocking order, shared constant deduplication, prompt determinism, and config naming.

---

### PR 3: FusionRunService Panel Fan-Out

- Add `"fusion-panel"` to `SchedulerTaskKind` in `src/scheduler/task.ts:3`.
- Add `fusionPanel: number` to `SchedulerLimits` in `src/scheduler/scheduler.ts:17-22` and wire into `createTaskScheduler`.
- Add `src/fusion/fusion-service.ts`:
  - `FusionRunService` class with `FusionRunServiceOptions` constructor.
  - `run(input: FusionRunInput): Promise<FusionRunResult>`.
  - Panel fan-out: creates child sessions, runs `MainAgent` per panel, enforces `min(runtime.maxConcurrentFusionPanels, recipe.maxParallelPanels)` via internal active-panel count + scheduler kind `"fusion-panel"`.
  - Aggregation into `FusionPanelResult[]`.
  - Panel-only (no judge/synthesis yet) — return panel results on success; fail parent if `< minSuccessfulPanels`.
  - Cancellation and timeout propagation per spec above.
- Update `src/session/run.ts`:
  - Construct `FusionRunService` after `TeamService` (line 162-170).
  - Route `providerId === "fusion"` to `FusionRunService.run` instead of `MainAgent.run`.
  - Append parent user message and final assistant message.
- Update `src/tui/state.ts` `projectTuiEvent` to filter `model.delta` events by `sessionId` (only accept deltas matching `state.sessionId`).
- Tests:
  - 3-panel fusion with `maxParallelPanels: 2` and delayed fake providers proves only 2 panels overlap.
  - `maxConcurrentModels: 1` serializes panel model calls within overlapping panels.
  - Parent cancellation aborts all queued/running panels.
  - `< minSuccessfulPanels` produces parent failure with panel error details.
  - Non-fusion sessions unchanged (regression test on existing run.test.ts).

Verification:

```
bun test test/fusion/fusion-service.test.ts test/session/run.test.ts test/scheduler/scheduler.test.ts test/tui/state.test.ts
bun run typecheck
bun run format:check
```

Review:

Scheduler deadlocks, leaked child sessions on early failure, cancellation propagation, non-Fusion regression, TUI delta filtering correctness.

---

### PR 4: Judge And Synthesizer Finalization

- Extend `FusionRunService`:
  - After all panels complete, run judge and synthesizer steps:
    - Create child sessions with `metadata.fusion.stage = "judge"` / `"synthesizer"`.
    - Call `ModelService.collect` directly with `tools: []`.
    - Append user/assistant messages to the child session.
  - Implement failure matrix from Failure Behavior table above.
- Add `src/fusion/judge.ts`:
  - `parseJudgeResponse(rawText: string): FusionJudgeReport`
  - Uses zod schema for `FusionJudgeReport` with safe parse.
  - On parse failure, returns `{ rawText, consensus: [], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [], failedPanels: [] }` — non-fatal, `rawText` is always preserved.
  - Judge failure = model call failure; that is fatal (parent fails, no synthesis).
- Persist judge/synthesizer child sessions with `metadata.fusion.stage` set.
- Parent session gets exactly one final `assistant` message with synthesizer text, status per failure matrix, `RuntimeError` attached on failure.
- Update transcript export tests:
  - `oc2 export <fusion-session-id> --recursive --format json` includes parent + all panel children + judge + synthesizer children in creation order.
  - `oc2 export <fusion-session-id> --recursive --format markdown` same.

Verification:

```
bun test test/fusion/fusion-service.test.ts test/fusion/judge.test.ts test/session/transcript.test.ts test/cli/run.test.ts
bun run typecheck
bun run format:check
```

Review:

Parent transcript shape (exactly 2 messages: user + assistant), child metadata correctness, partial-failure behavior (judge parse failure still produces synthesis), judge model call failure stops before synthesis, recursive export includes all children, CLI JSON compatibility.

---

### PR 5: Events, TUI Projection, And CLI Output Polish

- Add typed Fusion events to `src/events/events.ts`:
  - `"fusion.started"`: `{ fusionRunId, recipeId, panelCount }`
  - `"fusion.panel.updated"`: `{ fusionRunId, panelId, status, error? }`
  - `"fusion.judge.started"`: `{ fusionRunId, judgeProvider, judgeModel }`
  - `"fusion.judge.completed"`: `{ fusionRunId, consensusCount, contradictionCount }`
  - `"fusion.completed"`: `{ fusionRunId, status, successfulPanels, totalPanels }`
- Emit these events from `FusionRunService`.
- Project `fusion.*` events in `src/tui/state.ts` `agentTasks`:
  - `fusion.started` → task with kind `"fusion"`, status `"started"`, panelCount in progress.
  - `fusion.panel.updated` → task with kind `"fusion-panel"`, status `panel.status`.
  - `fusion.judge.completed` → update task progress.
  - `fusion.completed` → task completed/failed.
- Extend `src/cli/output.ts` `formatRunJson`:
  - Add optional `fusion` key with `{ fusionRunId, recipeId, panelResults: { total, successful }, consensus: string[] }`.
  - Omit `fusion` key for non-Fusion runs (backward compatible).
- Add docs for `oc2 run --model fusion/<recipe>` and recursive export debugging.

Verification:

```
bun test test/tui/state.test.ts test/cli/output.test.ts test/cli/run.test.ts
bun run typecheck
bun run format:check
```

Review:

Event payload stability (no secrets in event data), TUI state size (no new panel, only agentTasks entries), CLI JSON remains backward compatible for non-fusion runs.

---

### PR 6: Model-Callable Fusion Tool

- Add `src/fusion/fusion-tool.ts`:
  - Tool name: `"fusion"`.
  - Permission action: `"fusion.run"`, resource: recipe id.
  - Input: `{ recipe, prompt, context?, timeoutMs? }`.
  - Output: `{ recipe, finalText, panelCount, successfulPanels, consensus }`.
  - Implementation delegates to `FusionRunService.run` with a derived parent session (the calling tool's session).
- Register in `src/session/run.ts` after `FusionRunService` construction (idempotent: unregister first, then register).
- Force-disable `fusion` tool in Fusion panel children (already in recursive tool list from PR 2).
- Tests:
  - Permission `ask` with interactive resolver denied → tool error `permission_failed`.
  - Permission `deny` → tool error `permission_failed`.
  - Disabled tool → tool error `tool_disabled`.
  - Successful tool run creates child sessions under calling session, returns correct output shape.
  - Recursive call (fusion tool used inside a panel) is impossible because panels have `fusion` disabled.
  - Large judge report does not exceed output bounds.

Verification:

```
bun test test/fusion/fusion-tool.test.ts test/tools/execution.test.ts test/session/run.test.ts
bun run typecheck
bun run check
```

Review:

Permission checks, recursive prevention, parent/child session ownership, output bounding, idempotent registration.

---

## Future Work

- Streaming parent-visible synthesis deltas after all panel work completes.
- Model-ranking, automatic panel selection, per-task routing heuristics.
- Cost estimation and token budgeting per provider/model.
- Caching panel responses or judge reports across equivalent prompts.
- Rich TUI Fusion panel with per-panel status, model, usage, and error summaries.
- Tool-call parallelism inside a single `MainAgent` iteration (`src/agent/agent.ts:105`).
- Server/API compatibility with a remote `openrouter/fusion`-style slug.
- Model-only override on resume (same provider, different model).

## Open Questions

- **`runtime.maxConcurrentModels` default** — Default to `4`. Users can set `1` to serialize provider requests. The old implicit `1` was because no feature needed concurrent model calls; subagents, teams, and Fusion now do.
- **`bash` in panel runs** — Default to disabled via `toolPolicy.mode: "inherit"` with recipe-level `deny: ["bash"]`. The user must explicitly allow it.
- **Public provider id** — Use `"fusion"` for the user-facing model slug. Module and type names follow the same convention (`FusionRunService`, `FusionRecipeConfig`).
- **`openai`/`anthropic` under different record keys** — Reject with a diagnostic warning. The record key must match the type for these two provider variants.
