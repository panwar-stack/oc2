# Virtual Fugu Proxy Model

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

## Non-Negotiables

- `fugu` must be selectable even when `opencode.json` has no `fugu` config.
- Missing or invalid `fugu` config must fail at request time with a clear configuration error.
- Branch and synthesizer targets must resolve through existing model and variant resolution.
- Do not hardcode OpenAI, DeepSeek, provider IDs, credentials, or request formats.
- Do not call `Provider.getLanguage(...)` for `fugu`; intercept before real provider loading.
- Reject circular routing where any branch, judge, or synthesizer resolves to `fugu`.
- Do not expose branch responses, branch metadata, prompts, provider keys, stack traces, or routing internals to the caller unless existing debug logging explicitly allows it.
- Each turn must recompute branches from the caller-supplied conversation context. Do not create visible per-branch conversations as durable user-facing history.
- First pass must preserve behavior for non-`fugu` models and must not change default model selection.
- First pass must not allow hidden branch or synthesizer tool execution. Branch and synthesizer calls should run with no tools unless a reviewed tool-policy design is added.
- `judge` config must be parsed and preserved. Do not add judge execution in the first pass unless reuse of existing compound code makes it natural without changing user-visible behavior.

## Config

Add a top-level config object to `ConfigV1.Info`:

```ts
fugu?: {
  branches?: Array<{
    model: string
    variant?: string
  }>
  judge?: {
    model: string
    variant?: string
  }
  synthesizer?: {
    model: string
    variant?: string
  }
}
```

Runtime request validation must require:

- `fugu.branches` exists and has at least one item.
- Every branch has `model` and does not resolve to `fugu`.
- Every branch has `variant` when the existing resolver requires one.
- `fugu.synthesizer` exists.
- `fugu.synthesizer.model` exists and does not resolve to `fugu`.
- `fugu.synthesizer.variant` exists when the existing resolver requires one.
- `fugu.judge`, when present, has `model`, resolves through the same parser, and does not resolve to `fugu`.

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

Docs to update:

- `packages/web/src/content/docs/config.mdx` with config shape, request-time failure behavior, circular-routing rejection, no-hidden-tools first-pass behavior, and judge limitation.
- Generated JS SDK types after OpenAPI config schema changes.

## Model Surface

Represent `fugu` as a built-in virtual provider/model pair:

```ts
{ providerID: "fugu", modelID: "fugu" }
```

Required surfaces:

- Legacy `/provider` must include a connected non-deprecated `fugu` provider with one `fugu` model so `packages/app/src/context/models.tsx` can list it.
- Legacy `/config/providers` must include the same connected provider/model so `packages/tui/src/component/dialog-model.tsx` can list it.
- v2 `/api/model` and `/api/provider` must include the virtual model through catalog population, preferably a small additive catalog transform near existing provider/model plugin setup.
- The virtual model must use safe static metadata values that satisfy legacy `Provider.Model` and v2 `ModelV2.Info` requirements: enabled, non-deprecated status, no real API connection, zero cost, conservative limits, empty or explicit variants, and no tool-specific capabilities beyond what the adapter supports.

## Runtime Flow

1. `packages/opencode/src/session/prompt.ts` continues storing the selected model and variant with the existing `PromptInput` shape.
2. `packages/opencode/src/session/llm.ts` detects `{ providerID: "fugu", modelID: "fugu" }` before `Provider.getLanguage(...)`.
3. The `fugu` path reads `Config.Service` and validates `config.fugu` at request time.
4. Branch and synthesizer targets are parsed with `Provider.parseModel(...)` and resolved with `Provider.getModel(...)`.
5. Branch and synthesizer requests update both the resolved `Provider.Model` and the copied request/user model variant so existing variant application is reused.
6. Branch calls receive the original system messages, developer messages, conversation history, and current turn unchanged, but no executable tools in the first pass.
7. Branch calls run concurrently where the Effect/request architecture allows.
8. Branch collection records `{ model, variant, status, text | error }`.
9. If at least one branch succeeds, build a synthesizer request using the configured synthesizer model/variant, original context, branch outputs, and branch metadata.
10. Return only the synthesizer `LLMEvent` stream to `SessionProcessor.process(...)`.

Synthesizer instruction:

```text
You are the final response synthesizer for a proxy model. You will receive the original conversation context and multiple candidate responses from branch models. Produce a single final answer for the caller. Preserve the caller intent, follow the original system and developer instructions, correct errors where branch responses disagree, and do not mention that multiple models were used unless the caller explicitly asks about the implementation. Do not simply concatenate branch responses; reconcile them into one answer.
```

## Streaming

Preferred first pass:

- Branch calls complete internally before synthesis starts.
- The synthesizer response streams to the caller through normal `LLMEvent` handling.

Fallback:

- Emit one normal text block containing the completed synthesizer response.
- Add an internal code note naming the missing seam needed to stream synthesizer deltas.
- Do not expose branch progress as caller-visible streaming events.

## Error Handling And Logs

- Missing `config.fugu`, empty branches, missing synthesizer, invalid target model, invalid required variant, and circular `fugu` targets must fail before provider requests start.
- If one branch fails and at least one succeeds, continue to synthesis with successful text and structured failed-branch records.
- If all branches fail, return a normal model error.
- If the synthesizer fails, return a normal model error.
- Logs must include `fugu` selected, branch count, branch model/variant names, branch success/failure, synthesizer model/variant, and synthesizer success/failure.
- Logs must not include full prompts or responses by default.

## Implementation Slices

### PR 1: Config Schema And Virtual Model Visibility

- Add `fugu` to `ConfigV1.Info` in `packages/core/src/v1/config/config.ts`.
- Evaluate/update `packages/core/src/v1/config/migrate.ts` so v1 detection and migration preserve `fugu`.
- Add config parser tests in `packages/opencode/test/config/config.test.ts` for accepted `fugu`, missing optional `fugu`, unknown-key regression, and preserved `judge`.
- Inject a built-in virtual `fugu` provider/model into `packages/opencode/src/provider/provider.ts` for `/provider` and `/config/providers`.
- Inject the same virtual provider/model into the v2 catalog path via a small catalog/provider population seam near `packages/core/src/plugin/models-dev.ts`, `packages/core/src/config/plugin/provider.ts`, or `Catalog.Service.transform()`.
- Add/update provider and picker visibility tests.
- Update `packages/web/src/content/docs/config.mdx`.
- Regenerate JS SDK types with `./packages/sdk/js/script/build.ts`.

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/core && bun test test/config/config.test.ts test/catalog.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/config/config.test.ts test/provider/provider.test.ts test/server/httpapi-provider.test.ts --timeout 30000`
- `cd packages/server && bun typecheck`
- `cd packages/app && bun typecheck`
- `cd packages/app && bun test --preload ./happydom.ts ./src/context/models.test.tsx`
- `cd packages/tui && bun typecheck`
- `cd packages/tui && bun test test/cli/cmd/tui/model-options.test.ts test/util/model.test.ts --timeout 30000`
- `./packages/sdk/js/script/build.ts`

Review:

Run a fresh read-only sub-agent/teammate against the PR diff and this slice. Verify `fugu` appears without config, non-`fugu` provider lists are unchanged except the additive virtual model, docs match schema, and no provider routing was added.

### PR 2: Runtime Adapter And Core Behavior

- Add a focused `fugu` adapter near `packages/opencode/src/session/llm.ts` or under `packages/opencode/src/session/llm/`.
- Validate `config.fugu` at request time.
- Resolve branch and synthesizer targets through existing parser/model resolution.
- Reject circular branch, judge, and synthesizer targets.
- Update both resolved model and copied request/user variant for branch and synthesizer calls.
- Fan out branch calls concurrently with the parent abort signal.
- Disable tools for branch and synthesizer calls in the first pass.
- Collect branch text and structured failures without caller-visible exposure.
- Build the synthesizer request with original context, branch outputs, metadata, and required instruction.
- Return only synthesizer events.
- Add tests for fanout, original context preservation, synthesizer input, synthesizer-only output, missing config, circular rejection, partial branch failure, all-branch failure, and synthesizer failure.
- Add internal logs for selection, branch count, branch success/failure, synthesizer target, and synthesizer success/failure.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/session/llm.test.ts test/session/compound-runner.test.ts test/session/compound-synthesizer.test.ts test/tool/local-fusion.test.ts --timeout 30000`

Review:

Run a fresh read-only sub-agent/teammate against the PR diff and this slice. Verify the adapter cannot recurse into `fugu`, branch calls preserve original context except model/variant and tool removal, partial branch failures are only synthesizer input, and normal models still use the existing provider path.

### PR 3: End-To-End Session And Streaming Coverage

- Add session/processor tests showing a normal request to `{ providerID: "fugu", modelID: "fugu" }` persists only the synthesizer response.
- Test system messages, developer messages, prior user/assistant history, and current turn reach every branch and the synthesizer.
- Test branch text and metadata are not persisted or streamed to the caller.
- Preserve synthesizer streaming if the adapter can return synthesizer deltas without invasive changes.
- If streaming is deferred, add a narrow nonstreaming test and internal code note documenting the future streaming seam.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/session/llm.test.ts test/session/processor.test.ts test/provider/provider.test.ts --timeout 30000`
- `cd packages/server && bun typecheck`

Review:

Run a fresh read-only sub-agent/teammate against the PR diff and this slice. Verify acceptance cases are covered, branch internals remain hidden, and the streaming/nonstreaming decision is explicit in code and tests.

## Future Work

- Execute `fugu.judge` using `packages/opencode/src/session/compound/judge.ts` if judge-guided synthesis becomes a product requirement.
- Add branch timeouts, tool policy, or prompt customization after the base API-level proxy works.
- Add richer debug observability behind existing debug controls.
- Support nested proxy models only with an explicit recursion-depth design.

## Open Questions

- Should `judge` be required even though first-pass runtime does not use it? Default: no, keep it optional but parsed and preserved.
- Should v2 `/api/model` visibility be required in PR 1? Default: yes, include it so app, TUI, and v2 API do not diverge.
- If a branch emits tool calls but no final text, should it count as successful? Default: no, because first-pass branches should not execute tools and synthesis needs text candidates.
