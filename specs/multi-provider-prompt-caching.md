# Multi-Provider Prompt Caching Audit And Strengthening

## Goal

Strengthen prompt caching across every model invocation by adding one provider-neutral cache planning, validation, telemetry, classification, logging, and diagnostics layer. The work must preserve existing request paths and provider adapters while making cache behavior verifiable for OpenAI, Anthropic, Moonshot AI/Kimi, and DeepSeek.

The implementation strategy is incremental: first add shared cache capabilities and fingerprints without changing request behavior, then route provider-specific request construction through that shared plan, then add expectation state, warnings, costs, docs, and full test coverage.

## Current State

- `packages/llm/src/cache-policy.ts` already provides a protocol-neutral inline `CacheHint` placement pass for `anthropic-messages` and `bedrock-converse`, but it only handles hint placement.
- `packages/llm/src/schema/options.ts` defines `CacheHint` and `CachePolicy`, but not provider capabilities, fingerprints, expectation state, or normalized cache telemetry.
- `packages/llm/src/protocols/anthropic-messages.ts` supports Anthropic `cache_control` and parses `cache_creation_input_tokens` / `cache_read_input_tokens`.
- `packages/llm/src/protocols/openai-responses.ts` supports `prompt_cache_key` and parses `cached_tokens` / `cache_write_tokens`.
- Legacy opencode V1 request flow runs through `packages/opencode/src/session/prompt.ts`, `src/session/processor.ts`, `src/session/llm.ts`, and `src/session/llm/request.ts`.
- V1 cache mutation lives in `packages/opencode/src/provider/transform.ts`; `applyCaching()` marks the first two system messages and last two non-system messages, mostly for Anthropic-like models.
- V2/core request flow in `packages/core/src/session/runner/llm.ts` already computes a tool definition digest and sets cache hints, but it does not share a full cache audit layer with V1.
- Usage normalization in `packages/opencode/src/session/llm/ai-sdk.ts` already recovers some cache read/write data for Anthropic, DeepSeek, OpenRouter, xAI, and generic AI SDK responses.
- Session cost accounting in `packages/opencode/src/session/session.ts` already distinguishes input, output, cache read, and cache write costs when pricing metadata exists.
- Provider/model metadata in `packages/opencode/src/provider/provider.ts` includes model costs and generic capabilities, but not a centralized prompt-cache capability registry.
- Tests already cover selected request shaping and usage accounting in `test/provider/transform.test.ts`, `test/session/llm.test.ts`, `test/session/llm-provider-parity.test.ts`, `test/session/session.test.ts`, `test/session/compaction.test.ts`, ACP, stats, and OpenAPI tests.
- No dedicated prompt caching documentation was found under `docs/` or `packages/opencode`.

## Gap Analysis

| Requirement Area | Status | Repo-Grounded Gap |
|---|---:|---|
| Initial inspection coverage | Complete for spec | Pipeline, providers, telemetry, tests, pricing, docs, compaction, retry, and logging were inspected. |
| Provider-neutral cache architecture | Partially complete | `packages/llm/src/cache-policy.ts` handles hint placement only; missing capabilities, fingerprints, state, classification, diagnostics, warnings, and cost integration. |
| Capability registry | Missing | Current provider logic infers behavior from provider/model IDs in `src/provider/transform.ts` and metadata in `src/provider/provider.ts`. |
| Stable/dynamic prompt boundaries | Partially complete | V2 has more explicit boundaries; V1 uses heuristic message positions and may cache volatile system context from `src/session/system.ts`. |
| Canonical serialization | Partially complete | V2 has `canonicalizeObjectKeys()` for tool digests; no full canonical request serialization across messages, tools, schemas, images, files, and provider blocks. |
| Prefix/component fingerprints | Partially complete | V2 logs tool digest only; no complete rendered prefix fingerprint or component fingerprint set. |
| Cache keys and routing | Partially complete | OpenAI currently uses session-based `promptCacheKey` in `src/provider/transform.ts`; no prefix-key mapping, compatibility guard, or traffic partitioning. |
| OpenAI behavior | Partially complete | Request fields and usage parsing exist, but explicit mode, breakpoint validation, capability-driven thresholds, cache key mapping, and diagnostics are missing. |
| Anthropic behavior | Partially complete | `cache_control` and usage fields exist, but capability-driven placement, duration validation, threshold handling, state, and warnings are missing. |
| Moonshot AI/Kimi behavior | Missing / telemetry blocked | Kimi-specific transforms exist, but no cache policy or telemetry normalization. Missing provider telemetry must classify as unverified, not failed. |
| DeepSeek behavior | Partially complete | `prompt_cache_hit_tokens` parsing exists; warmup, miss evidence, expectation state, and best-effort classification are missing. |
| Provider-specific thresholds | Missing | No central threshold model. Do not treat 1,024 tokens as universal. |
| Cache expectation state | Missing | No bounded, concurrency-safe per-prefix state. |
| Turn-level validation | Partially complete | Usage tokens exist, but no every-invocation cache telemetry object with request IDs, fingerprints, eligibility, expectation, classification, and corrective action. |
| Classification and miss evaluation | Missing | Zero cache reads are not evaluated against warmup, retention, prefix changes, telemetry availability, or provider guarantees. |
| Guardrails | Missing | No preflight validation for field leakage, unsupported options, invalid breakpoints, unstable prefixes, or incompatible cache keys. |
| Retry/fallback behavior | Partially complete | Retry flow exists in `src/session/retry.ts` and `src/session/processor.ts`, but cache-affecting retry changes are not tracked. |
| Conversation compaction/session restore | Partially complete | Compaction exists in `src/session/compaction.ts`; cache invalidation and expected-miss marking are missing. |
| User notification | Missing | No prompt-cache-specific warning event or user-facing notification. |
| Structured logging | Partially complete | Stream logs exist in V1/V2; cache policy, fingerprints, classification, and safe diagnostics are missing. |
| Diagnostics | Missing | No component-level diffing for unexpected misses. |
| Cost accounting | Partially complete | Existing cache read/write pricing exists; missing normalized cache cost impact and provider-aware unavailable handling. |
| Tests | Partially complete | Strong usage/request tests exist; missing capability, fingerprint, state, guardrail, classification, warnings, docs, and cross-provider matrix tests. |
| Documentation | Missing | Need new prompt caching doc and provider compatibility table. |

## Non-Negotiables

- Do not rewrite working provider functionality without a specific cache correctness or observability reason.
- Unknown models must use conservative behavior: no explicit cache fields, no assumed threshold, no false failure warning.
- Missing telemetry must remain `null` or an explicit missing value, never `0`.
- Provider-specific fields must not leak across providers.
- Full prompts, source code, tool arguments, files, images, credentials, and personal data must not be logged.
- A single miss must not create a user warning unless provider telemetry and expectation state prove an unexpected miss.
- Keep V1 and V2 behavior compatible except for improved caching controls, validation, telemetry, diagnostics, and warnings.

## Design

### Package Placement

- Add provider-neutral cache modules under `packages/llm/src/cache/`.
- Keep provider-specific lowering in existing protocol/provider files:
  - `packages/llm/src/protocols/openai-responses.ts`
  - `packages/llm/src/protocols/anthropic-messages.ts`
  - `packages/llm/src/protocols/openai-chat.ts`
  - `packages/opencode/src/provider/transform.ts` for legacy AI SDK path until V1 fully migrates.
- Integrate cache planning in:
  - `packages/llm/src/cache-policy.ts`
  - `packages/core/src/session/runner/llm.ts`
  - `packages/opencode/src/session/llm.ts`
  - `packages/opencode/src/session/llm/request.ts`

### Core Types

```ts
export type CacheClassification =
  | "cache_hit"
  | "cache_write"
  | "expected_cache_miss"
  | "unexpected_cache_miss"
  | "cache_unsupported"
  | "cache_telemetry_unavailable"
  | "cache_configuration_error"
  | "provider_error"

export interface CacheCapabilities {
  version: number
  provider: string
  modelPattern: string
  status: "known" | "unknown"
  promptCaching: "unsupported" | "automatic" | "explicit" | "automatic_and_explicit"
  supportsCacheKey: boolean
  supportsBreakpoints: boolean
  supportsDuration: boolean
  minimumPrefixTokens: number | null
  maximumBreakpoints: number | null
  reportsCacheReadTokens: boolean
  reportsCacheWriteTokens: boolean
  reportsCacheMissTokens: boolean
  telemetryUnavailable: boolean
  cacheWriteHasAdditionalCost: boolean
  cacheReadReceivesDiscount: boolean
  warmup: { policy: "none" | "first_request" | "multiple_requests" | "best_effort"; requests: number }
  retention: { policy: "fixed" | "probable" | "unknown"; seconds: number | null }
  supportedModes: ReadonlyArray<"automatic" | "implicit" | "explicit">
  supportedBreakpointContentTypes: ReadonlyArray<string>
  supportedDurations: ReadonlyArray<"5m" | "1h">
  requestFields: ReadonlyArray<string>
  responseUsageFields: ReadonlyArray<string>
  routingKeyTrafficLimit: number | null
  conclusiveVerification: boolean
}

export interface CachePlan {
  provider: string
  model: string
  mode: "disabled" | "automatic" | "implicit" | "explicit"
  cacheKey: string | null
  trafficPartition: string | null
  stablePrefixFingerprint: string
  componentFingerprints: Record<string, string>
  prefixTokenCount: number | null
  minimumPrefixTokens: number | null
  eligible: boolean
  breakpoints: ReadonlyArray<{ component: string; contentType: string; index: number }>
  duration: "5m" | "1h" | null
}

export interface CacheTelemetry {
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  cacheMissTokens: number | null
  uncachedInputTokens: number | null
  metricsAvailable: boolean
  eligible: boolean
  expected: boolean
  verified: boolean
  classification: CacheClassification
  providerRawUsageFieldNames: ReadonlyArray<string>
  warmupRequestNumber: number | null
  estimatedCacheCost: number | null
  estimatedUncachedCost: number | null
  estimatedSavings: number | null
}
```

### Provider Behavior

| Provider | First Pass Behavior |
|---|---|
| OpenAI | Use capability-driven `prompt_cache_key` only for known supported models. Replace session-only keys with stable-prefix-derived keys plus optional traffic partition. Parse `cached_tokens` and `cache_write_tokens`. |
| Anthropic | Use valid `cache_control` on supported system, tool, and message blocks. Enforce breakpoint limit and duration support. Parse `cache_creation_input_tokens` and `cache_read_input_tokens`. |
| Moonshot AI/Kimi | Treat as provider-managed automatic caching. Send no OpenAI or Anthropic cache fields. Classify missing cache telemetry as `cache_telemetry_unavailable`, not failure. |
| DeepSeek | Treat as provider-managed automatic prefix caching. Parse `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. Use warmup and best-effort rules before classifying misses. |

### Documentation Updates

- Add `docs/prompt-caching.md`.
- Update `docs/providers.md` with a prompt caching compatibility table.
- Update `packages/opencode/src/session/llm/AGENTS.md` with LLM boundary ownership for cache planning and telemetry.
- Add troubleshooting notes for unavailable telemetry, expected misses, provider field leakage, and cost impact.

## Implementation Slices

### PR 1: Capability Registry And Shared Types

- Add `packages/llm/src/cache/capability.ts` with versioned capability records for OpenAI, Anthropic, Moonshot AI/Kimi, DeepSeek, and unknown models.
- Add shared `CacheClassification`, `CachePlan`, `CacheTelemetry`, and diagnostic type definitions.
- Add conservative unknown-model behavior.
- Do not change provider request construction yet.

Verification:

- `bun test --timeout 30000 test/cache/capability.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer compares the diff against PR 1 and verifies no request behavior changed.

### PR 2: Canonical Serialization And Fingerprints

- Add deterministic canonical serialization for cacheable messages, tools, schemas, images, file refs, provider config, model config, and breakpoints.
- Add complete stable-prefix fingerprint and component fingerprints.
- Include serialization version in every fingerprint input.
- Do not mutate caller-owned objects.
- Keep semantically meaningful ordering intact.

Verification:

- `bun test --timeout 30000 test/cache/canonical.test.ts test/cache/fingerprint.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer checks determinism, no prompt-content logging, and no semantic reordering.

### PR 3: Stable/Dynamic Boundary Planning

- Add cache planner that separates stable prefix from dynamic turn content.
- Integrate with `packages/llm/src/cache-policy.ts`.
- Wire V2/core runner in `packages/core/src/session/runner/llm.ts`.
- Add V1 adapter points in `packages/opencode/src/session/llm/request.ts` without changing provider-specific fields yet.
- Mark repository context with an explicit version/fingerprint when it is treated as stable.

Verification:

- `bun test --timeout 30000 test/cache/planner.test.ts`
- `bun test --timeout 30000 test/session/llm.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer verifies user messages, timestamps, request IDs, retries, and tool results cannot enter stable sections accidentally.

### PR 4: Provider-Specific Request Lowering

- Move provider-specific cache field decisions behind the shared `CachePlan`.
- OpenAI: generate stable `prompt_cache_key`, validate incompatible reuse, and avoid unsupported models.
- Anthropic: place `cache_control` only on supported content blocks, enforce breakpoint limit and duration.
- Moonshot AI/Kimi: ensure no OpenAI or Anthropic cache fields are sent.
- DeepSeek: ensure no explicit unsupported cache fields are sent.
- Preserve existing AI SDK and native request behavior where compatible.

Verification:

- `bun test --timeout 30000 test/provider/transform.test.ts`
- `bun test --timeout 30000 test/session/llm-native.test.ts test/session/llm-native-recorded.test.ts`
- `bun test --timeout 30000 test/cache/provider-lowering.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer checks provider field isolation and confirms no provider-specific rule moved into shared classification logic.

### PR 5: Telemetry Normalization And Classification

- Normalize every response into `CacheTelemetry`.
- Preserve missing fields as `null`.
- Calculate uncached input tokens only from reported fields.
- Add classification for hit, write, expected miss, unexpected miss, unsupported, telemetry unavailable, configuration error, and provider error.
- Treat Moonshot telemetry absence as unverified, not failed.
- Treat DeepSeek misses as unexpected only after warmup and strong evidence.

Verification:

- `bun test --timeout 30000 test/session/llm.test.ts`
- `bun test --timeout 30000 test/session/llm-provider-parity.test.ts`
- `bun test --timeout 30000 test/cache/classification.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer verifies zero versus missing semantics and classification edge cases.

### PR 6: Cache Expectation State And Guardrails

- Add bounded, concurrency-safe expectation state keyed by provider, model, prefix fingerprint, and traffic partition.
- Track first/last observed time, eligible request count, reads, writes, misses, telemetry gaps, warmup, expiration, warnings, and configuration fingerprints.
- Add pre-request guardrails for unsupported fields, invalid duration, breakpoint overflow, field leakage, incompatible cache key reuse, unstable prefix changes, and retry prefix changes.
- Fail before sending only for definitely invalid configurations; warn and continue when safe.

Verification:

- `bun test --timeout 30000 test/cache/state.test.ts test/cache/guardrails.test.ts`
- `bun test --timeout 30000 test/session/compaction.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer stress-checks state isolation, eviction, concurrency, and false-positive warning suppression.

### PR 7: Logging, Diagnostics, And User Notifications

- Emit one structured cache event for every model invocation.
- Include fingerprints, counts, classification, provider/model, request/turn/session IDs, retry attempt, breakpoints, cache key, duration, and corrective action.
- Add component-level diagnostics for unexpected misses without exposing prompt content.
- Add user notifications only for verified unexpected misses, invalid cache configuration, and provider failures.
- Suppress notifications for first writes, warmup, below-threshold prompts, compaction, expected expiration, best-effort single misses, and unavailable telemetry.

Verification:

- `bun test --timeout 30000 test/cache/logging.test.ts test/cache/warnings.test.ts test/cache/diagnostics.test.ts`
- `bun test --timeout 30000 test/acp/usage.test.ts test/acp/service-session.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer verifies no sensitive data is logged and user messages clearly distinguish failure, configuration error, provider error, and unverifiable telemetry.

### PR 8: Cost Accounting Integration

- Extend existing cache cost accounting in `packages/opencode/src/session/session.ts`.
- Use provider/model-specific cache read/write prices from existing model metadata.
- Report unavailable cost impact when pricing or telemetry is missing.
- Do not apply pricing from one provider to another.
- Include unexpected-miss cost impact when calculable.

Verification:

- `bun test --timeout 30000 test/session/session.test.ts test/session/compaction.test.ts`
- `bun test --timeout 30000 test/provider/provider.test.ts`
- `bun test --timeout 30000 test/cache/cost.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer verifies pricing isolation and unavailable-cost behavior.

### PR 9: Conversation Lifecycle, Retry, And Restore

- Record cache-affecting retry changes in `packages/opencode/src/session/retry.ts` and `src/session/processor.ts`.
- Mark compaction and summarization prefix changes as expected misses.
- Compare resumed session provider, model, tools, schemas, prompt version, repository context version, and stable prefix fingerprint.
- Preserve stable prefix across retries unless fallback intentionally changes provider/model/request format.

Verification:

- `bun test --timeout 30000 test/cache/conversation-lifecycle.test.ts`
- `bun test --timeout 30000 test/session/compaction.test.ts`
- `bun test --timeout 30000 test/session/llm.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer verifies no retry metadata enters the stable prefix and restore comparisons do not expose content.

### PR 10: Documentation And Full Matrix Tests

- Add `docs/prompt-caching.md`.
- Update `docs/providers.md`.
- Add provider matrix tests for OpenAI, Anthropic, Moonshot AI/Kimi, DeepSeek, unknown models, and cross-provider field leakage.
- Update existing provider/request/usage tests rather than duplicating coverage.
- Run the full relevant suite.

Verification:

- `bun test --timeout 30000 test/cache/*.test.ts`
- `bun test --timeout 30000 test/provider/transform.test.ts`
- `bun test --timeout 30000 test/session/llm.test.ts test/session/llm-provider-parity.test.ts`
- `bun test --timeout 30000 test/session/session.test.ts test/session/compaction.test.ts`
- `bun test --timeout 30000 test/acp/usage.test.ts test/acp/service-session.test.ts`
- `bun test --timeout 30000 test/cli/cmd/stats.test.ts test/server/httpapi-public-openapi.test.ts`
- `bun typecheck`

Review:

Fresh read-only reviewer verifies documentation matches implemented behavior, especially provider limitations and unsupported fields.

## Future Work

- Persist cache expectation state across process restarts only if live-session state and durable sanitized events are insufficient.
- Extend the same capability registry to Bedrock, OpenRouter, Vertex Anthropic, Alibaba, Copilot, xAI, and Gateway after the four required providers are complete.
- Add recorded provider integration tests where credentials and stable fixtures are available.

## Open Questions

- Should cache expectation state be persisted beyond sanitized invocation events? Default: keep bounded in-memory state first and persist only sanitized telemetry needed for resumed-session comparison.
- Which exact provider docs should be treated as authoritative for Moonshot AI/Kimi and DeepSeek thresholds/retention? Default: encode only documented known values; use `null` and conservative behavior otherwise.
- Should V1 fully migrate to `@oc2-ai/llm` request construction now? Default: wrap V1 with the shared cache planner first, then migrate separately if needed.
