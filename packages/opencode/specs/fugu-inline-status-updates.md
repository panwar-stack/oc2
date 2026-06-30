# Fugu Inline Status Updates

Status note: implemented. Fugu orchestration publishes live-only status events while `fugu/fugu` is running, and both app and TUI render inline progress near the active user turn without persisting branch or judge details as durable history.

## Goal

Show live Fugu orchestration status inline in the active session conversation while preserving the privacy boundary around branch output, judge guidance, prompts, provider keys, stack traces, model names, variants, and private tool-call proposals.

## Event Surface

`packages/core/src/session/event.ts` defines the live-only event:

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

Implemented rules:

- The event is included in the session all-event union and ephemeral definitions, not the durable definitions.
- It has no `sync` option, so it is live-only like text, reasoning, tool-input, and compaction deltas.
- It carries a `runID` so clients can ignore stale status from an older Fugu turn in the same session.
- It does not include branch text, judge guidance, errors, model IDs, variants, prompts, provider keys, stack traces, or tool-call proposals.

## Runtime Behavior

`packages/opencode/src/session/llm.ts` passes a status publisher into `LLMFugu.run(...)`. `packages/opencode/src/session/llm/fugu.ts` emits status after request-time validation succeeds.

Implemented transitions:

- Initial `branching` event with all branches `pending`, judge `pending` or `skipped`, and synthesizer `pending`.
- Branch `working` when each branch starts.
- Branch `complete`, `failed`, or `timed_out` when each branch finishes.
- Judge `working` and then `complete`, `failed`, or `timed_out` when `fugu.judge` is configured.
- Synthesizer `working` when synthesis begins.
- Final `complete` when the synthesizer emits `finish`.
- Final `failed` when all branches fail before synthesis starts, when the synthesizer emits `provider-error`, or when the synthesizer stream fails.

The Fugu `LLMEvent` stream still exposes only synthesizer output to downstream session persistence. Branch output and judge guidance remain private synthesis inputs.

## App Behavior

Implemented app paths:

- `packages/app/src/context/global-sync/types.ts` stores `fugu_status` as session-scoped live state.
- `packages/app/src/context/global-sync/session-cache.ts` clears `fugu_status` during session cache eviction.
- `packages/app/src/context/global-sync/event-reducer.ts` reduces `session.next.fugu.status`, ignores stale run IDs, ignores stale non-final timestamps, accepts final `complete` or `failed` events for the current run, and clears status when `session.status` becomes `idle`.
- The app reducer may retain final `complete` or `failed` status until idle/cache cleanup, but `packages/app/src/pages/session/message-timeline.data.ts` suppresses final phases so they do not render as durable-looking rows.
- `packages/app/src/pages/session/message-timeline.data.ts` inserts a `FuguStatus` timeline row only for the active turn while the session is not idle and the phase is not final.
- `packages/app/src/pages/session/message-timeline.tsx` renders the row using subdued timeline styling and labels branches as `Branch 1`, `Branch 2`, etc.

App display behavior:

- Header format: `Fugu · <complete>/<total> branches complete · <phase>`.
- Branch rows use config order and one-based branch numbers.
- `pending` renders as `idle`.
- `timed_out` renders as `timed out`.
- Skipped judge status is omitted from the row.

## TUI Behavior

Implemented TUI paths:

- `packages/tui/src/context/sync.tsx` stores `fugu_status` as session-scoped live state.
- It ignores stale run IDs and stale timestamps, clears status when `session.status` becomes `idle`, and deletes status immediately on final `complete` or `failed` phases.
- `packages/tui/src/routes/session/index.tsx` renders `FuguStatusBlock` under the active user message when live Fugu status exists.
- The block uses plain text with `wrapMode="none"` and labels branches as `Branch 1`, `Branch 2`, etc.
- It displays the synthesizer row in addition to branch and optional judge rows.

TUI display behavior:

- Header format: `Fugu · <complete>/<total> branches complete · <phase>`.
- If a branch is working, the phase reads `branch N working`.
- If the judge is working, the phase reads `judge working`.
- If the synthesizer is working, the phase reads `synthesizer working`.
- `pending` renders as `idle`.
- Underscores are rendered as spaces, so `timed_out` displays as `timed out`.

## Tests And Coverage

- Runtime event order, privacy, judge guidance, and synthesizer-only output are covered in `packages/opencode/test/session/llm.test.ts`.
- App live-state reduction and cleanup are covered in `packages/app/src/context/global-sync/event-reducer.test.ts` and `packages/app/src/context/global-sync/session-cache.test.ts`.
- TUI picker visibility is covered in `packages/tui/test/cli/cmd/tui/model-options.test.ts`; inline rendering currently relies on the route component implementation rather than a dedicated renderer test.

## Constraints

- Status is live-only. Do not add database tables, migrations, durable message projection, or replay semantics without a separate design.
- Status must stay near the active turn, not as a toast, header-only indicator, or side panel.
- Status must not expose branch output, judge output, prompts, provider keys, stack traces, model names, variants, private tool-call proposals, or raw errors.
- The Fugu runtime behavior must not change as part of status rendering.
- Normal non-`fugu` sessions should not render Fugu status state.

## Future Work

- Persist completed Fugu status history only if reviewers decide completed orchestration should be replayable.
- Add configurable branch timeout behavior separately from status rendering.
- Add a debug-only expanded view with branch model names or errors, gated behind an explicit setting.
- Add dedicated TUI rendering tests if the route renderer gains a narrow test seam for this block.
