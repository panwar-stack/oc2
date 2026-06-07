# Supervisor Recommendation Reliability

## Goal

Improve the supervisor recommendation feature so advice is current, evidence-aware, deterministic, and visible in the app after reload. The first pass focuses on correctness fixes from the audit, with tests landing beside each behavior change.

Implementation must stay incremental: backend recommendation freshness first, deterministic matching second, bounded bookkeeping third, app bootstrap last.

## Current State

- Core supervisor logic lives in `packages/opencode/src/supervisor/index.ts`.
- Supervisor schemas/defaults live in `packages/opencode/src/supervisor/supervisor.ts`.
- Pending recommendations are queued at `packages/opencode/src/supervisor/index.ts:318-323` and flushed at `packages/opencode/src/supervisor/index.ts:326-337`.
- Flush currently checks mode/config/insertion only, then inserts with old derived state at `packages/opencode/src/supervisor/index.ts:340-388`.
- `SupervisorRecommendationInput.recentEvents` exists in `packages/opencode/src/supervisor/supervisor.ts:167-173`, but model input currently omits collected recent events.
- Sensitive path matching is hand-rolled in `packages/opencode/src/supervisor/index.ts:1109-1120`.
- Validation command detection uses prefix matching around `packages/opencode/src/supervisor/index.ts:489`.
- App global sync stores supervisor state from events in `packages/app/src/context/global-sync/event-reducer.ts`, but bootstrap does not fetch supervisor state in `packages/app/src/context/global-sync/bootstrap.ts`.
- Existing focused tests are in `packages/opencode/test/supervisor/*`, `packages/opencode/test/server/httpapi-supervisor.test.ts`, and app sync tests under `packages/app/src/context/global-sync/*`.

## Non-Negotiables

- Do not change supervisor API schemas unless a slice explicitly requires SDK regeneration.
- Do not introduce migrations or persisted data changes in this pass.
- Do not make supervisor failures block session event processing.
- Recommendations must not be inserted when their trigger is stale, resolved, or based on evidence no longer present.
- Keep test commands package-local. Do not run tests from repo root.
- Each implementation slice must receive a fresh read-only review before merge.

## Recommendation Freshness

Pending recommendation insertion must validate against current supervisor state at flush time.

Required behavior:

- Pending insertions must be dropped when current effective config generation changed.
- Pending insertions must be dropped when supervisor mode is no longer `advise`.
- Pending insertions must be dropped when `insert_recommendations` is false.
- Pending insertions must be dropped when current risks/evidence no longer support the recommendation trigger.
- Pending insertion must use current derived state for duplicate keys, final state overlay, and event payloads.
- A successful validation command after a pending `missing_validation` recommendation must prevent the stale recommendation from appearing at idle.

## Model Input

Recommendation generation must include bounded recent event context.

Expected data path:

```ts
buildRecommendationInput(state, recentEvents)
```

Behavior:

- Use already collected `Derived.recentEvents`.
- Preserve existing bounds from `buildRecommendationInput`.
- Do not include raw tool output or secrets.
- Keep `recentEvents` transient; do not add it to persisted `Supervisor.State`.

## Deterministic Matching

Sensitive path matching must behave like configured glob patterns.

Behavior:

- Use existing dependency `minimatch` from `packages/opencode/package.json`.
- Match root-level and nested files for defaults like `**/bun.lock`, `**/package-lock.json`, and `**/*delete*`.
- Normalize path separators before matching.
- Keep user-configured `sensitive_path_globs` semantics glob-based.

Validation command matching must avoid false positives.

Behavior:

- `bun test` must match `bun test`, `bun test path`, and equivalent whitespace-normalized forms.
- `bun testfoo`, `bun test-malicious`, and `npm testx` must not match.
- Keep existing `validation_command_patterns` config shape as string array.

## Error Handling

Supervisor must stay non-blocking, but failures should not be silent.

Behavior:

- Model timeout/provider failure/invalid output must not insert a recommendation.
- Failed recommendation attempts must not update `lastReviewAt` as if a review succeeded.
- Event processing errors must emit bounded diagnostic logging with session ID and event type when available.
- Do not create visible user-facing recommendation messages for internal supervisor failures.

## In-Memory Bounds

Supervisor activity dedupe state must remain bounded.

Behavior:

- Keep `activityKeys` consistent with retained `activities`.
- When activity list is capped, prune dedupe keys for entries no longer retained.
- Confirm recommendation key growth is bounded by `max_recommendations_per_session`, or cap it in the same slice.

## App Bootstrap

The app side panel must be able to show supervisor state for existing sessions after reload.

Behavior:

- Bootstrap supervisor state for the active session by default.
- Avoid fetching supervisor state for every listed session in the first pass.
- Preserve reducer behavior for subsequent `supervisor.state.updated` and `supervisor.recommendation.created` events.
- Keep `packages/app/src/pages/session/session-side-panel.tsx` unchanged unless bootstrap state shape forces a render adjustment.

## Implementation Slices

### PR 1: Fresh Pending Recommendations And Recent Events

- Update `packages/opencode/src/supervisor/index.ts` so `createRecommendation` passes bounded `Derived.recentEvents` into `buildRecommendationInput`.
- Update pending insertion flush to read current derived state before insertion.
- Drop pending recommendations when current state no longer supports the trigger/evidence.
- Add regression tests in `packages/opencode/test/supervisor/supervisor-recommendation.test.ts` for recent events in model input.
- Add regression tests in `packages/opencode/test/supervisor/supervisor-insertion.test.ts` for stale pending recommendation dropped after successful validation.

Verification:

- `cd packages/opencode && bun run typecheck`
- `cd packages/opencode && bun run test -- test/supervisor/supervisor-recommendation.test.ts`
- `cd packages/opencode && bun run test -- test/supervisor/supervisor-insertion.test.ts`

Review:

Before merge, run a fresh read-only review against this slice. The reviewer must confirm pending insertion cannot use stale derived state and that no raw output is added to recommendation input.

### PR 2: Review Retry And Error Visibility

- Move `lastReviewAt` update so failed model generation does not throttle later valid reviews.
- Add bounded logging around swallowed supervisor event processing failures in `packages/opencode/src/supervisor/index.ts`.
- Keep timeout/provider/model-output failures non-blocking and non-visible to users.
- Add tests in `packages/opencode/test/supervisor/supervisor-insertion.test.ts` for timeout/failure followed by immediate successful review.

Verification:

- `cd packages/opencode && bun run typecheck`
- `cd packages/opencode && bun run test -- test/supervisor/supervisor-insertion.test.ts`

Review:

Fresh read-only reviewer must verify failed recommendation attempts do not create messages, do not advance success throttle state, and do not make supervisor event handling blocking.

### PR 3: Deterministic Matching Fixes

- Replace custom sensitive glob conversion in `packages/opencode/src/supervisor/index.ts` with `minimatch`.
- Normalize file paths before sensitive glob checks.
- Replace validation command prefix matching with token/boundary-aware matching.
- Add tests in `packages/opencode/test/supervisor/supervisor-rules.test.ts` for root lockfiles, nested sensitive paths, Windows separators, and delete/encrypt/decrypt filename patterns.
- Add tests for validation false positives like `bun testfoo` and `npm testx`.

Verification:

- `cd packages/opencode && bun run typecheck`
- `cd packages/opencode && bun run test -- test/supervisor/supervisor-rules.test.ts`
- `cd packages/opencode && bun run test -- test/supervisor/supervisor-state.test.ts`

Review:

Fresh read-only reviewer must verify existing configured glob strings still work and validation matching remains compatible with common command arguments.

### PR 4: Bound Supervisor Bookkeeping

- Prune `activityKeys` when `activities` is capped in `packages/opencode/src/supervisor/index.ts`.
- Confirm or enforce bounded `recommendationKeys` growth.
- Add growth regression tests in `packages/opencode/test/supervisor/supervisor-state.test.ts`.

Verification:

- `cd packages/opencode && bun run typecheck`
- `cd packages/opencode && bun run test -- test/supervisor/supervisor-state.test.ts`

Review:

Fresh read-only reviewer must verify dedupe still prevents duplicate activity entries while memory growth is bounded.

### PR 5: App Supervisor State Bootstrap

- Update `packages/app/src/context/global-sync/bootstrap.ts` to fetch supervisor state for the active session during bootstrap.
- Preserve reducer updates in `packages/app/src/context/global-sync/event-reducer.ts`.
- Add or update tests in `packages/app/src/context/global-sync/bootstrap.test.ts`.
- Add a focused assertion that `store.supervisor[sessionID]` is seeded before any supervisor event arrives.

Verification:

- `cd packages/app && bun run typecheck`
- `cd packages/app && bun run test:unit -- src/context/global-sync/bootstrap.test.ts`
- `cd packages/app && bun run test:unit -- src/context/global-sync/event-reducer.test.ts`

Review:

Fresh read-only reviewer must verify bootstrap avoids N+1 supervisor requests and the side panel can render existing state after reload.

## Future Work

- Add web UI component tests for supervisor recommendation rendering in `packages/ui/src/components/message-part.tsx`.
- Add `GET /session/:sessionID/supervisor/report` coverage proving emitted recommendations appear in reports.
- Consider visible supervisor activity for repeated internal model failures if users need diagnostics.
- Consider configurable validation command match modes only if string patterns prove insufficient.

## Open Questions

- Should app bootstrap fetch only the active session's supervisor state? Default: yes, to avoid N+1 requests.
- Should internal supervisor failures appear in user-visible activity? Default: no, log only in this pass.
- Should pending recommendations be invalidated on any newer event? Default: no, invalidate on config/mode/insertion changes and when current risks/evidence no longer support the recommendation.
