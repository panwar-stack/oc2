# Logu Lead Session Progress Panel

## Goal

Show live Logu compound-run progress in the lead session conversation panel without writing progress into the transcript.

Implement this as a TUI-only progress block derived from existing Logu child sessions and synced `session.status` state. The first pass must stay small: no backend events, no assistant `textDelta` progress, no persistence changes, and no sidebar changes.

## Current State

- `packages/opencode/src/session/llm.ts` waits for `SessionLogu.run(...)` to complete before returning `loguEvents(result.output)`, so the lead transcript only receives the final synthesized output.
- `packages/opencode/src/session/compound/runner.ts` creates Logu branch child sessions with `metadata.logu.stage = "branch"`, `index`, `model`, `variant`, `parentRunID`, and `parentSessionID`.
- `packages/opencode/src/session/compound/runner.ts` marks timed-out Logu branches with `metadata.logu.timedOut` and `timeoutMS`.
- `packages/opencode/src/session/compound/judge.ts` creates a Logu judge child session with `metadata.logu.stage = "judge"`.
- `packages/opencode/src/session/compound/synthesizer.ts` creates a Logu synthesizer child session with `metadata.logu.stage = "synthesizer"`.
- `packages/tui/src/context/sync.tsx` stores `session`, `session_status`, `permission`, `question`, `message`, and `part` data.
- `packages/tui/src/routes/session/index.tsx` derives current route messages from `sync.data.message[route.sessionID]` and renders persisted user and assistant messages in the conversation scrollbox.
- `packages/tui/src/util/logu.ts` exposes `isLoguChildSession`, `loguChildLabel`, and `loguPromptLabel`, but does not yet expose narrow helpers for stage, parent run ID, index, or timeout metadata.

## Non-Negotiables

- Do not persist progress as lead-session messages or parts.
- Do not emit progress through assistant `textDelta`.
- Do not add backend event types.
- Do not change sidebar behavior, sidebar data flow, or sidebar rendering.
- Do not show this progress block inside Logu child sessions.
- Do not poll; use existing synced TUI state.
- Do not mix older Logu runs with the active/latest run.
- Do not add SDK generation work; no SDK shape should change.

## TUI Behavior

Add a compact `LoguProgress` block in `packages/tui/src/routes/session/index.tsx`.

Render it in the lead session conversation area after persisted messages and before prompt/footer UI.

Display only when:

- `session()?.parentID` is absent.
- At least one child session has `child.parentID === route.sessionID`.
- `isLoguChildSession(child)` is true.

Source data:

```ts
sync.data.session
sync.data.session_status
sync.data.permission
sync.data.question
```

Group children by:

```ts
child.metadata.logu.parentRunID
```

Select the displayed run by:

1. Prefer a run with any child status `busy` or `retry`.
2. Otherwise use the run with the newest child `time.updated`.
3. Use child ID ordering only as a fallback.

Status mapping:

```ts
metadata.logu.timedOut === true => "timed out"
session_status[child.id]?.type === "busy" => "working"
session_status[child.id]?.type === "retry" => "retry"
otherwise => "idle"
```

Render example:

```text
Logu · 2/4 branches complete · judge working

Branch 1 · idle
Branch 2 · working
Branch 3 · timed out
Judge · working
```

Do not render judge or synthesizer rows before their child sessions exist.

Show a compact pending indicator when a displayed child session has pending permissions or questions in synced state.

## Utility Changes

Extend `packages/tui/src/util/logu.ts` with metadata accessors:

```ts
export function loguStage(session: Session | undefined): "branch" | "judge" | "synthesizer" | undefined
export function loguParentRunID(session: Session | undefined): string | undefined
export function loguIndex(session: Session | undefined): number | undefined
export function isLoguTimedOut(session: Session | undefined): boolean
```

These helpers must only read existing metadata. They must not change existing helper behavior.

## Edge Cases

- If multiple Logu runs exist under one lead session, show only the selected active/latest run.
- If branch sessions are still being created, summarize only known branch children.
- Do not invent an expected branch total before all branch child sessions are visible in synced state.
- Timeout state must override other displayed states.
- If all displayed children are idle, hide the block by default.
- If a child has pending permissions or questions while not busy, the row must still expose that pending state compactly.

## Implementation Slices

### PR 1: Add Logu Metadata Helpers

- Update `packages/tui/src/util/logu.ts`.
- Add typed helpers for stage, parent run ID, branch index, and timeout state.
- Preserve existing `isLoguChildSession`, `loguChildLabel`, and `loguPromptLabel` behavior.
- Do not touch sidebar files.

Verification:

- `cd packages/tui && bun typecheck`

Review:

Use a fresh read-only reviewer to confirm the diff only exposes existing Logu metadata and does not alter sidebar behavior.

### PR 2: Add Lead Progress Block

- Add a local `LoguProgress` component in `packages/tui/src/routes/session/index.tsx`.
- Derive Logu children from `sync.data.session`.
- Group children by `metadata.logu.parentRunID`.
- Select active/latest run using busy/retry first, then newest child update time.
- Render the block after the existing message loop and before prompt/footer UI.
- Use existing TUI theme colors and spinner/status styling from nearby session UI patterns.
- Include compact pending permission/question indicators for displayed child sessions.
- Do not touch sidebar files.

Verification:

- `cd packages/tui && bun typecheck`
- `cd packages/opencode && tmux new-session -d -s opencode-dev 'bun dev'`
- `tmux capture-pane -pt opencode-dev`
- `tmux kill-session -t opencode-dev`

Manual checks:

- Start a Logu run and confirm the lead panel shows branch, judge, and synthesizer progress as children appear.
- Confirm progress is not written into transcript history.
- Confirm child sessions do not show the lead progress block.
- Confirm older Logu runs are not mixed with the current/latest run.
- Confirm sidebar behavior is unchanged.

Review:

Use a fresh read-only reviewer to compare the diff against this spec. The reviewer must specifically check that no backend events, assistant deltas, persistence changes, polling, or sidebar changes were introduced.

## Open Questions

- Should completed progress disappear immediately after all displayed children become idle?
  Default: yes, hide it to keep the lead conversation clean.
- Should the block live inside the scrollbox or directly below it?
  Default: place it after the message list in the conversation area, before prompt/footer UI, then adjust only if manual TUI testing shows it scrolls away too easily.
