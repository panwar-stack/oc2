# TUI Performance And Memory Reduction

## Goal

Reduce TUI CPU, startup latency, and retained memory without changing user-visible session behavior. The first pass should prioritize low-risk lifecycle cleanup, bounded caches, and reducing render pressure during streaming.

Implementation should be incremental: fix leaks first, then isolate high-frequency streaming updates, then virtualize large views and defer non-critical startup work.

## Current State

- `packages/tui/src/context/sync.tsx` caps legacy per-session messages to 100, but deletion paths leave related per-session maps and message parts behind.
- `packages/tui/src/context/sync-v2.tsx` stores full opened-session histories without a visible-window cap or session deletion cleanup.
- `packages/tui/src/routes/session/index.tsx` renders all loaded messages/parts in one scrollbox and performs multiple array scans in reactive render paths.
- `packages/tui/src/ui/dialog-select.tsx` filters and renders all matching options.
- `packages/tui/src/feature-plugins/system/diff-viewer.tsx` can render all patch files at once.
- `packages/opencode/src/index.ts` eagerly imports all CLI command modules before command dispatch.
- `packages/tui/package.json` exposes `bun test --timeout 30000` and `tsgo --noEmit` for verification.

## Non-Negotiables

- Do not change persisted session data shape in the first pass.
- Do not drop visible streaming output.
- Keep newest/active assistant message fully reactive.
- Preserve existing keyboard and scroll behavior.
- Avoid broad rewrites of OpenTUI/Solid primitives.
- Each slice must be independently reviewable.
- Before marking a slice complete, run a fresh read-only adversarial review of the diff against this spec.

## Design

### Memory Lifecycle

- On `session.deleted`, remove all per-session state:
  - `permission`
  - `question`
  - `session_status`
  - `fugu_status`
  - `team_member_status`
  - `session_diff`
  - `todo`
  - `message`
  - `part`
  - `fullSyncedSessions`
  - `syncingSessions`
  - `hydratingSessions`
- On `message.removed`, delete `store.part[messageID]`.
- Bound `preview-pane.tsx` message cache with LRU/TTL or replace-by-session behavior.

### Streaming Updates

Introduce a narrow streaming buffer for text/reasoning deltas:

```ts
type StreamingPartKey = `${sessionID}:${messageID}:${partID}`

type StreamingPartBuffer = {
  text: string
  flushScheduled: boolean
}
```

Rules:

- Delta events append to the buffer.
- Flush buffer at a short cadence, for example 16-50ms.
- Completed parts commit final content to the main sync store.
- Non-streaming historical messages continue to read from existing sync state.

### Render And List Virtualization

First-pass virtualization targets:

- Session timeline in `packages/tui/src/routes/session/index.tsx`.
- `DialogSelect` in `packages/tui/src/ui/dialog-select.tsx`.
- Diff viewer in `packages/tui/src/feature-plugins/system/diff-viewer.tsx`.

Default behavior:

- Render latest active message and nearby viewport rows.
- Use placeholders for offscreen historical rows.
- Keep stable scroll position when new streaming content arrives.

### Startup Deferral

Defer non-critical startup work until after first paint:

- Lazy-load rarely opened dialogs from `packages/tui/src/app.tsx`.
- Lazy-import non-selected CLI command handlers in `packages/opencode/src/index.ts`.
- Defer custom theme discovery in `packages/tui/src/context/theme.tsx` unless configured theme requires it.

## Implementation Slices

### PR 1: Memory Cleanup And Bounded Caches

- Update `packages/tui/src/context/sync.tsx` so `session.deleted` removes all related per-session maps.
- Update `message.removed` handling to delete `store.part[messageID]`.
- Bound or replace the module-level cache in `packages/tui/src/feature-plugins/session/preview-pane.tsx`.
- Add cleanup for ignored `event.on(...)` unsubscribe handles in:
  - `packages/tui/src/component/prompt/index.tsx`
  - `packages/tui/src/routes/session/index.tsx`

Verification:

Working directory: `packages/tui`

- `bun test --timeout 30000`
- `bun run typecheck`

Review:

- A fresh read-only reviewer must inspect the diff for missed session-scoped state, stale closures, and behavior changes around session deletion/message removal.

### PR 2: Batch Streaming Store Updates

- Add a streaming delta buffer in legacy sync:
  - `packages/tui/src/context/sync.tsx`
- Add equivalent buffering in V2 sync:
  - `packages/tui/src/context/sync-v2.tsx`
- Ensure part completion flushes pending buffered text before committing final state.
- Keep active streaming content visually current within the chosen flush cadence.

Verification:

Working directory: `packages/tui`

- `bun test --timeout 30000`
- `bun run typecheck`

Manual check:

- Start TUI with `bun dev` from `packages/opencode`.
- Send a long prompt.
- Verify streaming text appears continuously and final message content is complete.

Review:

- A fresh read-only reviewer must check for lost deltas, out-of-order flushes, and Solid store updates that still happen per token.

### PR 3: Reduce Session Route Render Work

- Move repeated session/message scans out of render memos in `packages/tui/src/routes/session/index.tsx`.
- Add indexed selectors for:
  - child sessions by parent ID
  - user message IDs by session
  - active/pending assistant message IDs
- Pass parent user timing into assistant rows instead of scanning the full message list per row.

Verification:

Working directory: `packages/tui`

- `bun test --timeout 30000`
- `bun run typecheck`

Review:

- A fresh read-only reviewer must compare old and new derived behavior for sessions with children, pending assistant messages, and mixed user/assistant histories.

### PR 4: Virtualize Large TUI Views

- Add viewport-based rendering to the session timeline in `packages/tui/src/routes/session/index.tsx`.
- Virtualize rows in `packages/tui/src/ui/dialog-select.tsx`.
- Limit diff viewer rendering in `packages/tui/src/feature-plugins/system/diff-viewer.tsx` to active/nearby files.
- Reuse a single flattened file tree memo in the diff viewer.

Verification:

Working directory: `packages/tui`

- `bun test --timeout 30000`
- `bun run typecheck`

Manual check:

- Open a session with more than 100 parts or large tool outputs.
- Open session list with many sessions.
- Open a large multi-file diff.
- Verify scrolling, selection, keyboard navigation, and active row highlighting remain correct.

Review:

- A fresh read-only reviewer must focus on scroll correctness, keyboard navigation, offscreen placeholder behavior, and regressions in active streaming rows.

### PR 5: Defer Startup Work

- Lazy-load non-critical dialogs imported by `packages/tui/src/app.tsx`.
- Defer custom theme discovery in `packages/tui/src/context/theme.tsx`.
- Lazy-import selected CLI command handlers in `packages/opencode/src/index.ts`.
- Consider lazy imports in `packages/opencode/src/cli/tui/worker.ts` for server/upgrade/config paths.

Verification:

Working directory: `packages/tui`

- `bun run typecheck`

Working directory: `packages/opencode`

- `bun run typecheck`
- `bun test --timeout 30000`

Manual check:

- Run `bun dev` from `packages/opencode`.
- Verify first TUI paint still appears.
- Open command palette, theme dialog, session list, and workspace/session dialogs.

Review:

- A fresh read-only reviewer must check for accidental behavior changes in CLI command registration, first-paint readiness, and lazy-loaded dialog failure handling.

## Future Work

- Add explicit TUI render benchmarks or trace markers.
- Add memory snapshots for long-running sessions.
- Add paging for V2 session histories instead of only visible-window caps.
- Filter high-volume event types before RPC forwarding from the TUI worker.
- Coalesce local persistence writes in `packages/tui/src/context/kv.tsx` and `packages/tui/src/context/local.tsx`.

## Open Questions

- Should V2 sync use the same 100-message visible cap as legacy sync? Default: yes for first pass, with paging left for future work.
- Should timeline virtualization rely on OpenTUI primitives or a local implementation? Default: local implementation first to minimize dependency and API risk.
- Should startup deferral show loading placeholders for provider/session data? Default: yes, defer non-critical data behind existing UI placeholders where possible.
