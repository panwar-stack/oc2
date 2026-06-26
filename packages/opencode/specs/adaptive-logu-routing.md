# Adaptive Logu Routing

## Goal

Make `logu/logu` choose between direct single-model execution and Local Fusion based on prompt complexity, without changing behavior for existing users.

The first pass must add opt-in top-level `logu` config, deterministic routing, and a direct route that reuses the normal provider execution path. `local_fusion.logu` must remain only the compound workflow definition.

## Current State

- `packages/opencode/src/session/llm.ts:103-121` special-cases `logu/logu` before normal provider execution.
- `packages/opencode/src/session/logu.ts:28-36` always reads `local_fusion.logu` and fails if it is missing.
- `packages/opencode/src/session/logu.ts:38-47` renders a transcript and calls `SessionCompound.run`.
- `packages/opencode/src/session/logu.ts:75-86` rejects recursive `logu/logu` references inside branch, judge, and synthesizer models.
- `packages/core/src/v1/config/config.ts:113-115` defines `local_fusion` but has no top-level `logu` config.
- `packages/core/src/config/local-fusion.ts` owns only Local Fusion config shape.
- `packages/opencode/src/provider/provider.ts:2073-2079` has `Provider.parseModel(model)` returning `{ providerID, modelID }`, not a full `Provider.Model`.
- `packages/web/src/content/docs/local-fusion.mdx:100-249` documents Logu as always running reserved `local_fusion.logu`.
- `packages/opencode/test/session/logu.test.ts` already covers missing `local_fusion.logu`, transcript rendering, recursive fusion model rejection, child session creation, and Logu failure wrapping.

## Non-Negotiables

- Existing configs with `model: "logu/logu"` and no top-level `logu` config must keep always-fusion behavior.
- Adaptive routing must be opt-in by adding top-level `logu` config.
- If `logu` exists and `logu.routing.mode` is omitted, default to `"auto"`.
- Direct routing must use the normal provider path in `LLM.run`; do not create fake compound child sessions.
- Direct routing must require `logu.model`.
- `logu.model` must reject `logu/logu` to prevent recursion.
- Missing `local_fusion.<name>` must fail only when the selected route is fusion.
- Missing `logu.model` must fail only when the selected route is direct.
- The first router must be deterministic and synchronous. Do not add a classifier model.
- Leave prompt-level override phrases like "force fusion" out of the first pass.
- Leave V2 session behavior out of this change.

## Config

Add top-level `logu` config separate from `local_fusion`.

Recommended schema location:

- `packages/core/src/config/logu.ts`
- `packages/core/src/v1/config/config.ts`

Shape:

```ts
export const RoutingMode = Schema.Literals(["auto", "always", "never"])

export const Info = Schema.Struct({
  model: Schema.optional(Schema.String),
  fusion: Schema.optional(Schema.String),
  routing: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(RoutingMode),
    }),
  ),
})
```

Config behavior:

- No `logu` config means legacy always-fusion mode.
- `logu.routing.mode: "always"` always uses fusion.
- `logu.routing.mode: "never"` always uses direct model execution.
- `logu.routing.mode: "auto"` uses deterministic routing.
- `logu.fusion` defaults to `"logu"`.
- `logu.model` is the underlying provider model for direct route.
- `logu.model` is validated only when direct route is selected.

Example:

```jsonc
{
  "model": "logu/logu",
  "logu": {
    "model": "anthropic/claude-sonnet-4-5",
    "fusion": "logu",
    "routing": {
      "mode": "auto"
    }
  },
  "local_fusion": {
    "logu": {
      "branches": [{ "model": "anthropic/claude-sonnet-4-5" }],
      "judge": { "model": "openai/gpt-5-mini" },
      "synthesizer": { "model": "anthropic/claude-sonnet-4-5" }
    }
  }
}
```

## Runtime Design

Refactor `packages/opencode/src/session/llm.ts` so the current normal provider path can be called from both normal models and direct Logu routing.

Target shape:

```ts
const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
  if (isLoguModel(input.model)) return yield* runLogu(input)
  return yield* runProvider(input)
})
```

`runProvider(input)` must contain the existing provider execution path from `packages/opencode/src/session/llm.ts:123` onward.

`runLogu(input)` must:

- Read config once through `Config.Service`.
- Preserve legacy behavior when `cfg.logu` is absent by calling existing fusion behavior.
- Select route with `SessionLogu.route(...)`.
- Require `promptOps` and `Session.Service` only for fusion route.
- Resolve direct model with `Provider.parseModel(cfg.logu.model)`, then `provider.getModel(parsed.providerID, parsed.modelID)`.
- Reject direct model when parsed provider/model is `logu/logu`.
- Call `runProvider({ ...input, model: resolvedModel })` for direct route.
- Call `SessionLogu.run` for fusion route.

Direct route must preserve existing provider behavior:

- Streaming.
- Tool calls.
- Telemetry.
- Usage accounting.
- Native-runtime fallback.
- Provider transforms.
- Permissions.
- Normal session event behavior.

## Router

Keep routing near existing Logu code unless it grows too large:

- Preferred first location: `packages/opencode/src/session/logu.ts`.
- Acceptable if larger: `packages/opencode/src/session/logu/route.ts`.

Recommended API:

```ts
export function route(input: {
  config?: ConfigV1.Info["logu"]
  system: string[]
  messages: ModelMessage[]
}): "direct" | "fusion"
```

Deterministic behavior:

- No `logu` config returns `"fusion"`.
- `mode: "always"` returns `"fusion"`.
- `mode: "never"` returns `"direct"`.
- `mode: "auto"` inspects latest user text plus recent assistant/tool context.

Route to fusion for:

- Code review, architecture, security, migration, regression, root cause, race condition, database, auth, serialization, broad repo investigation, specs, implementation plans, tradeoffs, and multiple approaches.
- Latest user text longer than a fixed threshold such as `1200` characters.
- Recent tool failures, failed commands, stack traces, or explicit "this failed" debugging context.

Route direct for:

- Greetings.
- Simple factual questions.
- Small explanations.
- One obvious edit.
- Formatting or docs tweaks.
- Date/time or command-like requests.

## Error Handling

Use route-specific failures:

```txt
logu direct route requires logu.model
logu.model cannot reference logu/logu
logu fusion route requires local_fusion.<name> config; see packages/web/src/content/docs/local-fusion.mdx
```

Rules:

- Existing legacy error text can remain for no-`logu` always-fusion users.
- If `logu.fusion` is configured, missing fusion config errors must name that key.
- Invalid direct model strings must fail on direct route, not at config load.

## Implementation Slices

### PR 1: Config And Router

- Add `packages/core/src/config/logu.ts` with `ConfigLogu.Info`.
- Add `logu: Schema.optional(ConfigLogu.Info)` to `packages/core/src/v1/config/config.ts`.
- Add `SessionLogu.route(...)` with deterministic route selection.
- Add focused router tests in `packages/opencode/test/session/logu.test.ts` or `packages/opencode/test/session/logu-routing.test.ts`.
- Do not change `LLM.run` behavior yet.

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/opencode && bun test test/session/logu.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer before merge. The reviewer must confirm legacy runtime behavior is unchanged, routing is deterministic, and config shape stays separate from `local_fusion`.

### PR 2: Direct Provider Route

- Extract the normal provider execution path in `packages/opencode/src/session/llm.ts` into a local `runProvider` helper.
- Add `runLogu` route selection.
- Preserve no-`logu` legacy behavior as always fusion.
- Resolve `logu.model` through `Provider.parseModel(...)` and `provider.getModel(...)`.
- Reject `logu.model: "logu/logu"`.
- Require `promptOps` only on fusion route.
- Add tests for `mode: "never"` direct route, missing direct model, recursive direct model, and provider path reuse.

Verification:

- `cd packages/opencode && bun test test/session/logu.test.ts`
- `cd packages/opencode && bun test test/session/llm.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer before merge. The reviewer must check that direct mode does not bypass tools, telemetry, permissions, provider transforms, native runtime selection, or usage accounting.

### PR 3: Auto Routing Coverage

- Add tests for simple auto prompts routing direct.
- Add tests for review, security, architecture, spec, and migration prompts routing fusion.
- Add tests for long latest user prompts routing fusion.
- Add tests for recent tool failure context routing fusion.
- Add tests that missing `local_fusion.<name>` fails only when auto selects fusion.
- Add tests that missing `logu.model` fails only when auto selects direct.
- Add tests for custom `logu.fusion`.

Verification:

- `cd packages/opencode && bun test test/session/logu.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer before merge. The reviewer must challenge false positives and false negatives in the heuristic and confirm each case is asserted deterministically.

### PR 4: Docs

- Update `packages/web/src/content/docs/local-fusion.mdx`.
- Document legacy always-fusion behavior.
- Document top-level `logu.model`, `logu.fusion`, and `logu.routing.mode`.
- Explain that `local_fusion.logu` remains the fusion workflow.
- Add direct-vs-fusion guidance.
- Add examples for legacy Logu and adaptive Logu.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/web && bun typecheck`

Review:

Use a fresh read-only reviewer before merge. The reviewer must confirm docs match runtime defaults and do not imply existing users are automatically moved to adaptive routing.

## Future Work

- Add route decision metadata to session logs or assistant metadata.
- Add explicit UI or command-level route override.
- Tune heuristic thresholds from real usage.
- Consider classifier-based routing only if deterministic routing is insufficient and latency/cost are acceptable.

## Open Questions

- Should adding top-level `logu` default routing to `"auto"`? Default recommendation: yes, because adding `logu` is the explicit opt-in.
- Should `logu.fusion` support names other than `"logu"`? Default recommendation: yes, with `"logu"` as default, because it avoids hardcoding and adds little implementation cost.
