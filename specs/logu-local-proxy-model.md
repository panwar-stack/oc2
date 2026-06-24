# Logu Local Proxy Model

## Goal

Implement `logu` as an always-selectable local model in opencode. Users pick `logu` from the normal model picker and keep using the same chat/session flow, while opencode routes each provider turn through the existing `local_fusion` compound execution path.

The first pass must expose a Fugu-like single-model abstraction without training a learned orchestrator or starting a separate proxy process. `logu` uses `local_fusion.logu`, fans the current conversation into branch sessions, runs the configured judge and synthesizer, and returns the synthesizer output as the root assistant response.

## Current State

- `packages/opencode/src/tool/local_fusion.ts` implements `LocalFusionTool` as a tool/command, not as a model provider. It loads named configs from `config.get().local_fusion`, requires `ctx.extra.promptOps`, rejects active agent-team sessions via `Team.getContext(ctx.sessionID)`, and calls `SessionCompound.run(...)`.
- `packages/core/src/config/local-fusion.ts` defines `ConfigLocalFusion.Info` with `branches`, `judge`, `synthesizer`, and optional `limits`. Branch models must use `provider/model` strings. `ToolPolicy` is currently only `readonly` or `none`.
- `packages/opencode/src/session/compound/runner.ts` creates child sessions titled `Compound branch #N`, runs branches concurrently, then calls `SessionCompoundJudge.run` and `SessionCompoundSynthesizer.run`. Branches currently get `readonlyTools` or `noTools`; they cannot use `task` subagents today.
- `packages/opencode/src/session/compound/judge.ts` and `packages/opencode/src/session/compound/synthesizer.ts` create child sessions titled `Compound judge` and `Compound synthesizer` with tools disabled.
- `packages/opencode/src/tool/task.ts` allows subagents and already disables `team_create`, `team_spawn`, and `local_fusion` inside spawned subagent sessions.
- `packages/opencode/src/agent/subagent-permissions.ts` hard-denies team tools for task-spawned subagent sessions.
- `packages/opencode/src/provider/provider.ts` builds provider state from `ModelsDev.Service.get()`, config, auth/env, and `custom(dep)`. `custom(dep)` only helps providers that exist in the provider database, so `logu` needs a synthetic built-in database entry.
- `packages/opencode/src/session/llm.ts` is the model-turn execution seam. The default path calls `provider.getLanguage(...)`, prepares request tools/messages, invokes `streamText(...)`, and adapts AI SDK stream parts into `LLMEvent`s.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts` returns provider `all`, `default`, and `connected` for app/web provider state.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts` returns `config.providers` from `Provider.Service.list()`. `packages/tui/src/context/sync.tsx` hydrates `sync.data.provider` from this config response, so TUI selectability requires `logu` in `Provider.Service.list()`.
- `packages/tui/src/component/dialog-model.tsx` reads `sync.data.provider` for model selection. `packages/tui/src/context/local.tsx` validates selected models by provider/model presence in synced provider data.
- `packages/app/src/hooks/use-providers.ts`, `packages/app/src/context/models.tsx`, and `packages/app/src/context/local.tsx` filter selectable models through `providers.connected()`.
- `packages/tui/src/context/sync.tsx` already syncs `permission.asked`, `question.asked`, `session.status`, child session messages, and team member updates.
- `packages/tui/src/routes/session/question.tsx` renders question headers. `packages/tui/src/routes/session/permission.tsx` renders permission prompts.
- `packages/tui/src/feature-plugins/sidebar/team.tsx` and `packages/tui/src/component/dialog-team.tsx` are the closest existing side-panel patterns for child sessions, status, permissions, and questions.
- `packages/web/src/content/docs/local-fusion.mdx` documents local fusion and must be updated if `logu` reuses its config or adds a branch tool policy.

## Non-Negotiables

- `logu` must appear in normal TUI and app model pickers without provider credentials, auth setup, or connect flow.
- `logu` must run in-process. Do not add a separate HTTP proxy server in the first pass.
- `logu` must use `local_fusion`/`SessionCompound` as the orchestration primitive. Do not build an unrelated multi-agent runner.
- Underlying branch, judge, and synthesizer model references must not be `logu/logu`; fail config validation before execution to prevent recursive proxy calls.
- Branches may use `task` subagents when enabled for `logu`, but branches and their subagents must not use `team_create`, `team_spawn`, or `local_fusion`.
- Permission and question prompts from underlying sessions must bubble to the user with labels identifying `Logu branch #N`, `Logu judge`, or `Logu synthesizer` and the underlying model when known.
- Existing `/local_fusion` command behavior must remain compatible. Its default branch tool policy stays `readonly`.
- `logu` must not become the automatic fallback/default model unless `local_fusion.logu` exists and the user explicitly selected `logu` before.
- Leave learned routing, dynamic workflow generation, model training, benchmark harnesses, and external proxy APIs out of the first pass.

## Model And Provider Surface

Use normal provider/model identity so existing pickers, storage, and prompt footer code keep working.

```ts
type LoguModelRef = {
  providerID: "logu"
  modelID: "logu"
}
```

- Add a synthetic built-in legacy provider entry with provider ID `logu`, display name `Logu`, and model ID `logu`.
- Insert `logu` into the provider database path used by `Provider.Service.list()` and `GET /provider`, not only into `custom(dep)`.
- Return `logu` in `GET /provider.connected` even when no auth/env/config provider key exists.
- Ensure `config.providers` includes `logu`, because the TUI model picker reads `sync.data.provider` from config sync.
- Keep the stored model string as `logu/logu`. The picker can display the model as `logu`, but do not add a bare `logu` parser alias in the first pass.
- Do not add `logu` to V2 available models until a V2 runner exists. `packages/core/src/session/runner/model.ts` cannot route to `packages/opencode` local fusion today.
- Give `logu` safe provider/model metadata: conservative context/output limits, no remote API URL, zero provider cost fields unless aggregate accounting is implemented, and capabilities that do not claim unsupported multimodal behavior.

## Config

Use the existing `local_fusion` config namespace for the first pass.

```jsonc
{
  "local_fusion": {
    "logu": {
      "branches": [
        {
          "model": "anthropic/claude-sonnet-4-5",
          "agent": "build",
          "toolPolicy": "parent_without_teams"
        },
        {
          "model": "openai/gpt-5.5",
          "agent": "plan",
          "toolPolicy": "parent_without_teams"
        }
      ],
      "judge": { "model": "openai/gpt-5.5" },
      "synthesizer": { "model": "anthropic/claude-sonnet-4-5" },
      "limits": { "maxBranches": 3, "timeout": 120000 }
    }
  }
}
```

- `local_fusion.logu` is the default config name for the `logu` model.
- If `local_fusion.logu` is missing, execution must fail with `logu requires local_fusion.logu config` and include `packages/web/src/content/docs/local-fusion.mdx` in the error text.
- `logu` remains selectable even when `local_fusion.logu` is missing, because selectability must not require provider connection.
- Add `parent_without_teams` to `ConfigLocalFusion.ToolPolicy`, but allow it only when the compound runner is invoked in logu mode.
- `/local_fusion` must reject `parent_without_teams` unless explicitly invoked as part of a `logu` run.
- Keep `readonly` and `none` semantics unchanged for existing local fusion users.

## Runtime Flow

Add a session-level runtime adapter rather than pretending `logu` is a remote provider.

```ts
type LoguRunInput = {
  sessionID: SessionID
  model: { providerID: "logu"; modelID: "logu" }
  agent: Agent.Info
  system: string[]
  messages: ModelMessage[]
  permission?: PermissionV1.Ruleset
  abort: AbortSignal
  promptOps: TaskPromptOps
}

type LoguRunResult = SessionCompound.RunResult
```

- Add `packages/opencode/src/session/logu.ts` with `SessionLogu.run(...)`.
- `SessionLogu.run(...)` must load `local_fusion.logu`, validate it with `SessionCompoundConfig.parse`, reject recursive `logu/logu` references in `branches[*].model`, `judge.model`, and `synthesizer.model`, render the current provider-turn transcript, and call `SessionCompound.run(...)`.
- Extend the prompt execution path that calls `LLM.stream(...)` so it can pass `TaskPromptOps` into `LLM.StreamInput`.
- In `packages/opencode/src/session/llm.ts`, branch on `input.model.providerID === "logu" && input.model.id === "logu"` before `provider.getLanguage(...)`, `provider.getProvider(...)`, or `auth.get(...)`.
- The logu path must not call `provider.getLanguage(...)` for `logu`.
- Convert `SessionLogu.run(...)` output into a normal single-step root assistant `LLMEvent` stream:
- `step-start`
- `text-start`
- one or more `text-delta` events for synthesizer text
- `text-end`
- `step-finish` with finish reason `stop`
- Use zero usage in the first pass unless aggregate child usage is already available without extra accounting work.
- If `SessionLogu.run(...)` fails before producing text, emit the existing session error path rather than a partial assistant message.
- Forward `input.abort` to `SessionCompound.run(...)`; child branch cancellation must keep using `promptOps.cancel(...)`.

## Conversation And Tool Semantics

`logu` must pass conversation context to the underlying compound run, not only the latest user string.

- Render a deterministic transcript from `input.system` and `input.messages`.
- Include user messages, assistant text, tool call summaries, and tool results in chronological order.
- Mark the latest user request explicitly, so branches know what to answer.
- For unsupported binary or multimodal parts in the first pass, include `[unsupported attachment: <mime>]` and do not crash transcript rendering.
- Branch sessions use the configured branch model and agent. Judge and synthesizer use their configured models.
- `parent_without_teams` must be implemented as boolean tool overrides passed through `promptOps.prompt(...)`, because child prompts accept `Record<string, boolean>` rather than prepared AI SDK tool definitions.
- For `parent_without_teams`, omit broad tool restrictions so the child session resolves tools from its agent/session permissions, then force-disable `team_create`, `team_spawn`, and `local_fusion`.
- Include `task: true` for `parent_without_teams` when the parent/tool permission model allows subagents.
- Judge and synthesizer keep tools disabled in the first pass.

## Permission, Question, And Labeling

Use existing permission/question mechanics; improve labels rather than introducing a parallel approval system.

- Rename child session titles from `Compound branch #N`, `Compound judge`, and `Compound synthesizer` to `Logu branch #N`, `Logu judge`, and `Logu synthesizer` for logu runs.
- Add child-session metadata with stage, index, model, variant, and parent logu run ID.
- Prefix permission and question prompt headers for logu children with the child label and model, for example `Logu branch #2 - openai/gpt-5.5`.
- Keep permission decisions scoped to the session that requested them. Do not auto-approve the same permission for sibling branches.
- If a branch-spawned subagent asks a permission or question, show both the subagent title and nearest logu branch label when available.

## TUI And App Behavior

- The prompt footer should show `logu` using normal provider/model metadata from `packages/tui/src/component/prompt/index.tsx`.
- The TUI model picker in `packages/tui/src/component/dialog-model.tsx` must work from `config.providers`.
- The app picker in `packages/app/src/components/dialog-select-model.tsx` must work from `GET /provider.connected`.
- Add a built-in TUI sidebar plugin for compound/logu runs, modeled after `packages/tui/src/feature-plugins/sidebar/team.tsx`, registered in `packages/tui/src/feature-plugins/builtins.ts`.
- The sidebar should list branch, judge, and synthesizer child sessions; show `session.status`; show pending permission/question counts; and link to child session navigation using existing session children APIs.
- Do not gate the logu sidebar on `experimental.agent_teams`. `logu` is not an agent team.
- App/web UI can initially rely on normal model picker and session output; a dedicated app-side compound panel is out of scope.

## Error Handling

- Missing `local_fusion.logu`: fail the assistant turn with a deterministic user-facing error and docs pointer.
- Recursive model reference: fail before creating branch sessions and name the offending path, such as `branches[1].model` or `judge.model`.
- All branches fail: reuse `SessionCompound.run(...)` failure behavior, but prefix the root error with `logu failed`.
- Branch timeout: keep current branch timeout behavior and surface timed-out branch state in metadata/sidebar.
- Permission denied: branch failure should not fail the whole logu run unless all branches fail.
- Abort/interruption: cancel active branch child sessions, then stop judge/synthesizer if they have not started or are running.

## Implementation Slices

### PR 1: Register The Local Model

- Add `logu/logu` provider/model metadata to the legacy provider database path used by `packages/opencode/src/provider/provider.ts`.
- Ensure `Provider.Service.list()` includes `logu`, so `config.providers` hydrates TUI picker state correctly.
- Ensure `GET /provider` returns `logu` in `all` and `connected` without env/auth.
- Ensure TUI and app pickers display `logu` through normal provider data.
- Do not add `logu` to V2 available models until a core/V2 logu runner exists.
- Prevent `logu` from becoming the automatic default fallback unless `local_fusion.logu` exists.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/provider/provider.test.ts test/provider/model-status.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/tui && bun typecheck`
- `cd packages/app && bun typecheck`

Review:

A fresh read-only reviewer must confirm `logu` is selectable without credentials through both `config.providers` and `GET /provider`, no provider connect UI is required, and no V2 broken model is exposed.

### PR 2: Add The Logu Runtime Adapter

- Add `SessionLogu.run(...)` in `packages/opencode/src/session/logu.ts`.
- Add `promptOps` to the prompt-to-LLM call chain so `LLM.stream(...)` can invoke `SessionCompound.run(...)` for `logu`.
- Special-case `logu/logu` in `packages/opencode/src/session/llm.ts` before provider language/auth lookup.
- Render the parent conversation into a deterministic prompt string for compound branches.
- Convert final synthesizer output into the full single-step root `LLMEvent` sequence.
- Add config validation for missing `local_fusion.logu` and recursive `logu/logu` references in branches, judge, and synthesizer.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-config.test.ts test/session/compound-runner.test.ts test/tool/local-fusion.test.ts`
- `cd packages/opencode && bun test --timeout 30000 test/session/logu.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must inspect recursion prevention, abort propagation, transcript determinism, concrete `LLMEvent` ordering, and provider setup bypass for `logu`.

### PR 3: Enable Logu Tool Delegation Without Agent Teams

- Add `parent_without_teams` to `ConfigLocalFusion.ToolPolicy`.
- Gate `parent_without_teams` so normal `/local_fusion` calls reject it unless running in logu mode.
- Implement `parent_without_teams` as child prompt boolean overrides: inherit normal child tool resolution, explicitly enable `task` when allowed, and force-disable `team_create`, `team_spawn`, and `local_fusion`.
- Preserve existing `readonly` and `none` local fusion behavior.
- Add tests proving a logu branch can request a `task` subagent and cannot access team tools.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-runner.test.ts test/tool/local-fusion.test.ts test/tool/task.test.ts`
- `cd packages/opencode && bun test --timeout 30000 test/session/logu.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must confirm no path lets a logu branch or branch-spawned subagent create agent teams or invoke nested local fusion.

### PR 4: Label And Display Logu Child Work

- Add logu-specific child session titles and metadata in the compound runtime.
- Prefix TUI permission/question labels for logu child sessions in `packages/tui/src/routes/session/permission.tsx` and `packages/tui/src/routes/session/question.tsx`.
- Add a built-in logu/compound sidebar plugin using `packages/tui/src/routes/session/sidebar.tsx`, `packages/tui/src/feature-plugins/builtins.ts`, and existing session child/status APIs.
- Keep app/web dedicated side-panel work out of scope.

Verification:

- `cd packages/tui && bun test --timeout 30000 test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/model-options.test.ts`
- `cd packages/tui && bun typecheck`
- `cd packages/opencode && bun test --timeout 30000 test/session/compound-runner.test.ts test/session/logu.test.ts`

Review:

A fresh read-only reviewer must confirm prompts identify the underlying branch/judge/synthesizer and model, and that the sidebar is not coupled to `experimental.agent_teams`.

### PR 5: Document Configuration And Failure Modes

- Update `packages/web/src/content/docs/local-fusion.mdx` with `local_fusion.logu`, `parent_without_teams`, and the no-agent-teams constraint.
- Add a model-picker note explaining that `logu` is local and always selectable but still needs underlying branch providers configured.
- Document missing config, recursive model references, branch timeout, all-branches-failed behavior, and no V2 support in the first pass.

Verification:

- `cd packages/web && bun run build`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must check that docs match implemented config names, exact errors, and first-pass limitations.

## Future Work

- Learned routing or dynamic per-query workflow generation similar to Fugu/Fugu-Ultra.
- A `logu-ultra` model with deeper branch topologies or more than one judge/synthesis round.
- Dedicated app/web visualization for compound execution.
- Aggregate usage/cost reporting across branches, judge, and synthesizer.
- Metrics comparing `logu` latency, cost, and success rate against single models.
- Support for judge or synthesizer tool access after permission-labeling and isolation rules are proven safe.

## Open Questions

- Should `logu` ship with a built-in default `local_fusion.logu` config? Default recommendation: no, because choosing underlying models without user intent can create surprise cost, latency, and provider dependency.
- Should the picker display `logu` while storing `logu/logu`? Default recommendation: yes, because it satisfies the user-facing model name without changing the existing `provider/model` grammar.
- Should V2 sessions support `logu` in the first implementation? Default recommendation: no, unless the same work adds a core/V2 logu runner. Do not expose a selectable V2 model that cannot execute.
