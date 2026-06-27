# Fugu Inline Status Updates

## Goal

Show live Fugu orchestration status inline in the active session conversation while `fugu/fugu` is running.

Default implementation: add a session-scoped live-only status event, emit it from the Fugu runtime as branches, judge, and synthesizer transition, then render a compact status row in app and TUI session views. Do not persist branch/judge status as durable history in the first pass.

## Current State

- `packages/opencode/src/session/llm/fugu.ts` runs branches concurrently, collects branch streams internally, optionally runs a judge, then returns only the synthesizer `LLMEvent` stream.
- `packages/opencode/src/session/llm/fugu.ts` logs branch, judge, and synthesizer output, but emits no structured UI/session status event.
- `packages/core/src/config/fugu.ts` defines the current `fugu.branches`, `fugu.judge`, and `fugu.synthesizer` config shape.
- `packages/core/src/session/event.ts` already separates durable events from live-only stream fragments. Live-only deltas omit `sync`.
- `packages/opencode/src/event-v2-bridge.ts` publishes all `EventV2` events to the legacy SSE bus.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` streams events to app/TUI clients.
- `packages/app/src/context/global-sync/event-reducer.ts` reduces known session events into app state, but has no Fugu status cache.
- `packages/app/src/pages/session/message-timeline.data.ts` builds conversation rows from messages, parts, session status, and active-turn state.
- `packages/app/src/pages/session/message-timeline.tsx` renders active conversation rows and already has a `Thinking` row for busy sessions.
- `packages/tui/src/context/sync.tsx` listens to the same event stream and stores session-scoped live state such as `session_status`.
- `packages/tui/src/routes/session/index.tsx` renders the live session conversation from synced messages and parts.

## Non-Negotiables

- Status must be live-only in the first pass. Do not add database tables, migrations, durable message projection, or replay semantics.
- Status must blend into the active turn, near the existing thinking/progress UI, not as a toast, header-only indicator, or side panel.
- Status must not expose branch output, judge output, prompts, provider keys, stack traces, or model names by default.
- Branches should be identified as `Branch 1`, `Branch 2`, etc. Preserve config order.
- The Fugu runtime behavior must not change except for status publication. Do not add new branch timeout policy, tool policy, or retry behavior.
- `timed out` may be displayed only when an existing provider/runtime failure can be classified as timeout-like. Other failures display as `failed`.
- Normal non-`fugu` sessions must not allocate or render Fugu status state.
- Generated SDK types must be regenerated if the event schema changes public SDK event types.

## Event Surface

Add a live-only event under `packages/core/src/session/event.ts`:

```ts
type FuguTargetStatus =
  | "pending"
  | "working"
  | "complete"
  | "failed"
  | "timed_out"
  | "skipped"

type FuguStatusEvent = {
  sessionID: string
  timestamp: number
  runID: string
  phase: "branching" | "judging" | "synthesizing" | "complete" | "failed"
  branches: Array<{
    index: number
    status: FuguTargetStatus
  }>
  judge?: {
    status: FuguTargetStatus
  }
  synthesizer: {
    status: FuguTargetStatus
  }
}
```

Event name:

```ts
"session.next.fugu.status"
```

Rules:

- Define it without `sync` so it is live-only, like `session.next.text.delta`.
- Include it in the session all-event union used by live reducers.
- Do not include branch text, errors, model IDs, variants, or judge guidance.
- Use `runID` to ignore stale status from an older Fugu turn in the same session.
- Emit a final `complete` or `failed` event so clients can clear the live row deterministically.

## Runtime Behavior

Update `packages/opencode/src/session/llm.ts` and `packages/opencode/src/session/llm/fugu.ts`:

- Pass a narrow status publisher into `LLMFugu.run(...)`.
- Emit initial status after Fugu config validation succeeds and before branches start.
- Emit each branch transition from `pending` to `working`, then `complete`, `failed`, or `timed_out`.
- Emit judge `working`, `complete`, `failed`, or `skipped` when `config.fugu.judge` is absent.
- Emit synthesizer `working` when synthesis begins.
- Emit final `complete` when the synthesizer emits `finish`.
- Emit final `failed` when the synthesizer emits `provider-error` or the stream fails.
- Preserve current `LLMEvent` streaming behavior so downstream message persistence still sees only synthesizer output.

Example display text:

```text
Fugu · 2/4 branches complete · judge working

Branch 1 · idle
Branch 2 · working
Branch 3 · timed out
Judge · working
```

Recommended status wording:

- `pending` renders as `idle`.
- `complete` renders as `complete`.
- `failed` renders as `failed`.
- `timed_out` renders as `timed out`.
- `skipped` renders as `skipped`.

## App UI

Update app live state and timeline rendering:

- Add `fugu_status: Record<string, FuguStatus | undefined>` to `packages/app/src/context/global-sync/types.ts`.
- Add cache cleanup in `packages/app/src/context/global-sync/session-cache.ts`.
- Add an event case in `packages/app/src/context/global-sync/event-reducer.ts` for `session.next.fugu.status`.
- Add a `FuguStatus` timeline row in `packages/app/src/pages/session/message-timeline.data.ts`.
- Insert the row only for the active user turn when live Fugu status exists and `session_status` is not `idle`.
- Render the row in `packages/app/src/pages/session/message-timeline.tsx` using existing timeline spacing and subdued session-progress styling.
- Clear the row on final `complete`, final `failed`, `session.status` idle, or cache eviction.

## TUI Behavior

Update TUI live state and session rendering:

- Add `fugu_status` to the store in `packages/tui/src/context/sync.tsx`.
- Reduce `session.next.fugu.status` into `fugu_status[sessionID]`.
- Clear stale status on final `complete`, final `failed`, or `session.status` idle.
- Render a compact block in `packages/tui/src/routes/session/index.tsx` under the active turn, near the current pending/thinking output.
- Use plain text that works in narrow terminals and avoids wrapping branch rows when possible.

## Implementation Slices

### PR 1: Live Event And Runtime Emission

- Add `session.next.fugu.status` in `packages/core/src/session/event.ts` as live-only.
- Add a small status publisher type in `packages/opencode/src/session/llm/fugu.ts`.
- Pass the publisher from `packages/opencode/src/session/llm.ts`.
- Emit status transitions for branches, judge, and synthesizer.
- Add `packages/opencode/test/session/llm.test.ts` coverage for event order and no branch output leakage.
- Regenerate SDK types if event schemas flow into the JS SDK.

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/session/llm.test.ts --timeout 30000`
- `./packages/sdk/js/script/build.ts`

Review:

Run a fresh read-only teammate against the PR diff and this slice. Verify the event is live-only, Fugu output remains hidden, non-Fugu streaming is unchanged, and final status clears deterministically.

### PR 2: App Inline Conversation Row

- Add app `fugu_status` state and cache cleanup.
- Reduce `session.next.fugu.status` in `packages/app/src/context/global-sync/event-reducer.ts`.
- Add a Fugu status row in `packages/app/src/pages/session/message-timeline.data.ts`.
- Render the row in `packages/app/src/pages/session/message-timeline.tsx`.
- Add focused tests for reducer behavior and timeline row construction if existing test seams allow it.

Verification:

- `cd packages/app && bun typecheck`
- `cd packages/app && bun test --preload ./happydom.ts ./src/context/global-sync/event-reducer.test.ts`

Review:

Run a fresh read-only teammate against the PR diff and this slice. Verify the row appears only for active Fugu turns, clears on idle/final state, and does not disturb normal timeline row keys.

### PR 3: TUI Inline Conversation Row

- Add TUI `fugu_status` state in `packages/tui/src/context/sync.tsx`.
- Reduce and clear `session.next.fugu.status`.
- Render the status block in `packages/tui/src/routes/session/index.tsx`.
- Keep output readable at narrow widths and use branch numbers, not model names.

Verification:

- `cd packages/tui && bun typecheck`
- `cd packages/tui && bun test test/util/model.test.ts --timeout 30000`

Review:

Run a fresh read-only teammate against the PR diff and this slice. Verify TUI live rendering does not require durable message replay and normal sessions do not show Fugu UI.

## Future Work

- Persist Fugu status history as durable message parts only if reviewers decide completed Fugu orchestration should be replayable.
- Add configurable branch timeout behavior separately from status rendering.
- Add a debug-only expanded view with branch model names or errors, gated behind an explicit setting.
- Add docs to `packages/web/src/content/docs/config.mdx` only if Fugu status becomes configurable or documented as a user-facing feature.

## Open Questions

- Should the final successful status remain visible after the synthesizer finishes? Default: no, clear it when the final answer is complete to avoid durable-looking history.
- Should failed branch errors be visible in the inline row? Default: no, show only `failed`; keep details in logs.
- Should `judge` be shown when no judge is configured? Default: omit the judge row and use header text like `synthesizer working`.
