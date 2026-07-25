# Prompt Cache Regression Checker And Self-Healing

## Goal

Build the missing runtime loop that detects prompt-cache regressions, records safe diagnostics, surfaces them in V2/TUI, and applies conservative self-healing actions. Reuse existing cache planning, lowering, telemetry normalization, diagnostics, accounting, and TUI display code instead of rebuilding them.

## Current State

- `packages/llm/src/cache/planner.ts` already plans stable/dynamic cache boundaries and fingerprints.
- `packages/llm/src/cache/telemetry.ts` already normalizes cache read/write/miss classifications.
- `packages/llm/src/cache/diagnostics.ts` already creates safe fingerprint-based unexpected-miss diagnostics.
- `packages/llm/src/cache/state.ts` already has a bounded `CacheExpectationStore`, but it is not wired into opencode runtime paths.
- `packages/opencode/src/session/llm/request.ts` already calls `CachePlanner.planCache(...)`.
- `packages/opencode/src/session/processor.ts` persists `cacheStatus` and retry prompt-cache metadata, but does not maintain multi-turn "should be warm now" expectations.
- `packages/core/src/session/runner/llm.ts` logs post-run `cache.invocation` with diagnostics.
- `packages/opencode/src/session/llm.ts` logs cache invocation at prepare time, not consistently after final provider usage.
- `packages/tui/src/util/context-usage.ts` and related prompt/sidebar components already display cache status and saved dollars.
- V2 session message surfaces appear incomplete: `packages/core/src/session/message.ts` does not carry assistant cache status, and `packages/tui/src/context/sync-v2.tsx` appears to project cost/tokens but not cache classification.
- Docs to update:
  - `docs/prompt-caching.md`
  - `packages/llm/README.md`
  - optionally `packages/opencode/README.md` if user-facing cache regression behavior is exposed there.

## Non-Negotiables

- Do not reimplement cache planning, provider lowering, or provider usage normalization.
- Do not persist prompt content in diagnostics. Store only fingerprints, classifications, provider/model IDs, token counts, and safe corrective labels.
- Do not retry or mutate a user request after a provider response solely to improve cache hit rate.
- Self-healing must be conservative, versioned, reversible, and disabled for providers/models marked unsupported.
- Runtime checker failures must never block user prompts.
- CI checker failures must distinguish `fail`, `skip`, and `inconclusive`.
- Quality guardrails must override cache optimization.

## Runtime Regression Checker

Add a small service around the existing `CacheExpectationStore`.

```ts
type CacheRegressionResult = {
  status: "pass" | "warmup" | "expected_miss" | "unexpected_miss" | "unsupported" | "inconclusive"
  sessionID: string
  providerID: string
  modelID: string
  promptCacheKey?: string
  stablePrefixHash?: string
  cacheStatus: string
  cachedInputTokens?: number
  cacheWriteTokens?: number
  expectedCachedTokens?: number
  diagnostic?: CacheDiagnostic
}
```

Flow:

1. On request prepare, register expectation from the existing cache plan.
2. On provider finish, compare actual `CacheTelemetry` against expectation.
3. Classify:
   - first eligible write as `warmup`
   - retry/compaction/provider change as `expected_miss`
   - missing read after warmup as `unexpected_miss`
   - missing provider telemetry as `inconclusive`
4. Attach diagnostics from `CacheDiagnostics.diagnoseUnexpectedMiss(...)`.
5. Emit a structured log and optional durable session event.

## Durable Visibility

Add a first-class cache regression event or metadata projection.

Minimum event shape:

```ts
type CacheRegressionEvent = {
  type: "cache.regression"
  sessionID: string
  messageID?: string
  partID?: string
  providerID: string
  modelID: string
  classification: "unexpected_miss" | "expected_miss" | "warmup" | "unsupported" | "inconclusive"
  stablePrefixHash?: string
  toolSchemaHash?: string
  cachedInputTokens?: number
  cacheWriteTokens?: number
  expectedCachedTokens?: number
  diagnosticReason?: string
  correctiveAction?: string
}
```

V2 sync must expose enough fields for TUI status and logs without leaking prompt content.

## Self-Healing

First pass self-healing should not rewrite prompts dynamically. It should produce safe plan adjustments for future requests.

Allowed first-pass actions:

- Mark provider/model/cache-key combination as cooling down after repeated telemetry gaps.
- Rotate or repartition cache affinity key only when diagnostics show stable-prefix mismatch.
- Disable explicit cache lowering for a provider/model after repeated provider errors.
- Emit user/developer-facing corrective labels:
  - `volatile_prefix_detected`
  - `tool_schema_fingerprint_changed`
  - `provider_cache_telemetry_missing`
  - `stable_prefix_below_threshold`
  - `expected_warmup`

Do not implement automatic prompt reordering in first pass. That belongs in future work after eval coverage exists.

## Implementation Slices

### PR 1: Wire Runtime Expectation Checking

- Add an opencode/core integration point that registers cache expectations after `CachePlanner.planCache(...)`.
- Reuse `packages/llm/src/cache/state.ts`.
- Compare final provider telemetry against the expectation after each LLM call.
- Ensure retry/compaction expected-miss metadata from `packages/opencode/src/session/retry.ts` remains authoritative.
- Emit post-run `cache.invocation` logs in opencode AI SDK path, matching the core runner behavior.

Verification:

- `cd packages/llm && bun test test/cache/state.test.ts test/cache/diagnostics.test.ts test/cache/logging.test.ts`
- `cd packages/opencode && bun test test/cache/request.test.ts test/cache/conversation-lifecycle.test.ts test/session/llm.test.ts`

Review:

Use a fresh read-only reviewer to verify no prompt content is logged or persisted and no duplicate cache planning logic was added.

### PR 2: Durable Cache Regression Events

- Add a safe cache regression event or metadata projection in the session event path.
- Include only fingerprints, classifications, token counts, provider/model IDs, and corrective labels.
- Update projector/accounting paths only if needed for event persistence.
- Preserve existing `cacheStatus` behavior for legacy v1 parts.

Verification:

- `cd packages/core && bun test test/session-runner.test.ts test/session-projector.test.ts`
- `cd packages/opencode && bun test test/session/processor-effect.test.ts test/session/session.test.ts`

Review:

Fresh read-only review must check schema compatibility, migration impact, and whether old clients ignore the new event safely.

### PR 3: V2 Cache Status Propagation

- Extend V2 assistant/step message shape to include cache classification and saved-cost inputs where appropriate.
- Update `packages/tui/src/context/sync-v2.tsx` to project cache status from step end/regression events.
- Reuse existing TUI rendering in `packages/tui/src/util/context-usage.ts`.
- Do not introduce a second display format.

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/session/processor-effect.test.ts`

Review:

Fresh read-only review must compare v1 and v2 displays and confirm cache status does not disappear during live sync.

### PR 4: Local Cache Regression Checker

- Add a deterministic test/checker that builds fixture requests twice and asserts stable cache fingerprints.
- Use existing planner fingerprints, not raw prompt text snapshots.
- Cover:
  - stable OpenAI cache key
  - stable tool schema ordering
  - stable provider/model config fingerprint
  - dynamic user tail not included in stable prefix
- Return `fail`, `skip`, or `inconclusive` with a machine-readable report.

Verification:

- `cd packages/llm && bun test test/cache-policy.test.ts`
- `cd packages/opencode && bun test test/cache/request.test.ts test/session/llm-request.test.ts`

Review:

Fresh read-only review must verify the checker is deterministic and does not depend on live provider latency or exact token counts.

### PR 5: Conservative Self-Healing Policy

- Add a small policy module that consumes repeated `unexpected_miss` results.
- Implement only future-request actions:
  - temporary explicit-cache disablement for provider errors
  - cache-key partition rotation for stable-prefix mismatch
  - warning/corrective-label emission for volatile prefix or schema churn
- Add counters and cooldowns to avoid oscillation.
- Make the policy off by default or behind config until validated.

Verification:

- `cd packages/llm && bun test test/cache/state.test.ts test/cache/diagnostics.test.ts`
- `cd packages/opencode && bun test test/cache/conversation-lifecycle.test.ts test/cache/cost.test.ts`

Review:

Fresh read-only review must verify no in-flight user request is retried or altered just to improve caching.

### PR 6: Docs And Operator Guidance

- Update `docs/prompt-caching.md` with:
  - runtime regression checker behavior
  - event classifications
  - expected warmup behavior
  - self-healing actions and rollback
- Update `packages/llm/README.md` caching section and remove stale breakpoint wording if confirmed.
- Add a short opencode-facing pointer in `packages/opencode/README.md` only if users can observe the new diagnostics.

Verification:

- `cd packages/llm && bun typecheck`
- `cd packages/opencode && bun typecheck`

Review:

Fresh read-only review must verify docs distinguish already-supported cache planning from the new regression/self-healing loop.

## Future Work

- Live provider-backed nightly cache smoke tests using recorded thresholds.
- Automatic prompt segment reordering.
- Golden eval suite for prompt layout changes.
- Cache-aware request scheduling by prefix affinity.
- Persistent cross-process cache expectation store.
- Dashboard for cache hit ratio by provider/model/agent/prefix hash.

## Open Questions

- Should cache regression events be first-class session events or metadata on step-ended events? Default: first-class event for observability, with TUI projection derived from it.
- Should self-healing be enabled by default? Default: no, start in observe-only mode.
- Should expectation state be process-local only in first pass? Default: yes, because provider caches are TTL-bound and existing `CacheExpectationStore` is bounded in-memory.
- Should CI include live provider calls? Default: no for PR CI; add nightly live smoke tests later.
