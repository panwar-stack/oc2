# Anthropic Automatic Prompt Caching

## Goal

Incorporate Anthropic top-level `cache_control` into OC2's existing prompt cache infrastructure so supported Claude requests get cost-saving prompt caching by default without provider field leakage or prompt reordering.

Default to the lowest-cost effective setting: `{"type":"ephemeral"}` with the implicit `5m` TTL. Keep `1h` TTL opt-in only because Anthropic prices 1-hour cache writes at `2x` base input cost versus `1.25x` for 5-minute writes.

## Current State

- `packages/opencode/src/session/llm/request.ts` already calls `CachePlanner.planCache({ cachePolicy: "auto", ... })`, carries `params.cachePlan`, and runs cache guardrails.
- `packages/llm/src/cache/capability.ts` classifies Anthropic as `promptCaching: "explicit"` with max 4 breakpoints, `5m` / `1h` durations, `cache_control`, and usage fields.
- `packages/llm/src/protocols/anthropic-messages.ts` lowers explicit breakpoints to Anthropic wire `cache_control`, enforces `ANTHROPIC_BREAKPOINT_CAP = 4`, and reads `cache_creation_input_tokens` / `cache_read_input_tokens`.
- `packages/opencode/src/provider/transform.ts` applies AI SDK Anthropic cache hints through `providerOptions.anthropic.cacheControl`.
- `docs/prompt-caching.md` documents Anthropic as explicit-only today.
- Existing relevant tests include `packages/llm/test/cache-policy.test.ts`, `packages/llm/test/provider/anthropic-messages.test.ts`, `packages/opencode/test/session/llm-request.test.ts`, and `packages/opencode/test/session/llm-native.test.ts`.

## Non-Negotiables

- Default Anthropic caching must use `5m` ephemeral TTL for best cost savings.
- Do not add local disk cache, manual cache invalidation, or prompt pre-warming in the first pass.
- Do not change prompt order or content to improve cache hits.
- Do not send Anthropic `cache_control` to non-Anthropic providers.
- Preserve explicit user/provider cache settings when present.
- Skip automatic caching safely for unsupported Anthropic-compatible routes, small prompts, or invalid breakpoint combinations.
- Treat `1h` TTL as explicit opt-in because it costs more on cache writes.

## Design

### Cache Policy

Extend the shared cache model with Anthropic automatic request-level caching:

```ts
type AnthropicCacheMode = "disabled" | "explicit" | "automatic" | "automatic_and_explicit"

interface CachePlan {
  mode: "disabled" | "automatic" | "implicit" | "explicit" | "automatic_and_explicit"
  duration: "5m" | "1h" | null
  requestCacheControl?: { type: "ephemeral"; ttl?: "1h" }
}
```

Default behavior:

- Anthropic Claude API routes default to `automatic_and_explicit` when supported.
- Use explicit breakpoints for stable tools/system prefixes already identified by OC2.
- Add top-level request `cache_control: { type: "ephemeral" }` when one breakpoint slot remains.
- If all 4 explicit breakpoint slots are already used, keep explicit breakpoints and skip top-level automatic caching.
- If `duration === "1h"`, emit `{ type: "ephemeral", ttl: "1h" }` only when explicitly configured.

### Provider Lowering

- In `packages/llm/src/protocols/anthropic-messages.ts`, emit top-level `cache_control` beside `model`, `max_tokens`, `system`, `tools`, and `messages`.
- Keep block-level `cache_control` lowering unchanged.
- Guard against Anthropic's conflict case: do not add automatic caching if the final eligible block already has explicit `cache_control` with a different TTL.
- In `packages/opencode/src/provider/transform.ts`, add equivalent AI SDK provider option lowering if the SDK supports request-level Anthropic `cacheControl`.

### Configuration

First pass should not require new config. Defaults are:

```json
{
  "prompt_cache": {
    "anthropic": {
      "enabled": true,
      "ttl": "5m"
    }
  }
}
```

If config is added later, place schema work in `packages/core/src/v1/config/provider.ts` and docs in `docs/configuration.md`.

### Docs To Update

- `docs/prompt-caching.md`: change Anthropic from explicit-only to automatic plus explicit breakpoints.
- `docs/providers.md`: update prompt caching compatibility matrix.
- Mention `5m` is default for cost savings and `1h` is opt-in for latency or long gaps.

## Implementation Slices

### PR 1: Shared Capability And Planner

- Update `packages/llm/src/cache/capability.ts` so Anthropic supports `automatic_and_explicit`.
- Extend `CachePlan` / planner logic in `packages/llm/src/cache/planner.ts` to represent top-level Anthropic automatic caching.
- Default Anthropic TTL to `5m`; only set `ttl: "1h"` when configured.
- Add guardrail coverage for automatic slot usage against the 4-breakpoint cap.

Verification:

- `bun test packages/llm/test/cache-policy.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate reviews the diff against this spec, focusing on provider capability correctness, default TTL, and non-Anthropic no-op behavior.

### PR 2: Anthropic Wire Lowering

- Update `packages/llm/src/protocols/anthropic-messages.ts` to emit top-level `cache_control`.
- Preserve existing block-level explicit breakpoint lowering.
- Add tests for:
  - automatic-only body shape
  - automatic plus explicit body shape
  - `1h` opt-in body shape
  - no automatic field when breakpoint slots are exhausted

Verification:

- `bun test packages/llm/test/provider/anthropic-messages.test.ts`
- `bun test packages/llm/test/cache-policy.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate checks the generated Anthropic JSON body for exact field names, TTL behavior, and conflict handling.

### PR 3: Opencode Request Path Parity

- Update `packages/opencode/src/session/llm/request.ts` and `packages/opencode/src/session/llm/native-runtime.ts` only as needed to carry the new plan mode.
- Update `packages/opencode/src/provider/transform.ts` if AI SDK Anthropic request-level cache options are supported.
- Ensure manual `promptCacheKey` scrubbing behavior remains OpenAI-only.
- Ensure non-Anthropic providers still receive no Anthropic cache fields.

Verification:

- `bun test test/session/llm-request.test.ts`
- `bun test test/session/llm-native.test.ts`
- `bun test test/session/llm-provider-parity.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate reviews both native and AI SDK paths for parity and provider field leakage.

### PR 4: Docs And Recorded Validation

- Update `docs/prompt-caching.md` and `docs/providers.md`.
- Add or update recorded Anthropic cache tests in `packages/llm/test/provider/anthropic-messages-cache.recorded.test.ts` to verify `cache_read_input_tokens > 0` on the second matching request when credentials are available.
- Document that `1h` is opt-in and not the cost-saving default.

Verification:

- `bun test packages/llm/test/provider/anthropic-messages-cache.recorded.test.ts`
- `bun test packages/llm/test/provider/anthropic-messages.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate reviews docs for consistency with implemented defaults and Anthropic pricing constraints.

## Future Work

- Configurable `prompt_cache.anthropic.ttl`.
- Explicit pre-warming with `max_tokens: 0`.
- Cache diagnostics surfaced in TUI.
- Adaptive policy that chooses explicit-only when automatic caching would displace higher-value stable breakpoints.

## Open Questions

- Should automatic caching be skipped when all 4 explicit breakpoint slots are valuable? Default recommendation: yes, preserve explicit stable-prefix breakpoints because they are more predictable for cost savings.
- Should `1h` ever be default? Default recommendation: no, keep `5m` because it has lower write cost and refreshes free on cache hits.
