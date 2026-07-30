# Persistent Session Pause And Start

## Goal

Add built-in `/pause` and `/start` commands that suspend the currently viewed session and its full descendant subtree without terminating team or background-task state. A lead command affects the lead and all descendants; the same command in a child affects that child's subtree only.

Paused execution, queued work, pause ownership, and resume intent must survive process and TUI restarts. `/start` must remove only the selected root's pause and resume eligible work once, in dependency-safe order and from its persisted state.

## Current State

- TUI session commands are registered in `packages/tui/src/routes/session/index.tsx`, normalized through `sessionCommands`, and exposed as slash commands by `packages/tui/src/keymap.tsx`.
- `packages/tui/src/component/prompt/index.tsx` dispatches exact single-line local slash matches; unmatched commands are sent to the session API. `/pause` and `/start` belong in the local TUI command registry, not `packages/opencode/src/command/index.ts` prompt templates.
- `packages/opencode/src/session/status.ts` and `packages/opencode/src/session/run-state.ts` keep status and runners in instance memory. Neither survives restart.
- `packages/core/src/session/sql.ts` persists sessions and queued `session_input`, but has no durable pause control. V2 persists `InterruptRequested`, while `packages/core/src/session/projector.ts` discards it and `packages/core/src/session/run-coordinator.ts` keeps its interrupt boundary in memory.
- `packages/opencode/src/session/prompt.ts` routes normal execution through `SessionPrompt.loop`. Team wakes enter through `packages/opencode/src/tool/team_wake.ts` and `TaskPromptOps.wake`.
- `SessionPrompt.cancel` shuts down an active team. `SessionRunState.cancel` also cancels descendant background jobs. Neither is safe for pause.
- `packages/opencode/src/tool/team_spawn.ts` owns member completion, dependency unblocking, and lead notification inside a transient tool continuation. `packages/opencode/src/tool/task.ts` similarly owns background-task result injection in a transient watcher. Restart cannot reconstruct either flow today.
- `packages/opencode/src/session/session.ts` exposes direct children through `Session.children(parentID)`; recursive traversal exists only in session removal.
- Team member and task statuses and dependencies are durable in `packages/opencode/src/team/team.sql.ts` and `packages/opencode/src/team/team.ts`.
- Public session routes live in `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` and handlers in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`. API changes require regenerating `packages/sdk/openapi.json` and `packages/sdk/js/src/v2/gen/`.

## Non-Negotiables

- `/pause` must take effect immediately: once its durable barrier commits, no affected session may begin another provider request, tool invocation, shell command, mailbox claim, queued-input promotion, or wake-driven loop iteration.
- Immediately after committing the barrier, the pause action must signal interruption to every currently running affected session. It must not wait for the current model turn, tool call, retry delay, background task, or child session to finish gracefully.
- The API may return after blockers are committed and interruption is signalled to the captured subtree; it must not wait for interrupted fibers to unwind. Its response must distinguish sessions signalled for interruption from sessions that were already idle.
- Persist the pause barrier before interrupting any provider, tool, shell, team member, or background task.
- Do not implement pause with `SessionPrompt.cancel`, team shutdown, or terminal member/task cancellation.
- Pausing must not mark a member `completed`, `cancelled`, or `idle`, unblock dependencies, consume mailbox rows, or inject partial task results.
- Model overlapping pauses as stackable blockers. `/start` on a child must not bypass an active ancestor pause.
- Newly created descendants must inherit or dynamically resolve all active ancestor blockers before they can execute.
- Preserve queued prompts, mailbox messages, admitted V2 inputs, team/task dependency state, and background-task result delivery across restart.
- Resume only sessions with durable resume intent. Do not blindly run completed, cancelled, dependency-blocked, or idle sessions.
- Repeated and concurrent `/pause` and `/start` calls must be idempotent and must not duplicate provider turns, tool execution, messages, or result delivery.
- First-pass UI scope is the TUI. Leave the web app and direct `oc2 run --interactive` support out unless product explicitly expands scope.
- The command is `/start`. Do not add the misspelled `/starte` alias in the first pass.

## Durable Control Model

Add normalized control data under `packages/core/src/session/sql.ts` rather than storing pause state in replaceable session metadata.

```ts
type SessionPauseCascade = {
  id: string
  rootSessionID: string
  generation: number
  createdAt: number
  releasedAt?: number
}

type SessionPauseBlocker = {
  sessionID: string
  cascadeID: string
}

type SessionResumeIntent = {
  sessionID: string
  generation: number
  reason: "running" | "queued-input" | "team-wake" | "background-result"
}
```

- One active cascade per root makes repeated `/pause` on that root a no-op.
- A session is paused while it has at least one active blocker.
- `/start(root)` releases only the active cascade owned by `root`.
- Resume intent remains durable until the session has no blockers and execution has been scheduled successfully.
- The pause transaction must compute a stable recursive closure using persisted `parent_id` relationships, union active team members, de-duplicate IDs, insert blockers, and snapshot resume intent before interruption.
- Session creation must copy active ancestor blockers in the same transaction as session creation, or pause checks must resolve ancestors transactionally. A descendant must never run between creation and blocker attachment.
- Add a timestamped migration under `packages/core/migration/` and regenerate `packages/core/src/database/migration.gen.ts` with the repository migration workflow.

## Runtime Semantics

### Pause

1. Resolve the current session as the cascade root and serialize same-root operations.
2. Persist the cascade, all blockers, and resume intents transactionally.
3. Immediately after commit, signal pause-specific interruption to all running affected sessions; process descendants before the root without running terminal abort finalizers or waiting for graceful completion.
4. Recheck the cascade generation before each interruption.
5. If `/start` releases the blocker during interruption, compensate by scheduling any still-valid resume intent.

Introduce a pause-specific suspension path in `packages/opencode/src/session/run-state.ts`. Update `packages/opencode/src/tool/team_spawn.ts`, `packages/opencode/src/tool/task.ts`, and `packages/opencode/src/effect/runner.ts` so suspension is distinguishable from terminal cancellation and preserves lifecycle ownership.

“Immediately” defines the committed barrier as the authoritative execution boundary; it cannot undo an external side effect already issued before the commit. A provider request, tool, or OS process that cannot be cancelled synchronously may finish externally, but its result must not advance session state or trigger follow-up work while blocked. Cancellation-capable provider streams and subprocesses must receive their abort signal during the pause operation.

### Execution Gates

Every path capable of side effects must consult durable pause state:

- Before prompt admission/execution behavior in `packages/opencode/src/session/prompt.ts`.
- Before command shell substitution, `shell`, `init`, and `summarize` execution.
- Before runner entry, every loop iteration, and every provider attempt.
- Before V2 `execution.wake`, explicit `run`, input promotion, and coordinator dispatch in `packages/core/src/session.ts`, `packages/core/src/session/execution/local.ts`, and `packages/core/src/session/runner/llm.ts`.
- Before `deliverTeamMessages` claims mailbox rows.
- Before every wake source routed through `packages/opencode/src/tool/team_wake.ts`.

While paused:

- User prompts and V2 inputs must be admitted durably and set resume intent, but must not execute.
- Team mailbox rows must remain pending and set resume intent; do not claim them early.
- Commands with shell substitutions, direct shell, init, and summarize must return a typed `SessionPausedError` before side effects rather than partially execute.
- Shutdown, deletion, and explicit terminal cancellation remain available and authoritative.

### Start And Recovery

- Atomically release the selected root's cascade and identify sessions that have no remaining blockers and have resume intent.
- Do not resume terminal sessions/members or members whose dependencies are incomplete.
- Resume eligible descendants before the lead. Persist child completion/result notification before waking a waiting parent.
- Use generation/CAS checks so concurrent starts schedule each session at most once and a concurrent new pause wins before execution.
- Extract team-member and background-task completion/reconciliation from transient `team_spawn` and `task` watchers into restart-safe services. The reconciler must finalize results, notify the lead, and unblock dependents exactly once after resumed work completes.
- After process restart, `/start` must reconstruct execution solely from durable blockers, resume intents, queued inputs, member/task rows, and mailbox state. It must not depend on stale `SessionStatus`, `SessionRunState`, or watcher fibers.

## API And TUI Surface

Add typed session actions:

```http
POST /session/:sessionID/pause
POST /session/:sessionID/start
```

Return a structured result:

```ts
type SessionControlResult = {
  rootSessionID: string
  cascadeID?: string
  affectedSessionIDs: string[]
  interruptionSignalledSessionIDs: string[]
  stillBlockedSessionIDs: string[]
  scheduledSessionIDs: string[]
  unchanged: boolean
}
```

- Unknown/deleted sessions return the existing typed not-found response.
- Pause/start on an already paused/started root returns `unchanged: true`.
- Start must not resurrect closed teams or terminal members/tasks.
- Expose effective paused state through the session read/sync model so initial TUI hydration and live updates agree.
- Register `/pause` and `/start` in `packages/tui/src/routes/session/index.tsx`. The command targets the currently viewed session and dispatches the typed API action.
- Disable `/pause` when the root already owns an active cascade and disable `/start` when it does not. Effective ancestor blocking may keep the session paused after a successful child `/start`; show that state explicitly.
- Update `docs/tui.md` and the orchestration behavior in `packages/opencode/src/team/README.md`.

## Implementation Slices

### PR 1: Durable Pause State

- Add cascade, blocker, and resume-intent tables plus the generated migration.
- Add a session-control service for effective pause queries, recursive target closure, blocker inheritance, idempotent cascade creation/release, and generation checks.
- Expose effective paused state in the session read model.
- Add persistence, overlap, recursive-child, concurrent-child-creation, and restart tests.
- Do not expose commands or interrupt execution in this slice.

Verification:

- `bun run --cwd packages/core test -- test/session-create.test.ts test/session-run-coordinator.test.ts test/session-runner.test.ts`
- `bun run --cwd packages/core typecheck`
- `bun run check:generated`

Review:

A fresh read-only teammate must review the diff against this slice, focusing on migration safety, overlapping child/ancestor cascades, transaction boundaries, descendant creation races, and restart persistence. Resolve findings before marking the slice complete.

### PR 2: Resumable Runtime And Lifecycle Reconciliation

- Add pause-specific suspension; do not reuse cancellation or shutdown.
- Gate all legacy and V2 execution boundaries, shell substitution, mailbox claiming, and wake sources.
- Preserve durable resume intent for running work, queued input, suppressed wakes, and pending result delivery.
- Extract restart-safe team-member and background-task completion/reconciliation from transient tool continuations.
- Resume eligible descendants and dependencies exactly once before waking their parent/lead.
- Keep runtime gates and lifecycle reconciliation in one behavioral slice; landing either alone can lose work or falsely complete members.

Verification:

- `bun run --cwd packages/core test -- test/session-run-coordinator.test.ts test/session-runner.test.ts`
- `bun run --cwd packages/opencode test -- test/session/prompt.test.ts test/team/team.test.ts test/tool/team_spawn.test.ts test/tool/team_messages.test.ts test/tool/team_tasks.test.ts test/tool/team_shutdown.test.ts`
- `bun run --cwd packages/core typecheck && bun run --cwd packages/opencode typecheck`

Review:

A fresh read-only teammate, different from PR 1's reviewer, must adversarially inspect suspension versus cancellation, provider/wake races, mailbox claim timing, team/task status preservation, dependency ordering, background result delivery, and restart reconciliation. Resolve findings and rerun verification before marking the slice complete.

### PR 3: Typed Session Control API And SDK

- Add pause/start schemas, handlers, and routes in the session HTTP API.
- Return `SessionControlResult` and typed paused/not-found failures.
- Regenerate OpenAPI and JavaScript SDK outputs with `./packages/sdk/js/script/build.ts`; do not hand-edit generated files.
- Add route tests for subtree scope, overlap, idempotency, workspace routing, terminal state, and concurrent pause/start compensation.

Verification:

- `bun run --cwd packages/opencode test:httpapi`
- `./packages/sdk/js/script/build.ts`
- `bun run check:generated`
- `bun run --cwd packages/sdk/js typecheck`
- `bun run --cwd packages/opencode typecheck`

Review:

A fresh read-only teammate must compare routes, schemas, OpenAPI, and generated SDK behavior; challenge malformed IDs, deleted sessions, concurrent calls, and accidental terminal-state resurrection before the slice is marked complete.

### PR 4: TUI Commands And Documentation

- Register `/pause` and `/start` as local session commands in `packages/tui/src/routes/session/index.tsx`.
- Dispatch the API against the viewed session and surface effective paused/ancestor-blocked feedback.
- Add focused tests for slash discovery, exact matching, enabled state, child targeting, API calls, command collisions, whitespace, and no-session behavior.
- Update `docs/tui.md` and `packages/opencode/src/team/README.md`.

Verification:

- `bun run --cwd packages/tui test -- test/app-lifecycle.test.tsx test/feature-plugins/builtins.test.ts <new-pause-start-test>`
- `bun run --cwd packages/tui typecheck`
- `bun run docs:check`
- `bun run lint && bun run check:packages && bun run check:generated && bun run typecheck`

Review:

A fresh read-only teammate must review the diff against the implemented API and runtime behavior, including command precedence, target selection, effective ancestor blocking, restart hydration, and documentation accuracy. Resolve findings before marking the slice complete.

## Deterministic Acceptance Cases

- Lead pause covers nested team and task descendants; child pause covers only that child's subtree.
- Child-then-lead and lead-then-child pauses both require the corresponding blockers to be released.
- A child created while an ancestor is paused cannot execute before start.
- Restart retains blockers, queued inputs, resume intent, team/task statuses, dependencies, and mailbox rows.
- Pause during provider streaming, retry, tool, shell, or wake establishes the barrier before any next side effect.
- The pause endpoint commits blockers and signals interruption without waiting for a long-running provider, tool, subprocess, background task, or child fiber to finish.
- A provider/tool result that races with pause cannot start another loop iteration, complete a dependency, claim mail, or wake a parent while blocked.
- Repeated/concurrent start produces one provider dispatch and one result notification.
- A paused mailbox row is consumed exactly once after start.
- Pause never completes/cancels a member, unblocks a dependency, or shuts down the team.
- Completed, cancelled, idle, and dependency-blocked sessions are not blindly resumed.
- `/start` on a child cannot clear an ancestor-owned pause.
- Explicit shutdown/deletion while paused remains terminal; later start cannot resurrect it.
- Concurrency tests use `Deferred`, `pollWithTimeout`, `awaitWithTimeout`, `llm.wait`, or durable status checks, never fixed sleeps.

## Future Work

- Add matching commands to the web app and direct interactive CLI.
- Add bulk pause/start controls outside a viewed session.
- Add pause reason, actor, duration, or scheduled auto-resume.
- Add `/starte` only if telemetry proves compatibility with an already released typo; do not add it speculatively.

## Open Questions

- Should prompts submitted while paused queue or fail? Default: queue durable prompt/V2 input, but reject side-effecting command, shell, init, and summarize actions before execution.
- Should `/start` be allowed from any descendant to release an ancestor cascade? Default: no; it releases only the cascade rooted at the currently viewed session.
- Should daemon teammates that were actively processing resume automatically? Default: yes only when durable resume intent says they were running or received a suppressed wake; idle daemons remain idle.
- Should first-pass support include the web app and `oc2 run --interactive`? Default: no; keep the initial surface to the TUI and typed API.
