# Sidecar Supervisor Service For Agentic Coding Sessions

## Goal

Implement an opt-in supervisor for opencode sessions that can be enabled, disabled, and tuned per session. The supervisor observes existing session, message, tool, permission, and diff events, derives compact per-session progress/risk state, asks an independently configured supervisor model to continuously review the primary session model's trajectory from bounded observable state, exposes advisory signals through typed HTTP/SSE surfaces, and inserts qualifying steering recommendations into the agent conversation.

The first pass is an in-process Effect service, not an out-of-process sidecar. It covers crawl and early walk: durable session-level supervisor settings, a TUI `/supervisor` control surface, observability, deterministic trigger checks, continuous higher-capability model review, model-calculated visible conversation recommendations, after-action reporting, and a small API/UI surface. Out-of-process supervision, blocking, pause, rollback, and policy enforcement are future work.

## Current State

- `packages/opencode/src/session/session.ts` owns session lifecycle, `Session.Info`, `Session.Event`, `messages`, `updateMessage`, `updatePart`, `updatePartDelta`, `setPermission`, `setRevert`, and `fork`.
- `packages/opencode/src/session/message-v2.ts` stores messages and parts, including `ToolPart`, `StepStartPart`, `StepFinishPart`, `message.part.updated`, and `message.part.delta`. Its `TextPart` schema already supports `synthetic` and `metadata`, which are the preferred first-pass shape for visible supervisor insertions.
- `packages/opencode/src/session/processor.ts` captures snapshots before streaming, records step/tool lifecycle parts, writes patch parts, and cleans up interrupted tool calls.
- `packages/opencode/src/session/prompt.ts` and `packages/opencode/src/session/run-state.ts` own the prompt loop, busy/idle state, cancellation, and shell run-state.
- `packages/opencode/src/session/tools.ts`, `packages/opencode/src/tool/shell.ts`, and `packages/opencode/src/permission/index.ts` expose tool execution, shell command state, metadata updates, and permission ask/reply events.
- `packages/opencode/src/snapshot/index.ts` and `packages/opencode/src/session/revert.ts` already support diff, restore, revert, and `session.diff`.
- `packages/opencode/src/bus/index.ts`, `packages/opencode/src/bus/bus-event.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`, and `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts` provide typed BusEvents plus instance/global SSE streams.
- `packages/opencode/src/server/routes/instance/httpapi/api.ts` builds `EventSchema` from `BusEvent.effectPayloads()` at module initialization, so supervisor event definitions must be imported before that schema is constructed or generated OpenAPI/SDK event unions will miss them.
- `packages/opencode/src/sync/index.ts` and `packages/opencode/src/sync/event.sql.ts` provide persisted event history where sync persistence is enabled; first-pass supervisor behavior must not depend on it.
- `packages/core/src/session-event.ts` and `packages/opencode/src/event-v2-bridge.ts` expose richer experimental EventV2 data, including `session.next.synthetic`; first pass should consume stable BusEvent/message-part surfaces and use EventV2 only if the session-message migration requires it.
- `packages/opencode/src/config/config.ts` is the public config schema used by `/config` and `/global/config`; new supervisor config affects OpenAPI and generated SDK types.
- `packages/opencode/src/config/config.ts` already supports `model` and `small_model`; supervisor recommendation generation should support an independent `supervisor.recommendation_model` so users can run a stronger/higher-quantized supervisor over a weaker/lower-quantized primary session model.
- `packages/opencode/src/session/session.sql.ts` persists session fields, and `packages/opencode/src/session/session.ts` maps durable fields through `Session.Info`, `fromRow`, `toRow`, `UpdatedInfo`, and `Session.Event.Updated`.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` defines `SessionPaths`, `SessionApi`, `PATCH /session/:sessionID`, and `POST /session/:sessionID/command`; `/session/:sessionID/command` executes prompt templates and is not the right path for direct supervisor state mutation.
- `packages/opencode/src/cli/cmd/tui/keymap.tsx` exposes palette slash entries through `useCommandSlashes()`, and `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` already has the `SessionRootsCommand` pattern for a session-scoped TUI command with `slashName` and a dialog.
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` reconciles `session.updated` into the TUI session store, so durable supervisor settings should flow through existing session sync instead of TUI-only local state.
- `packages/opencode/src/session/llm.ts` provides the existing LLM service boundary, and `packages/opencode/src/agent/agent.ts` demonstrates structured model output with `generateObject(...)` and Effect schemas.
- `packages/app/src/context/server-sdk.tsx`, `packages/app/src/context/global-sync/event-reducer.ts`, and `packages/app/src/context/global-sync/types.ts` are the app-side event/state integration points.

## Non-Negotiables

- The supervisor must use observable artifacts only: user-visible prompt text, message parts, tool calls, command status, permission events, diffs, and validation outputs.
- The supervisor model must be configurable independently from the primary session model. Do not assume the same provider/model should supervise itself.
- The recommendation model must receive only bounded, redacted `SupervisorRecommendationInput` derived from observable session state. Do not send raw command output, full file contents, private reasoning, or full user prompt text to the recommendation model.
- Insert only emitted recommendation text into the primary agent conversation. Keep supervisor state, reports, raw evidence, command output, and file contents outside the primary agent model context.
- Do not add hidden prompt injection. Inserted recommendations must be visible in the session transcript, clearly labeled as supervisor-generated, and bounded in length.
- Do not add blocking, rollback, permission denial, or session fork in the first pass.
- Do not introduce a second session event pipeline; subscribe to existing BusEvent/message-part events and expose supervisor events through `BusEvent.define(...)`.
- Default to bounded per-session memory. Do not persist raw command output or full file contents beyond existing opencode storage.
- Every risk or recommendation must cite at least one observable file path, command, event type, or diff summary.
- The model may phrase the recommendation, but it must choose a trigger and evidence from the provided input. Reject outputs that invent evidence or request out-of-scope actions.
- Any new endpoint, config field, or BusEvent schema must be reflected in OpenAPI and the JS SDK by running `./packages/sdk/js/script/build.ts` from repo root.
- Run tests from package directories such as `packages/opencode` and `packages/app`; do not run repository-root tests.
- Global `supervisor.*` config is only the default. A durable per-session supervisor override must win for that session and must be changeable without editing `opencode.json`.
- `/supervisor` must be a local TUI control command, not a model-facing command template. Do not add it to `Command.Default` or route it through `POST /session/:sessionID/command` unless a later spec explicitly wants an AI prompt command.
- Switching a session's effective mode to `off` must stop new reviews for that session, cancel or ignore in-flight recommendation results, drop queued insertions, and prevent further conversation insertions.

## Rollout Boundary

- Crawl, in scope: observe sessions, derive state, emit state updates, expose a read API, and produce after-action reports.
- Early walk, in scope: continuous supervisor-model review at meaningful session boundaries; deterministic trigger checks for missing reproduction, repeated failed commands, broad diffs, risky edits, and missing validation; model-calculated steering recommendations from observable state; visible insertion of those recommendations into the agent conversation.
- Run, out of scope: pause, fork, rollback, policy enforcement, permission decisions, and specialist routing.

## Data Model

```ts
type SupervisorMode = "off" | "observe" | "advise"
type SupervisorStatus = "on_track" | "uncertain" | "drifting" | "blocked" | "high_risk"
type SupervisorAction = "nudge" | "ask" | "warn"
type SupervisorTrigger =
  | "missing_reproduction"
  | "repeated_command_failure"
  | "missing_validation"
  | "scope_expansion"
  | "risky_edit"
  | "wrong_localization"
  | "evidence_mismatch"
  | "validation_mismatch"
  | "premature_success"
  | "less_optimal_action"
  | "trajectory_drift"

type SupervisorSessionSettings = {
  mode?: SupervisorMode
  recommendation_model?: string
  recommendation_timeout_ms?: number
  review_cadence?: "step" | "event" | "idle"
  min_review_interval_ms?: number
  max_recommendation_chars?: number
  max_repeated_command_failures?: number
  broad_diff_file_limit?: number
  sensitive_path_globs?: string[]
  validation_command_patterns?: string[]
  insert_recommendations?: boolean
  max_recommendations_per_session?: number
  updatedAt: number
}

type SupervisorEffectiveConfig = {
  mode: SupervisorMode
  recommendation_model?: string
  recommendation_timeout_ms: number
  review_cadence: "step" | "event" | "idle"
  min_review_interval_ms: number
  max_recommendation_chars: number
  max_repeated_command_failures: number
  broad_diff_file_limit: number
  sensitive_path_globs: string[]
  validation_command_patterns: string[]
  insert_recommendations: boolean
  max_recommendations_per_session: number
}

type SupervisorState = {
  sessionID: string
  mode: SupervisorMode // effective mode
  config: {
    modeSource: "global" | "session"
    globalMode: SupervisorMode
    session?: SupervisorSessionSettings
    effective: SupervisorEffectiveConfig
  }
  status: SupervisorStatus
  summary?: string
  filesTouched: string[]
  commandsRun: Array<{
    command: string
    exitCode?: number
    validation: boolean
    repeatedFailureCount: number
  }>
  validationsRun: string[]
  risks: Array<{
    trigger: SupervisorTrigger
    severity: "info" | "warning" | "high"
    evidence: string[]
    message: string
  }>
  recommendation?: {
    source: "model"
    action: SupervisorAction
    trigger: SupervisorTrigger
    message: string
    evidence: string[]
    model?: {
      providerID: string
      modelID: string
    }
    inserted?: {
      messageID?: string
      partID?: string
      insertedAt: number
    }
  }
  updatedAt: number
}
```

`summary` must be a short bounded derived label, not raw full user prompt text.

Supervisor state is derived state. First pass should keep it in an instance-scoped service and best-effort recompute from `GET /session/:id/message` and `GET /session/:id/diff`. Transient-only permission or command delta evidence may be lost after restart unless durable storage is added later.

`SupervisorSessionSettings` is durable session metadata, not derived state. Store it on `SessionTable` as a nullable JSON column named `supervisor`, expose it through `Session.Info.supervisor`, include it in `UpdatedInfo`, and generate a Drizzle migration with `bun run db generate --name session_supervisor_settings` from `packages/opencode`. The server sets `updatedAt` on every successful settings write; clients cannot patch it. If a patch clears every session override key, store `undefined`/`null` instead of `{ updatedAt }`.

## Config

Add `packages/opencode/src/config/supervisor.ts` using the existing self-export pattern.

```ts
export * as ConfigSupervisor from "./supervisor"

type SupervisorConfig = {
  mode?: "off" | "observe" | "advise"
  recommendation_model?: string // provider/model format, same as top-level model fields
  recommendation_timeout_ms?: number
  review_cadence?: "step" | "event" | "idle"
  min_review_interval_ms?: number
  max_recommendation_chars?: number
  max_repeated_command_failures?: number
  broad_diff_file_limit?: number
  sensitive_path_globs?: string[]
  validation_command_patterns?: string[]
  insert_recommendations?: boolean
  max_recommendations_per_session?: number
}
```

Wire it into `packages/opencode/src/config/config.ts` by importing `ConfigSupervisor` and adding `supervisor: Schema.optional(ConfigSupervisor.Info)` to `Config.Info`.

Apply defaults in the supervisor service, not by assuming optional config fields are populated.

Mode behavior:

- `off`: for a session whose effective mode is `off`, ignore observation/review events, emit no active recommendations, and drop queued work. The instance service may still subscribe to session/settings events so it can discover persisted per-session enables and later `/supervisor` changes.
- `observe`: derive state and risks, emit `supervisor.state.updated`, but do not emit or insert recommendations.
- `advise`: derive state, continuously invoke the supervisor model at the configured review cadence or when deterministic triggers fire, emit accepted recommendation events, and insert recommendations into the visible conversation when `insert_recommendations` is true.

Default values:

```ts
{
  mode: "off",
  recommendation_model: undefined,
  recommendation_timeout_ms: 15000,
  review_cadence: "step",
  min_review_interval_ms: 10000,
  max_recommendation_chars: 800,
  max_repeated_command_failures: 3,
  broad_diff_file_limit: 5,
  sensitive_path_globs: [
    "**/auth/**",
    "**/authorization/**",
    "**/permission/**",
    "**/permissions/**",
    "**/migration/**",
    "**/migrations/**",
    "**/*delete*",
    "**/*deletion*",
    "**/*encrypt*",
    "**/*decrypt*",
    "**/billing/**",
    "**/deployment/**",
    "**/deploy/**",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/bun.lock",
    "**/bun.lockb"
  ],
  validation_command_patterns: [
    "bun test",
    "bun typecheck",
    "npm test",
    "pnpm test",
    "yarn test",
    "go test",
    "cargo test",
    "pytest",
    "vitest",
    "jest",
    "tsc",
    "eslint"
  ],
  insert_recommendations: true,
  max_recommendations_per_session: 8
}
```

`recommendation_model` should be set explicitly when the primary session model is intentionally weaker or lower-quantized than the desired supervisor. When it is omitted, resolve the model in this order:

- `model` from `packages/opencode/src/config/config.ts`.
- `small_model` from `packages/opencode/src/config/config.ts`.
- No recommendation model. In this case, continue emitting state/risks but do not create recommendations.

## Per-Session Control

Per-session settings override global config for one session without changing `opencode.json`.

Resolution order:

- Start with the default values in this spec.
- Apply global `Config.Info.supervisor` from `packages/opencode/src/config/config.ts`.
- Apply `Session.Info.supervisor` from `packages/opencode/src/session/session.ts` for the active session.
- Treat `SupervisorState.mode` as the effective mode after all overrides.
- Allow a session override to enable `observe` or `advise` even when global `supervisor.mode` is `off`; this is the main per-session opt-in path.
- Treat absent fields as inherited from global/default config.
- Treat `null` fields in the supervisor settings API as clearing that session override key.

Session storage and sync:

- Add `supervisor?: SupervisorSessionSettings` to `Session.Info` in `packages/opencode/src/session/session.ts`.
- Add a nullable JSON `supervisor` column to `SessionTable` in `packages/opencode/src/session/session.sql.ts` instead of one boolean column, because the user must be able to configure mode and runtime parameters per session.
- Update `fromRow`, `toRow`, `UpdatedInfo`, and the `Session.Interface` setter surface so updates emit existing `session.updated` events.
- Store only explicit session overrides in the JSON column; do not copy default/global values into each session.
- Validate session settings with the same schemas/ranges as global config before writing them.
- Set `updatedAt` on the server after validation succeeds. Do not accept client-provided timestamps.

TUI `/supervisor` behavior:

- Add a session-scoped palette command in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, following `SessionRootsCommand`.
- Register it with `namespace: "palette"`, `name: "session.supervisor"`, `title: "Configure supervisor"`, `category: "Session"`, `slashName: "supervisor"`, and `enabled: sessionID() !== undefined`.
- Opening `/supervisor` should show the effective mode, whether each value comes from global config or the session override, and the active recommendation model if one resolves.
- The first-pass dialog must support setting `off`, `observe`, and `advise`, toggling `insert_recommendations`, editing `recommendation_model`, cadence, timeout, numeric limits, and resetting all session overrides.
- Do not store supervisor settings in `packages/opencode/src/cli/cmd/tui/context/local.tsx`; call the supervisor settings API and rely on `session.updated` or `supervisor.state.updated` to refresh UI state.
- If the user opens `/supervisor` outside a session, show a compact error toast instead of creating a session or changing global config.

## Event Inputs

The supervisor service should normalize these inputs:

- `session.status`, `session.error`, and `session.diff` for lifecycle, failure, and changed-file summaries.
- `message.updated`, `message.part.updated`, `message.part.delta`, and `message.part.removed` for user-visible goal, tool calls, step finishes, patch parts, and assistant progress.
- `permission.asked` and `permission.replied` for risky command/tool decision points.
- Shell `ToolPart` state for command text, exit status, and repeated failures.
- `GET /session/:id/message` and `GET /session/:id/diff` as reconnect/snapshot sources.

Command normalization for deterministic checks:

- Trim leading/trailing whitespace.
- Collapse repeated whitespace outside quoted strings.
- Strip leading `cd <path> &&` only when the command path is within the workspace.
- Treat a command as validation when the normalized command starts with one configured `validation_command_patterns` value.
- Treat validation as successful only when exit code is `0`.

## API And Event Surface

Add session-scoped read and settings endpoints under the existing session HTTP API group.

```text
GET /session/:sessionID/supervisor -> SupervisorState
PATCH /session/:sessionID/supervisor -> SupervisorState
GET /session/:sessionID/supervisor/report -> SupervisorReport
```

Settings update payload:

```ts
type SupervisorSettingsPatch = {
  reset?: boolean
  mode?: SupervisorMode | null
  recommendation_model?: string | null
  recommendation_timeout_ms?: number | null
  review_cadence?: "step" | "event" | "idle" | null
  min_review_interval_ms?: number | null
  max_recommendation_chars?: number | null
  max_repeated_command_failures?: number | null
  broad_diff_file_limit?: number | null
  sensitive_path_globs?: string[] | null
  validation_command_patterns?: string[] | null
  insert_recommendations?: boolean | null
  max_recommendations_per_session?: number | null
}
```

`reset: true` clears all session overrides before applying any non-null fields in the same payload. A `null` field clears only that key. An omitted field leaves that key unchanged.

Update these route/API files when adding endpoints:

- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/v2/session.ts` and `packages/opencode/src/server/routes/instance/httpapi/handlers/v2/session.ts` if the session route is mirrored in v2
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- `packages/opencode/src/server/routes/instance/httpapi/api.ts`

Add typed BusEvents so existing `/event` and `/global/event` streams carry live updates.

```ts
"supervisor.state.updated": { sessionID: string; state: SupervisorState }
"supervisor.recommendation.created": {
  sessionID: string
  recommendation: NonNullable<SupervisorState["recommendation"]>
}
"supervisor.settings.updated": {
  sessionID: string
  settings?: SupervisorSessionSettings
  state: SupervisorState
}
"supervisor.report.completed": { sessionID: string; report: SupervisorReport }
```

Define supervisor BusEvents in a small schema module that is imported by `packages/opencode/src/server/routes/instance/httpapi/api.ts` or by the session API group before `EventSchema` is built from `BusEvent.effectPayloads()`. Do not rely on the supervisor service module being imported later by server wiring; late definitions can be omitted from OpenAPI and generated SDK event unions.

Do not add TUI-specific `/tui/*` routes in the first pass.

Do not implement `/supervisor` by adding a built-in command to `packages/opencode/src/command/index.ts`; that command path sends prompt content to the model through `packages/opencode/src/session/prompt.ts`.

## Continuous Supervision Model

The supervisor model is a separate reviewer over the primary session model. It can be a stronger or higher-quantized model than the model driving the user-facing coding session.

Continuous review means the supervisor evaluates meaningful state changes, not every token delta. In the first pass, meaningful boundaries are:

- A step finishes.
- A tool call completes or errors.
- A patch/diff changes touched files.
- A permission request appears.
- The session becomes idle after edits.
- A deterministic trigger check creates or updates a candidate risk.

The supervisor should stay silent when the primary model is making acceptable progress. It should emit a steering recommendation when the bounded observable state shows a likely mistake, wrong localization, evidence mismatch, missing validation, premature success, or clearly less optimal next action.

## Model Recommendation Calculation

Deterministic checks do not write final recommendation text. They produce candidate risks and high-signal review triggers. The supervisor model also reviews recent bounded state at the configured cadence in `advise` mode, even when no deterministic trigger fired.

Model input:

```ts
type SupervisorRecommendationInput = {
  sessionID: string
  summary?: string
  status: SupervisorStatus
  primaryModel?: {
    providerID: string
    modelID: string
  }
  supervisorModel: {
    providerID: string
    modelID: string
  }
  allowedTriggers: SupervisorTrigger[]
  triggeredRisks: Array<{
    trigger: SupervisorTrigger
    severity: "info" | "warning" | "high"
    evidence: string[]
    message: string
  }>
  filesTouched: string[]
  commandsRun: Array<{
    command: string
    exitCode?: number
    validation: boolean
    repeatedFailureCount: number
  }>
  validationsRun: string[]
  recentEvents: Array<{
    type: string
    target?: string
    outcome?: "success" | "failure" | "unknown"
  }>
  reviewReason: "cadence" | "deterministic_trigger" | "session_idle"
}
```

Model output:

```ts
type SupervisorRecommendationOutput = {
  recommend: boolean
  action: SupervisorAction
  trigger: SupervisorTrigger
  message: string
  evidence: string[]
}
```

Calculation rules:

- Build `SupervisorRecommendationInput` from bounded `SupervisorState`; do not include raw command output, full file contents, full user prompt text, or private reasoning.
- Ask the configured recommendation model for structured output using an Effect schema, following the existing `generateObject(...)` pattern in `packages/opencode/src/agent/agent.ts`.
- The model must decide whether to recommend, pick one trigger from `allowedTriggers`, write one concise steering prompt, and choose evidence only from `triggeredRisks[*].evidence` or bounded state fields.
- Validate output before accepting it: `recommend` must be true, `trigger` must exist in `allowedTriggers`, `evidence` must be a subset of provided evidence/bounded state, and `message` must fit `max_recommendation_chars`.
- When no deterministic risk exists, accept recommendations only for `wrong_localization`, `evidence_mismatch`, `validation_mismatch`, `premature_success`, `less_optimal_action`, or `trajectory_drift`, and require at least two evidence bullets from recent events, touched files, or commands.
- Reject outputs that ask for blocking, permission denial, rollback, fork, broad refactor, or any action outside the first-pass scope.
- On timeout, provider error, invalid schema, or rejected output, emit no recommendation and keep the risk in `SupervisorState` for after-action reporting.

## Conversation Insertion

Recommendations are part of the first-pass behavior in `advise` mode. They must be inserted as visible supervisor-authored conversation content, not as hidden system text.

Default insertion shape:

```text
Supervisor recommendation: missing_validation

Run a relevant validation command before marking this complete.

Evidence:
- Edited files: packages/opencode/src/session/session.ts
- No successful validation command after the first patch
```

Implementation constraints:

- First-pass insertion shape is a visible synthetic user text part/message with `synthetic: true`, `metadata.supervisor`, and `ignored !== true` in `packages/opencode/src/session/message-v2.ts`, so it is visible in the transcript and included in the next primary model input.
- If `TextPart.synthetic` cannot be made both UI-visible and model-visible, add the smallest dedicated supervisor part/message shape and regenerate SDK types.
- Emit normal `message.updated` and `message.part.updated` events for the inserted content, and do not create assistant-role content for steering recommendations.
- Insert recommendations only from `advise` mode and only when `insert_recommendations` is true.
- Re-check the session's effective mode and `insert_recommendations` immediately before insertion; if `/supervisor` changed either value while review was in flight, drop the queued insertion.
- Queue insertion for the next safe prompt/processor boundary if a model step is already streaming. Do not mutate in-flight model input.
- Insert at most one recommendation per trigger per meaningful state change and stop after `max_recommendations_per_session`.
- Keep inserted content concise: trigger, one recommendation, and bounded evidence bullets. Do not include raw command output, full file contents, private reasoning, or full user prompt text.
- Mark the associated `SupervisorState.recommendation.inserted` fields after successful insertion so SSE/API clients can distinguish surfaced recommendations from transcript insertions.
- When a session is switched to `off`, cancel or ignore in-flight recommendation work for that session and clear queued recommendations that have not been inserted.

## Documentation Updates

- Update `packages/web/src/content/docs/config.mdx` with all `supervisor.*` config keys, defaults, mode semantics, and the fact that session overrides win over global config.
- Add `packages/web/src/content/docs/supervisor.mdx` or update the closest existing docs page with the supervisor goal, independent supervisor model configuration, per-session `/supervisor` usage, crawl/walk boundary, API endpoints, SSE event names, conversation insertion behavior, privacy boundaries, and examples of inserted recommendations.
- Update `packages/web/src/content/docs/sdk.mdx` if generated SDK examples expose supervisor endpoints or events.
- Update `packages/web/src/content/docs/agent-teams.mdx` only if supervisor state or recommendations appear in team sessions.
- Update `packages/opencode/src/team/README.md` only if implementation changes the internal team/session mental model.

## Deterministic Trigger Checks

- Missing reproduction: for bug-like prompts or pasted error text, flag first patch/edit before a failing command, failing test, or explicit user-provided failure evidence.
- Repeated command failure: flag the same normalized shell command failing `max_repeated_command_failures` times without an intervening file diff.
- Missing validation: when the session becomes idle after touched files and no successful validation command completed since the first patch.
- Scope expansion: flag more than `broad_diff_file_limit` touched files or more than three top-level package areas for a narrow bug/task prompt.
- Risky edit: flag touched paths matching `sensitive_path_globs` without successful validation after the edit.

Each check must stay silent when evidence is insufficient. Do not infer private reasoning, intent, or style preferences. Checks provide high-signal reasons to invoke the supervisor model; cadence-based review can also invoke the model without a deterministic check. The model calculates recommendation content from bounded observable state.

## Failure Modes

- SSE disconnect: clients must refetch `GET /session/:id/supervisor`.
- Process restart: supervisor state may be partially recomputed; transient-only evidence may be dropped.
- Unsupported tool shape: ignore unknown metadata and keep the latest valid state.
- Noisy rules or model outputs: respect `min_review_interval_ms`, invoke the recommendation model at most once per trigger per meaningful state change, and insert at most one accepted recommendation per trigger.
- Invalid `/supervisor` update: reject the settings API request with a public validation error and leave existing session settings unchanged.
- Mode changed during review: compare the review result against the latest effective config before emitting or inserting; stale results must be ignored.
- Team sessions: compute state per session ID first. Team-level aggregation is future work.

## Implementation Slices

Verification commands below are intended to run from the repository root and avoid the guarded root `bun test` script.

### PR 1: Session Settings Storage And API

- Add `packages/opencode/src/config/supervisor.ts` and wire `supervisor` into `packages/opencode/src/config/config.ts`.
- Add `SupervisorSessionSettings` schema and a pure effective-config resolver that applies defaults, global config, then session overrides.
- Add nullable JSON `supervisor` storage to `packages/opencode/src/session/session.sql.ts`, generate the migration with `bun run db generate --name session_supervisor_settings` from `packages/opencode`, and update `packages/opencode/src/session/session.ts` mapping through `Session.Info`, `fromRow`, `toRow`, `UpdatedInfo`, and a setter.
- Add `GET /session/:sessionID/supervisor` and `PATCH /session/:sessionID/supervisor` in the existing session HTTP API group. The first implementation may return effective config plus empty derived state until the observer service lands.
- Emit `session.updated` and `supervisor.settings.updated` when session settings change.
- Add tests for schema encoding, migration shape, precedence, `null` key clearing, `reset: true`, invalid settings, endpoint auth, and OpenAPI drift.
- Regenerate OpenAPI/JS SDK artifacts.

Verification:

- `bun --cwd packages/opencode test --timeout 30000 test/session/session-schema.test.ts test/session/session.test.ts test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts`
- `./packages/sdk/js/script/build.ts`
- `bun --cwd packages/sdk/js typecheck`
- `bun --cwd packages/opencode typecheck`

Review:

A fresh read-only reviewer must confirm per-session settings are durable session metadata, session overrides win over global config, invalid patches do not partially write, generated SDK types include the new route and session field, and no supervisor settings are sent to the primary model.

### PR 2: TUI `/supervisor` Command

- Add a `SessionSupervisorCommand` in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, following `SessionRootsCommand` and registering `slashName: "supervisor"`.
- Add a compact dialog that shows effective mode, source (`global` or `session`), current session override values, resolved recommendation model, and validation errors.
- Wire dialog actions to the supervisor settings API for `off`, `observe`, `advise`, `insert_recommendations`, runtime parameters, and reset.
- Ensure `/supervisor` is disabled outside a session and never routes through `sdk.client.session.command(...)`.
- Add TUI tests for slash registration, disabled state outside a session, API payloads for mode changes/reset, and error toasts on validation/API failure.

Verification:

- `bun --cwd packages/opencode test --timeout 30000 test/cli/cmd/tui/session-roots-command.test.tsx test/cli/tui/keymap.test.tsx test/cli/tui/dialog-prompt.test.tsx`
- `bun --cwd packages/opencode typecheck`

Review:

A fresh read-only reviewer must verify `/supervisor` is a local palette/slash command, not a built-in AI command, and that all persisted changes go through the session-scoped API.

### PR 3: Core Observer And State Builder

- Add `packages/opencode/src/supervisor/index.ts` as an instance-scoped Effect service.
- Wire the service into `packages/opencode/src/server/routes/instance/httpapi/server.ts`.
- Add eager `init()` through `packages/opencode/src/project/bootstrap.ts` only if observe/advise mode requires background subscriptions before any API call.
- Normalize message parts, shell tool parts, session status, diff, and permission events into a small internal event type.
- Gate all work by the effective per-session mode: `off` skips derivation/reviews, `observe` derives state/risks only, and `advise` can invoke recommendation logic in later PRs.
- Keep the minimal session/settings event subscription needed to discover sessions that become enabled after process start, even when global `supervisor.mode` is `off`.
- Register `supervisor.state.updated` with `BusEvent.define(...)` and update `GET /session/:sessionID/supervisor` to return derived state.
- Add tests for event normalization, state updates, bounded memory, runtime defaults, mode changes, stale-result dropping, and unknown event/tool handling.
- Regenerate OpenAPI/JS SDK artifacts if event or response schemas change.

Verification:

- `bun --cwd packages/opencode test --timeout 30000 test/supervisor/supervisor-state.test.ts test/session/session.test.ts test/server/httpapi-supervisor.test.ts`
- `./packages/sdk/js/script/build.ts`
- `bun --cwd packages/sdk/js typecheck`
- `bun --cwd packages/opencode typecheck`

Review:

A fresh read-only reviewer must verify supervisor state is derived from observable events only, effective mode is respected after session setting changes, no hidden model context is added, and no blocking behavior is introduced.

### PR 4: Deterministic Triggers, Model Recommendation, And After-Action Report

- Implement deterministic trigger checks for missing reproduction, repeated command failure, missing validation, scope expansion, and risky edit.
- Build bounded `SupervisorRecommendationInput` from observable session state.
- Add cadence-based model review at meaningful session boundaries in effective `advise` mode only.
- Add model invocation using the effective `recommendation_model`, falling back to `model` and then `small_model` when no session/global recommendation model is set.
- Validate structured `SupervisorRecommendationOutput` and reject invented evidence or out-of-scope actions.
- Add `SupervisorReport` generation from final state, observed risks, files touched, commands run, validations run, and emitted recommendations.
- Add `GET /session/:sessionID/supervisor/report`.
- Register `supervisor.recommendation.created` and `supervisor.report.completed`.
- Ensure reports cite observable evidence and omit raw command output by default.
- Add focused tests for each trigger, review cadence throttling, model input redaction, output validation, timeout/error fallback, and report generation after session idle/completion.

Verification:

- `bun --cwd packages/opencode test --timeout 30000 test/supervisor/supervisor-rules.test.ts test/supervisor/supervisor-recommendation.test.ts test/server/httpapi-supervisor.test.ts test/session/snapshot-tool-race.test.ts`
- `bun --cwd packages/opencode typecheck`

Review:

A fresh read-only reviewer must try to construct false-positive cases for each trigger and cadence review path, then verify model inputs are bounded/redacted, invalid model outputs are rejected, and no recommendation is emitted when evidence is insufficient or effective mode is not `advise`.

### PR 5: Visible Conversation Insertion

- Insert `SupervisorState.recommendation` into the session conversation in effective `advise` mode when `insert_recommendations` is true.
- Prefer `TextPart` with `synthetic: true` and `metadata.supervisor` unless implementation proves a dedicated supervisor part/message is required.
- Queue recommendations for the next safe prompt/processor boundary when a step is already streaming.
- Re-read the effective session config before insertion and drop queued recommendations if `/supervisor` changed mode or insertion settings.
- Insert using the smallest existing session/message write path that can create the visible synthetic user text part and emit the normal message events; do not bypass session message storage with TUI-only rendering.
- Persist enough message/part linkage to populate `SupervisorState.recommendation.inserted` without persisting raw evidence outside the transcript.
- Add tests that model-calculated recommendations are visible, model-visible on the next step, deduplicated, bounded by `max_recommendations_per_session`, dropped after switching to `off`, and absent in `observe` mode.

Verification:

- `bun --cwd packages/opencode test --timeout 30000 test/supervisor/supervisor-insertion.test.ts test/supervisor/supervisor-rules.test.ts test/session/session.test.ts`
- `bun --cwd packages/opencode typecheck`

Review:

A fresh read-only reviewer must confirm recommendations are visible, labeled as supervisor-generated, never hidden system prompts, are suppressed immediately after `/supervisor off`, and do not include raw command output, full file contents, or full user prompt text.

### PR 6: App Panel And Documentation

- Add app global-sync handling for supervisor events in `packages/app/src/context/global-sync/event-reducer.ts` and `packages/app/src/context/global-sync/types.ts`.
- Extend `packages/app/src/pages/session/session-side-panel.tsx` with compact supervisor status, effective mode/source, files touched, validations run, open risks, and latest recommendation.
- Keep web/app editing controls out of this PR unless reviewers explicitly request parity with the TUI `/supervisor` dialog.
- Complete every required item in the Documentation Updates section.
- Ensure docs explain session override precedence and that inserted recommendations are visible supervisor-authored transcript content, not hidden system prompts.

Verification:

- `bun --cwd packages/app test:unit src/context/global-sync/event-reducer.test.ts src/pages/session/new-session-layout.test.ts`
- `bun --cwd packages/app typecheck`
- `bun --cwd packages/web run build`

Review:

A fresh read-only reviewer must confirm the UI is informational, compact, and does not imply blocking authority. The reviewer should also verify docs describe defaults, session overrides, `/supervisor`, privacy boundaries, and exact config/API names.

## Future Work

- Run the supervisor as a true external sidecar process with IPC and lifecycle isolation.
- Persist supervisor records in a dedicated table if audit history must survive process restarts.
- Consume `packages/core/src/session-event.ts` EventV2 directly after the session event migration stabilizes.
- Add specialist routing or model ensembles after first-pass precision is measured.
- Add governed actions: pause, permission gates, checkpoint/rollback, fork, escalation, and specialist routing.
- Add explicit user controls for accepting or dismissing individual inserted recommendations from the UI.
- Add direct typed `/supervisor set key=value` argument parsing if the dialog-only command is too slow for power users.
- Add web/app editing controls for supervisor session settings if TUI-only settings are not enough.
- Add team-level aggregation across lead and teammate sessions.
- Learn developer preferences only from explicit feedback, not inferred behavior.

## Open Questions

- Should `supervisor.mode` default to `"off"` or `"observe"` after the UI ships? Default recommendation: keep `"off"` for first release, then switch to `"observe"` only after noise is measured.
- Which model should calculate recommendations by default? Default recommendation: use explicit `supervisor.recommendation_model` for higher-capability supervision, fall back to `model`, then `small_model`, and emit no recommendations if none can be resolved.
- Should after-action reports be durable in the first release? Default recommendation: no dedicated DB table until reviewers confirm reports are useful enough to justify migration and retention policy.
- Should first-pass insertion use `TextPart.synthetic` or a dedicated supervisor part type? Default recommendation: use `TextPart.synthetic` with `metadata.supervisor` unless it cannot be made both UI-visible and model-visible.
- Are the default sensitive path globs too broad for lockfiles and deployment files? Default recommendation: ship conservative defaults, allow user override via `supervisor.sensitive_path_globs`, and measure false positives.
- Should `/supervisor` expose direct typed arguments in the first release? Default recommendation: no. Ship a dialog backed by the settings API first, then add typed arguments after the API and validation behavior settle.
