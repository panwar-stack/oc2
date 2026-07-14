# Accurate Session Token Accounting

## Goal

Make token, cost, and AI-processing-time accounting accurate and auditable for newly executed V1 and V2 sessions.

The implementation must first normalize provider usage into one disjoint representation, then assign exactly one durable accounting owner to each provider turn. Historical repair, cumulative teammate reporting, and model-level historical statistics remain separate because existing V1/V2 records cannot be safely deduplicated.

## Current State

- Canonical usage is defined in `packages/llm/src/schema/events.ts`, but provider adapters do not consistently preserve its semantics.
- Native V2 persists assistant tokens through `packages/core/src/session/runner/publish-llm-event.ts`, but `packages/core/src/session/projector.ts` does not update `SessionTable` aggregates.
- Native V2 hardcodes cost to zero and does not persist provider execution duration.
- Legacy execution emits both V2 `Step.Ended` and V1 `step-finish` events in `packages/opencode/src/session/processor.ts`; counting both would double usage.
- `SessionV1.Event.Updated` replaces aggregate columns with potentially stale values in `packages/core/src/session/projector.ts`.
- Bedrock, Anthropic compaction, xAI, DeepInfra, DeepSeek, and OpenRouter require provider-specific normalization.
- Failed responses can contain billable usage, but `ProviderErrorEvent` and session failure events cannot preserve it.
- The migration in `packages/core/src/database/migration/20260510033149_session_usage.ts` cannot safely reconstruct multi-step or mixed V1/V2 history.
- `specs/cumulative-ai-usage-including-teammates.md` depends on accurate persisted aggregates but must not be implemented as part of this remediation.

## Non-Negotiables

- Persist five disjoint token categories: fresh input, visible output, reasoning, cache read, and cache write.
- Define consumed tokens as `input + output + reasoning + cache.read + cache.write`.
- Never treat provider `totalTokens` as an additional category.
- Exactly one durable record must own aggregate mutation for each provider turn.
- Native V2 events must be aggregate-owning; legacy mirrored V2 events must be non-owning.
- Old or unmarked V2 events must remain non-owning to avoid replay double-counting.
- Transcript projection and aggregate mutation must occur in the same database transaction.
- Replaying the same aggregate-owning terminal event must produce a zero delta.
- Unknown usage must remain absent. Do not manufacture provider-reported zero usage.
- Partial stream observations must not be billed unless the provider supplies authoritative terminal usage.
- Keep legacy malformed rows readable. Apply nonnegative-integer validation only to new writes.
- Do not backfill historical mixed sessions without deterministic provenance.
- Continue using one `llm.stream(request)` per provider turn.
- Every implementation slice requires a fresh read-only teammate to review its diff against this spec before the slice is marked complete.

## Accounting Model

### Canonical Usage

Provider adapters must produce:

```ts
type CanonicalUsage = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
  providerTotal?: number
  providerMetadata?: ProviderMetadata
}
```

Rules:

- All five persisted categories must be finite, nonnegative integers.
- `input` means fresh, non-cached input.
- `output` excludes reasoning.
- `providerTotal` is retained only for reconciliation and anomaly detection.
- `providerMetadata` must contain usage and billing fields only. Do not persist response bodies, headers, prompts, or credentials.
- If provider totals conflict with the disjoint sum, persist both observations and use the disjoint categories for session aggregation.

### Provider Precedence

| Source | Required behavior |
|---|---|
| AI SDK input | Prefer `inputTokenDetails.noCacheTokens`. If cache writes are recovered only from metadata and may be included in `noCacheTokens`, recompute fresh input as `max(0, inputTokens - cacheRead - cacheWrite)`. |
| AI SDK output | Prefer `outputTokenDetails.textTokens` for visible output. Otherwise use `max(0, outputTokens - reasoningTokens)`. |
| Bedrock | Treat `inputTokens` as fresh input and add cache reads/writes to consumed totals. |
| Anthropic | Sum top-level usage and server-compaction `usage.iterations`. |
| xAI and affected DeepInfra models | Treat completion tokens according to their provider profile; do not assume completion includes reasoning. |
| DeepSeek | Read `prompt_cache_hit_tokens`. |
| OpenRouter | Read cache writes and provider-reported cost from the documented usage details. |
| Provider errors | Preserve usage only when the provider emits authoritative terminal usage. |

Provider-specific behavior must live in named profile or protocol helpers rather than expanding one generic OpenAI-compatible assumption.

### Durable Terminal Accounting

Extend `SessionEvent.Step.Ended` and `SessionEvent.Step.Failed` in `packages/core/src/session/event.ts` with optional accounting data:

```ts
accounting?: {
  mode: "aggregate" | "mirror"
  purpose: "assistant"
  model: ModelV2.Ref
  time: {
    started: DateTime
    completed: DateTime
    duration: number
  }
  usage?: {
    authoritative: CanonicalUsage
    source: "step-finish" | "finish-fallback" | "provider-error"
    finalObservation?: CanonicalUsage
    anomaly?: "final-usage-mismatch"
  }
  pricing?: {
    source: "provider" | "catalog"
    amount: number
    providerAmount?: number
    estimateAmount?: number
    rate?: ModelV2.Cost
  }
}
```

Compatibility rules:

- Keep synchronized event version `2`.
- All new fields must be optional and have no decoder default.
- Missing `accounting` must not mutate session aggregates.
- Legacy dual-write must set `mode: "mirror"`.
- Native V2 must set `mode: "aggregate"`.
- Existing top-level token and cost fields remain compatibility projections derived from `accounting`.
- Idempotency must use the existing assistant message and terminal identity; do not invent a retry-attempt identifier until retries have durable identities.

### Terminal Semantics

- `step-finish` usage is authoritative.
- Final cumulative usage must not be added after per-step usage.
- `finish` usage is a fallback only when no `step-finish` exists and the publisher has proven one-step semantics.
- If `step-finish` and `finish` disagree, account the step usage and retain the final observation as an anomaly.
- A failed or interrupted turn contributes tokens and cost only when authoritative terminal usage exists.
- Duration measures provider execution from dispatch to terminal success, failure, interruption, or EOF. It excludes local tool execution.
- Reject a second terminal, content after terminal, and conflicting `Ended`/`Failed` transitions.
- A completed provider turn remains completed if later local tool execution fails.

### Pricing

Add a shared calculator in `packages/core/src/session/accounting.ts`.

- Preserve current legacy base-price behavior before enabling V2 aggregation.
- Use the selected model variant, mode, and context tier rather than silently applying base-model rates.
- Price reasoning at the output rate until catalogs expose a separate reasoning rate.
- Prefer documented, unit-normalized provider cost when present.
- Otherwise calculate an estimate from the selected catalog rate.
- Persist provider cost, catalog estimate, and selected rate when available.
- Make `Session.getUsage` in `packages/opencode/src/session/session.ts` delegate to the shared calculator.

## Deterministic Checks

The completed implementation must prove:

- Native and AI SDK execution of identical raw usage persist the same five-category tuple.
- Two provider steps add exactly two step usages.
- Final cumulative usage adds nothing after accounted step usage.
- Replaying one aggregate-owning terminal event changes aggregates once.
- A mirrored V2 event plus its V1 `step-finish` changes aggregates once.
- Legacy part replacement and removal continue subtracting their previous contribution.
- Title, summary, permission, archive, and touch updates cannot alter aggregate columns.
- New writes reject negative, fractional, and non-finite token values.
- Existing malformed rows remain readable.
- Reasoning-only and cache-only turns are eligible as the current context turn.
- Overflow calculations include all five categories.
- ACP prompt usage includes fresh input, cache read, and cache write exactly once.

## Implementation Slices

### PR 1: Canonical Usage And AI SDK Lowering

- Add one production canonicalization path in `packages/llm/src/schema/events.ts` and `packages/llm/src/protocols/shared.ts`.
- Correct `packages/opencode/src/session/llm/ai-sdk.ts` to use `noCacheTokens`, `textTokens`, reasoning, cache details, and usage metadata.
- Make `packages/opencode/test/lib/provider-parity.ts` assert production normalization rather than reproducing its arithmetic.
- Add write validation for finite, nonnegative integer categories while preserving permissive legacy decoding.
- Extend provider error events with optional authoritative usage.

Verification from `packages/llm`:

- `bun test test/schema.test.ts`
- `bun typecheck`

Verification from `packages/opencode`:

- `bun test test/session/llm.test.ts test/server/negative-tokens-regression.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must compare the diff against the canonical tuple, precedence table, and legacy-read compatibility rules before this slice is checked off.

### PR 2: Bedrock And Anthropic Accuracy

- Correct Bedrock input and cache semantics in `packages/llm/src/protocols/bedrock-converse.ts`.
- Sum Anthropic server-compaction iterations in `packages/llm/src/protocols/anthropic-messages.ts`.
- Preserve authoritative Anthropic usage when a later provider error occurs.
- Ensure Bedrock cannot emit contradictory success and error terminals.
- Add fixtures with nonzero cache reads, cache writes, compaction iterations, and failure usage.

Verification from `packages/llm`:

- `bun test test/provider/bedrock-converse.test.ts test/provider/anthropic-messages.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must validate formulas against provider SDK semantics and confirm every stream emits one terminal outcome.

### PR 3: OpenAI-Compatible Provider Profiles

- Replace generic usage assumptions in `packages/llm/src/protocols/openai-chat.ts` with explicit provider-profile normalization.
- Cover xAI and DeepInfra excluded-reasoning semantics.
- Parse DeepSeek cache hits and OpenRouter cache writes.
- Preserve OpenRouter provider cost without treating it as a catalog estimate.
- Emit usage from terminal usage-only chunks even when `finish_reason` is absent.
- Preserve usage from OpenAI `response.failed`.

Verification from `packages/llm`:

- `bun test test/provider/openai-chat.test.ts test/provider/openai-responses.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must check each provider fixture independently and reject any fallback that changes standard OpenAI behavior.

### PR 4: Shared Pricing And Catalog Selection

- Add `packages/core/src/session/accounting.ts`.
- Preserve variant and mode-specific cost data through `packages/core/src/model.ts`, `packages/core/src/models-dev.ts`, and `packages/core/src/plugin/models-dev.ts`.
- Implement context-tier selection and reasoning-at-output-rate behavior.
- Make legacy `Session.getUsage` use the shared calculator.
- Do not enable native V2 aggregate ownership until legacy pricing parity passes.

Verification from `packages/core`:

- `bun test test/model.test.ts test/models.test.ts test/config/provider.test.ts test/catalog.test.ts`
- `bun typecheck`

Verification from `packages/opencode`:

- `bun test test/session/compaction.test.ts`
- `bun typecheck`

Generated surface verification from the repository root:

- `./packages/sdk/js/script/build.ts`
- `bun run check:generated`

Verification from `packages/sdk/js`:

- `bun typecheck`

Review:

A fresh read-only teammate must compare legacy and shared-calculator results for base, tiered, cached, reasoning, and variant-priced cases.

### PR 5: Aggregate Ownership And Projector Safety

- Add optional accounting ownership to `SessionEvent.Step.Ended` and `Step.Failed`.
- Mark legacy dual-written events as `mirror` in `packages/opencode/src/session/processor.ts`.
- Apply aggregate deltas only for `aggregate` events in `packages/core/src/session/projector.ts`.
- Calculate the delta against the existing assistant terminal state inside the projection transaction.
- Prevent `SessionV1.Event.Updated` from writing cost, token, or processing-time columns.
- Reject ownership changes for existing V1 parts.
- Add strict write validation to the public part PATCH path without tightening legacy read schemas.

Verification from `packages/core`:

- `bun test test/session-projector.test.ts`
- `bun typecheck`

Verification from `packages/opencode`:

- `bun test test/session/session.test.ts test/session/processor-effect.test.ts`
- `bun test test/server/httpapi-public-openapi.test.ts`
- `bun typecheck`

Generated surface verification from the repository root:

- `./packages/sdk/js/script/build.ts`
- `bun run check:generated`

Verification from `packages/sdk/js`:

- `bun typecheck`

Review:

A fresh read-only teammate must adversarially test replay, mirror-plus-part double-counting, conflicting terminals, replacement/removal, and stale metadata interleavings.

### PR 6: Native V2 Terminal Accounting

- Update `packages/core/src/session/runner/publish-llm-event.ts` and `packages/core/src/session/runner/llm.ts` to emit one aggregate-owning terminal.
- Persist canonical usage, selected pricing, and provider execution duration.
- Use `step-finish` as authoritative and `finish` only as the defined fallback.
- Settle interrupted, failed, and missing-terminal assistants without charging partial observations.
- Keep transcript and aggregate projection atomic.
- Preserve pre-assistant overflow recovery.

Verification from `packages/core`:

- `bun test test/session-runner.test.ts test/session-projector.test.ts test/session-runner-recorded.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must inspect every success, failure, interruption, EOF, and tool-loop path for exactly one durable terminal.

### PR 7: V1 Failed Usage And Retry Bounds

- Persist authoritative provider-error usage as a V1 accounting part before retrying or returning failure.
- Never add cumulative final usage after accounted step usage.
- Bound retry attempts and elapsed retry time.
- Preserve one accounting entry for each provider-billed failed attempt.
- Add deterministic tests for repeated retryable errors, success after retry, and terminal failure.

Verification from `packages/opencode`:

- `bun test test/session/session.test.ts test/session/processor-effect.test.ts test/session/retry.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must confirm retries neither lose billed usage nor reuse cumulative usage across attempts.

### PR 8: Context And Protocol Consumers

- Fix `packages/opencode/src/session/overflow.ts` to use the five-category sum and reject invalid provider totals.
- Update the TUI context selectors to accept any turn with a positive consumed total.
- Centralize ACP prompt usage as `input + cache.read + cache.write`.
- Do not add output or reasoning to ACP `used` without an ACP protocol change.
- Add reasoning-only, cache-only, cache-write, and zero-visible-output cases.

Verification from `packages/opencode`:

- `bun test test/session/compaction.test.ts test/acp/usage.test.ts test/acp/service-session.test.ts`
- `bun typecheck`

Verification from `packages/tui`:

- `bun test`
- `bun typecheck`

Review:

A fresh read-only teammate must compare each consumer's formula with its protocol-specific meaning rather than applying one generic total everywhere.

### PR 9: Live Session Aggregate Presentation

- Make the app use persisted `Session.Info` aggregates instead of summing its paginated message cache.
- Refetch session aggregates after owning V2 terminals and V1 part update/removal events.
- Use a generation guard so stale responses cannot replace newer totals.
- Refresh TUI cost and processing time from the same authoritative session aggregate.
- Add a session exceeding the initial 80-message hydration limit.
- Update `specs/cumulative-ai-usage-including-teammates.md` and `specs/cumulative-ai-processing-time.md` to name the corrected aggregate prerequisite and current file paths; do not implement their broader API scope here.

Verification from `packages/app`:

- `bun test`
- `bun typecheck`
- `bun run build`

Verification from `packages/tui`:

- `bun test`
- `bun typecheck`

Review:

A fresh read-only teammate must verify initial load, pagination, event-driven refresh, event removal, and stale-response ordering on desktop and mobile layouts.

## Future Work

- Do not modify the existing historical migration to combine V1 messages, V1 parts, and V2 messages.
- Design a dry-run reconciliation tool only after legacy-only, pure-V2, and mixed-session provenance can be identified deterministically.
- Repair per-model CLI statistics only after each accounting record has durable model and ownership provenance.
- Implement cumulative lead-and-teammate usage through `specs/cumulative-ai-usage-including-teammates.md` after session aggregates are trusted.
- Account for auxiliary model calls such as title generation, compaction, and private branch/judge calls using explicit accounting purposes.
- Treat cross-process provider-request leasing and idempotency as separate distributed-execution work.
- Correct team-report wall-runtime labeling separately from token-accounting remediation.

## Open Questions

- **Retry bound:** Default to eight attempts or fifteen minutes, whichever occurs first. Should provider `Retry-After` be allowed to exceed the elapsed-time cap?
- **Provider cost precedence:** Default to documented, unit-normalized provider cost while retaining the catalog estimate. Should UI surfaces display provider cost or the stable catalog estimate when both exist?
- **Billing metadata exposure:** Default to persisting whitelisted usage metadata for reconciliation without exposing arbitrary raw provider payloads through public APIs.
- **Historical repair:** Default to no automatic repair. Is accepting known historical undercount preferable to introducing a user-invoked reconciliation command with explicit ambiguity warnings?
