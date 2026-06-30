# Virtual Fugu Proxy Model

Status note: implemented. This document started as the original design plan; the implementation has moved past the initial first-pass constraints. `judge` now executes when configured, private branch and judge stages receive caller tool definitions as non-executing suggestions, the synthesizer receives executable caller tools, and only synthesizer output is returned to the session.

## Goal

Add `fugu` as a virtual application-level model selectable like any other model. When selected, `fugu` must use the caller's normal model request as the source of truth, fan out that turn to configured branch models through existing model and variant resolution, send branch outputs plus the original context to a configured synthesizer model, and return only the synthesizer response.

The implementation strategy is to add a small virtual model surface for selection and resolution, then intercept `fugu` before provider language-model loading. Do not add provider-specific routing, a provider translation layer, or a new model registry for branch and synthesizer targets.

## Current State

- `packages/core/src/v1/config/config.ts` defines `ConfigV1.Info`, the config schema used by runtime parsing, HTTP config APIs, generated SDK types, and config schema generation.
- `packages/opencode/src/config/parse.ts` rejects unknown top-level config keys before Effect schema decode, so `fugu` must be part of the accepted schema before `opencode.json` can contain it.
- `packages/core/src/v1/config/migrate.ts` and `packages/core/src/config.ts` participate in v1 config detection and migration; adding `fugu` must not cause a config containing only `fugu` to be dropped or misclassified.
- `packages/core/src/config/local-fusion.ts` already defines compound-style `Branch`, `Judge`, and `Synthesizer` shapes with `model` and optional `variant`.
- `packages/opencode/src/provider/provider.ts` owns legacy provider/model state, `Provider.parseModel`, `Provider.Service.list()`, `Provider.getModel(...)`, and `Provider.getLanguage(...)`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts` serves `/provider`, used by the app picker through `packages/app/src/context/global-sync/bootstrap.ts` and `packages/app/src/context/models.tsx`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts` serves `/config/providers`, used by the TUI picker through `packages/tui/src/context/sync.tsx` and `packages/tui/src/component/dialog-model.tsx`.
- `packages/server/src/handlers/model.ts` serves v2 `/api/model` from `Catalog.Service.model.available()`. v2 catalog population is adjacent to `packages/core/src/plugin/models-dev.ts`, `packages/core/src/config/plugin/provider.ts`, and `Catalog.Service.transform()`.
- `packages/opencode/src/session/llm.ts` exposes `LLM.Service.stream(input)` and currently resolves real provider language models with `provider.getLanguage(input.model)`.
- `packages/opencode/src/session/llm/request.ts` applies variants from the copied request user model variant, so `fugu` branch/synth requests must update both the resolved model and request/user variant.
- `packages/opencode/src/session/processor.ts` consumes `llm.stream(...)` events and persists assistant output, retries, errors, and interrupts.
- `packages/opencode/src/session/compound/runner.ts`, `judge.ts`, `synthesizer.ts`, and `config.ts` already implement tool-level fan-out/synthesis behavior for local fusion and should be reused or extracted where they fit.

## Implemented Constraints

- `fugu` must be selectable even when `opencode.json` has no `fugu` config.
- Missing or invalid `fugu` config must fail at request time with a clear configuration error.
- Branch, judge, and synthesizer targets must resolve through existing model and variant resolution.
- Do not hardcode OpenAI, DeepSeek, provider IDs, credentials, or request formats.
- Do not call `Provider.getLanguage(...)` for `fugu`; intercept before real provider loading.
- Reject circular routing where any branch, judge, or synthesizer resolves to `fugu/fugu`.
- Do not expose branch responses, judge guidance, branch metadata, prompts, provider keys, stack traces, private tool-call proposals, or routing internals to the caller unless existing debug logging explicitly allows it.
- Each turn must recompute branches from the caller-supplied conversation context. Do not create visible per-branch conversations as durable user-facing history.
- Preserve behavior for non-`fugu` models and do not change default model selection.
- Branch and judge calls must not execute tools. They may receive caller tool definitions with executable handlers removed so tool calls can be treated as private suggestions.
- The synthesizer is the only caller-visible model stream. It receives the caller's executable tools and `toolChoice`, may emit tool calls normally, and returns the only Fugu text/tool output to the session.
- `judge` is optional. When configured, it executes after branch collection and sends private evaluator guidance to the synthesizer.

## Config

The config schema is permissive so opencode can start and invalid Fugu setup fails only when `fugu/fugu` is selected:

```ts
fugu?: {
  branches?: Array<{
    model?: string
    variant?: string
  }>
  judge?: {
    model?: string
    variant?: string
  }
  synthesizer?: {
    model?: string
    variant?: string
  }
}
```

Runtime request validation in `packages/opencode/src/session/llm/fugu.ts` requires:

- `fugu.branches` exists and has at least one item.
- Every branch has a non-empty `model`, uses `provider/model`, resolves to a normal model, and does not resolve to `fugu/fugu`.
- Every branch has the exact `variant` when the resolved model requires one, and any supplied variant is supported by the target model.
- `fugu.synthesizer` exists.
- `fugu.synthesizer.model` exists, uses `provider/model`, resolves to a normal model, and does not resolve to `fugu/fugu`.
- `fugu.synthesizer.variant` satisfies the same required/supported variant checks as branches.
- `fugu.judge`, when present, has `model`, resolves through the same runtime validator, and does not resolve to `fugu/fugu`.

Example:

```json
{
  "fugu": {
    "branches": [
      { "model": "deepseek/deepseek-v4-pro", "variant": "medium" },
      { "model": "openai/gpt-5.5", "variant": "medium" }
    ],
    "judge": { "model": "openai/gpt-5.5", "variant": "high" },
    "synthesizer": { "model": "openai/gpt-5.5", "variant": "high" }
  }
}
```

Public docs in `packages/web/src/content/docs/config.mdx` describe `model` as required for a usable Fugu configuration even though generated schemas and SDK types allow it to be omitted for request-time validation.

## Model Surface

Represent `fugu` as a built-in virtual provider/model pair:

```ts
{ providerID: "fugu", modelID: "fugu" }
```

Required surfaces:

- Legacy `/provider` must include a connected non-deprecated `fugu` provider with one `fugu` model so `packages/app/src/context/models.tsx` can list it.
- Legacy `/config/providers` must include the same connected provider/model so `packages/tui/src/component/dialog-model.tsx` can list it.
- v2 `/api/model` and `/api/provider` must include the virtual model through catalog population, preferably a small additive catalog transform near existing provider/model plugin setup.
- The virtual model must use safe static metadata values that satisfy legacy `Provider.Model` and v2 `ModelV2.Info` requirements: enabled, non-deprecated status, no real API connection, zero cost, conservative limits, empty or explicit variants, and tool capability enabled because the synthesizer can use caller tools.

## Runtime Flow

1. `packages/opencode/src/session/prompt.ts` continues storing the selected model and variant with the existing `PromptInput` shape.
2. `packages/opencode/src/session/llm.ts` detects `{ providerID: "fugu", modelID: "fugu" }` before `Provider.getLanguage(...)`.
3. The `fugu` path reads `Config.Service` and validates `config.fugu` at request time.
4. Branch, judge, and synthesizer targets are parsed as `provider/model` labels and resolved with `Provider.getModel(...)`.
5. Branch, judge, and synthesizer requests update both the resolved `Provider.Model` and the copied request/user model variant so existing variant application is reused.
6. Branch calls receive the original system messages, developer messages, conversation history, and current turn unchanged, plus caller tool definitions with `execute` removed.
7. Branch calls run concurrently with unbounded Effect concurrency.
8. Branch collection records `{ model, variant, status, text | toolCalls | error }`. A branch succeeds when it returns text or private tool-call proposals.
9. If at least one branch succeeds and `fugu.judge` is configured, the judge receives the original context plus private branch results and returns evaluator guidance.
10. If at least one branch succeeds, build a synthesizer request using the configured synthesizer model/variant, original context, branch outputs, optional judge guidance, the Fugu synthesizer instruction, and the caller's executable tools.
11. Return only the synthesizer `LLMEvent` stream to `SessionProcessor.process(...)`.

Synthesizer instruction:

```text
You are the final answer synthesizer for a proxy model. You will receive the original conversation context, active system and developer instructions, multiple candidate answers, and optional candidate tool-call suggestions or evaluator guidance. Produce one final answer for the caller. Preserve the caller intent, follow the original instructions, reconcile disagreements, correct errors, and do not mention branch models or proxy architecture unless the caller explicitly asks. Candidate tool calls are suggestions only; emit your own tool calls using your available tools when a tool is actually needed.
```

## Streaming

- Branch and judge calls complete internally before synthesis starts.
- The synthesizer response streams to the caller through normal `LLMEvent` handling.
- Branch progress is not exposed as caller-visible model output. Live orchestration progress is emitted separately through `session.next.fugu.status`.

## Error Handling And Logs

- Missing `config.fugu`, empty branches, missing synthesizer, missing target model, malformed target model, unresolved target model, invalid required variant, invalid supplied variant, and circular `fugu/fugu` targets must fail before provider requests start.
- If one branch fails and at least one succeeds, continue to synthesis with successful text, private tool-call suggestions, and structured failed-branch records.
- If all branches fail, return a normal model error.
- If the synthesizer fails or its stream throws, return a normal model error and emit Fugu-specific failure status/logging.
- Logs must include `fugu` selected, branch count, branch model/variant names, branch success/failure, synthesizer model/variant, and synthesizer success/failure.
- Logs must not include full prompts or responses by default.

## Live Status

- Fugu publishes live-only `session.next.fugu.status` events after validation succeeds.
- Status includes a run ID, phase, branch statuses, optional judge status, and synthesizer status.
- Status never includes branch text, judge guidance, tool proposals, errors, model IDs, variants, prompts, provider keys, or stack traces.
- The app and TUI render inline Fugu progress near the active turn and clear it when the run completes, fails, or the session becomes idle.

## Implementation Summary

- Config schema and v1 migration preserve the top-level `fugu` object in `packages/core/src/config/fugu.ts`, `packages/core/src/config.ts`, and `packages/core/src/v1/config/config.ts`.
- Legacy provider lists inject a connected virtual `fugu` provider/model in `packages/opencode/src/provider/provider.ts`; `enabled_providers` does not hide it, while `disabled_providers: ["fugu"]` is an explicit opt-out.
- The v2 catalog path injects the same virtual provider/model through `packages/core/src/plugin/fugu.ts`.
- Runtime orchestration lives in `packages/opencode/src/session/llm/fugu.ts` and is selected from `packages/opencode/src/session/llm.ts`.
- Request preparation supports `forbidImplicitTools` in `packages/opencode/src/session/llm/request.ts`; branch and judge calls use it to prevent implicit compatibility tools.
- Live inline status is published as `session.next.fugu.status` and rendered by the app and TUI while the active Fugu turn is running.

## Verification Coverage

- Config parsing and migration: `packages/opencode/test/config/config.test.ts`.
- Legacy provider visibility, allowlist behavior, disable behavior, and default-model fallback: `packages/opencode/test/provider/provider.test.ts`.
- Runtime validation, branch fan-out, judge guidance, synthesizer-only output, tool proposal handling, partial/all failure behavior, synthesizer failure logging, and live status events: `packages/opencode/test/session/llm.test.ts`.
- v2 `/api/model` and `/api/provider` visibility: `packages/opencode/test/server/httpapi-v2-fugu-model-provider.test.ts`.
- App model picker visibility: `packages/app/src/context/models.test.tsx`.
- App Fugu live-state cleanup: `packages/app/src/context/global-sync/event-reducer.test.ts` and `packages/app/src/context/global-sync/session-cache.test.ts`.
- TUI model parsing and picker visibility: `packages/tui/test/util/model.test.ts` and `packages/tui/test/cli/cmd/tui/model-options.test.ts`.

## Future Work

- Add branch timeouts, richer tool policy controls, or prompt customization only with a reviewed design.
- Add richer debug observability behind existing debug controls.
- Support nested proxy models only with an explicit recursion-depth design.
- Persist completed Fugu orchestration status only if durable replay becomes a product requirement.

## Open Questions

- Should `disabled_providers: ["fugu"]` continue to hide the virtual model? Current behavior: yes, it is the explicit opt-out.
- Should completed inline Fugu status remain visible after the synthesizer finishes? Current behavior: no, app/TUI clear the live row when the run completes, fails, or the session becomes idle.
- Should failed branch errors be shown in UI status? Current behavior: no, only `failed` or `timed out` is exposed; details stay in logs.
