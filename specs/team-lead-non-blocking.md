# Non-Blocking Team Lead

## Goal

Make the OC2 lead session non-blocking while teammates or subagents work. Today a
`team_spawn` call runs the teammate's whole session loop inline inside the lead's
LLM stream, so the lead cannot accept or act on a new user message until the
teammate finishes. The outcome: `team_spawn` (and, for team leads, the `task`
tool) returns a handle promptly, the lead's loop parks event-driven, and a new
user message wakes the parked lead so it can act while teammates continue
running in the background.

Strategy: reuse the machinery that already exists — the lifecycle reconciler poll
loop that drives `starting|blocked|active` members, the durable team mailbox with
claim/deliver/release, the non-blocking `wake` paths, the event-backed
`finalizationBarrier`, and the existing `SessionEvent.Prompted` event. No schema
change, no SDK client regeneration, no new background scheduler.

## Current State

- `team_spawn` blocks inline: `packages/opencode/src/tool/team_spawn.ts:385` awaits
  `lifecycleReconciler.startMember`; `startMember`
  (`packages/opencode/src/session/lifecycle-reconciler.ts:1502`) runs
  `input.ops.run` / `input.ops.prompt` (lines 1550/1556), i.e. the teammate's full
  session loop, inside the lead's tool-execution fiber. Both the daemon
  (387-401) and completed (403-413) result shapes consume the `result` of that
  single awaited call.
- The lead is parked inside the LLM stream drain because tool `execute` runs
  inline (`packages/opencode/src/session/tools.ts:97`), drained by
  `SessionProcessor.process` (`packages/opencode/src/session/processor.ts:1300`,
  `Stream.runDrain` at 1339). The lead's `Runner` stays `Running`
  (`packages/opencode/src/effect/runner.ts:193-200`); `Runner.wake` drops work on
  `Running` (`runner.ts:253-255`).
- A user message arriving mid-run is admitted and persisted only by clients that
  call `promptAsync` while a run is active (`createUserMessage`,
  `prompt.ts:1269`). The synchronous HTTP caller awaits `awaitDone(run.done)`
  (`runner.ts:198-200`); the interactive CLI queues input client-side
  (`packages/opencode/src/cli/cmd/run/runtime.queue.ts:253-283`) and sends it
  only when the turn completes (`stream.transport.ts:1360` `waitTurn`,
  idle-based completion at 834-870).
- The `finalizationBarrier` (`prompt.ts:1404`) already parks the lead
  non-blockingly while finite teammates are nonterminal, but it wakes only on
  team events (`team.message.received` / `team.member.updated` / `team.closed`,
  lines 1438-1447) — never on a new user message.
- The lifecycle reconciler poll loop (`lifecycle-reconciler.ts:2017-2170`,
  `pollInterval` 500 ms at line 115) already starts members in
  `starting|blocked|active` when ops are attached (2086-2091); `team_spawn`
  today pre-empts it by awaiting synchronously. Member-start single-winner is the
  in-memory `runningMembers` set (check 1505, add 1506, release 1625-1630); the
  check+add has no `yield*` between them.
- A non-blocking spawn precedent exists: the dependency-blocked branch
  (`team_spawn.ts:349-366`) already returns "Teammate Spawned" immediately, and
  `claimReadyDependents` forks `startMember` for newly ready members
  (`lifecycle-reconciler.ts:1146-1154`).
- Subagents: the `task` tool foreground branch blocks on
  `background.wait` / `waitForPromotion` (`packages/opencode/src/tool/task.ts:317-320`,
  `packages/core/src/background-job.ts:295` / 302-307). An async path already
  exists behind `OC2_EXPERIMENTAL_BACKGROUND_SUBAGENTS`
  (`packages/opencode/src/effect/runtime-flags.ts:42`, `task.ts:114-118`) and
  delivers results via `deliverBackgroundNotification` +
  `wakeWithIntent("background-result")` (`lifecycle-reconciler.ts:1720,1840`).
  That wake is dropped while the parent is `Running` (runner.ts:253-255), so a
  parked lead does not observe background results today.
- Model-visible guidance still promises blocking semantics:
  `packages/opencode/src/tool/team_spawn.txt:3` ("The spawn call waits for the
  teammate's current run to finish...") and
  `packages/opencode/src/team/README.md:145,161-182,285-310`.

## Non-Negotiables

- No DB schema change (`packages/opencode/src/team/team.sql.ts` unchanged in first
  pass) and no SDK client regeneration (`bun run check:generated` must stay green).
- Single-winner member start: the in-memory `runningMembers` set
  (`lifecycle-reconciler.ts:1505-1506,1625-1630`) must guarantee a member run
  starts exactly once, whether started by the reconcile poll (2086-2091) or by
  `claimReadyDependents` (1146-1154). The tool must stop calling `startMember`.
- Preserve the finalization contract: the lead's run must not terminate while
  finite teammates are nonterminal and the lead is still active; team close or
  loss of lead status releases the park (`exitPermitted`, `prompt.ts:1418-1424`).
- Preserve pause/resume durability: `ResumeReason` (`packages/core/src/session/control.ts:14`)
  and durable resume intents stay unchanged in PR 1-3.
- Member teardown on team shutdown stays owned by the existing cancel path
  (`prompt.ts:160-186` force-shuts the team and cancels member sessions). The
  spawn tool no longer owns member cancellation after PR 1.
- Deterministic tests: event-driven waits (see `assertLoopParked`,
  `prompt.test.ts:388-394`), no new sleeps; tolerate the 500 ms reconcile poll
  latency where relevant.
- Do not change the `task` tool's default behavior for non-team sessions in the
  first pass (PR 4 is lead-scoped and descopable).

## Design

### D1. Async teammate start

`team_spawn` stops awaiting the member run. After member + session creation, the
tool returns a `started` result immediately; the reconcile poll claims the member
and runs it on its own fiber (each member runs on its own session's `Runner`, so
cross-session concurrency already works). The tool result no longer contains the
member's final result; completion is observed via the durable mailbox
auto-notification (`lifecycle-reconciler.ts:1156`, `team.test.ts:1032`), which
the barrier delivers and the model guidance (D4) tells the lead to consume.

New tool result shape for task members (replaces "Teammate Completed",
`team_spawn.ts:403-413`):

```ts
{
  title: "Teammate Started",
  output: "Teammate started: <name> (<sessionID>) [<agent_type>]; running in background",
  metadata: { memberID, sessionID, dependencyIDs },
}
```

- The flow must split before the shared await at `team_spawn.ts:385`: task
  members take the early-return path; the dependency-blocked branch (349-366)
  keeps its shape. Daemon members keep the inline `startMember` await in PR 1
  (daemon initialization is bounded and settles to `idle`, 1607-1608); making
  daemons reconcile-driven is a later decision (see Open Questions).
- Both remaining `startMember` execution paths — fresh prompt
  (`lifecycle-reconciler.ts:1556`) and resume (`1550`) — must be driven by the
  reconciler, never inline in the lead's fiber. The resume path keeps `ops.run`
  semantics for a paused member; it just moves off the lead's fiber.
- Teammate completion already wakes the lead and creates a pending mailbox
  delivery for it (`lifecycle-reconciler.ts:1156`, auto-notification in
  `team.test.ts:1032`); the barrier delivers that mail and continues the loop.

### D2. Parked lead wakes on user input

Reuse the existing event instead of inventing a signal:
`SessionEvent.Prompted` ("session.next.prompted") is published inside
`createUserMessage` (`prompt.ts:1235`, gated by `flags.experimentalEventSystem`)
on the same event bridge the barrier already subscribes to.

- `finalizationBarrier` (`prompt.ts:1404`) subscribes to `SessionEvent.Prompted`
  alongside the team events (1438-1447). The barrier callback must filter the
  event by `sessionID` (the current callback at 1441 ignores payloads), so a
  teammate's prompt does not spuriously wake the lead.
- On a matching signal, re-check durable state; if a new user message exists
  since `lastUser`, return `true` so `runLoop` (call site 1598) `continue`s,
  re-reads messages (1555), and processes the new message through the existing
  system-reminder injection (1726-1742). After processing, the loop re-enters
  the barrier and parks again while teammates run.
- Boundary: this wakes only clients that admit a prompt mid-park via
  `promptAsync` (CLI after PR 3, Web UI). The synchronous HTTP `prompt` caller
  still awaits the in-flight run (`runner.ts:198-200`) and cannot wake the park;
  that is unchanged behavior.

Edge cases:

- CLI single-flight (`stream.transport.ts:1193-1196`, drain in
  `runtime.queue.ts:112-251`): one message in flight per turn, so each user
  message gets its own loop iteration while parked. HTTP `promptAsync` forks
  mid-run batch via the re-read at 1555 (existing behavior, unchanged).
- The signal must not reorder team mail; `deliverTeamMessages` (`prompt.ts:1322`)
  keeps claiming/delivering mailbox rows first.
- If the lead is no longer an active lead or the team closed, the barrier exits
  (unchanged, 1418-1424).
- The `experimentalEventSystem` gate at 1235 must be verified (or removed) for
  this path to work in production.

### D3. CLI/TUI delivers input during a parked lead

The interactive CLI queues input while a run is active and sends only when the
turn completes (`runtime.queue.ts:253-283`; `stream.transport.ts:1360`
`waitTurn`, idle-based completion in `complete`/`mark`/`poll` at 834-870). For a
team-lead session parked at the barrier:

- Submit the prompt via `promptAsync` immediately instead of queueing
  (`runtime.queue.ts` `submit`, 253-300).
- Complete the turn when the lead's loop produces the response for that message,
  not when `session.status idle` arrives. This targets `complete`/`mark`/
  `applyEvent` (834-870), not the transport doc comment.
- Keep the non-team path (queue-until-turn-complete) unchanged.

### D4. Guidance and contract updates

- `packages/opencode/src/tool/team_spawn.txt:3`: rewrite to state the spawn
  returns immediately and results arrive via team messages; the lead's
  finalization parks automatically until finite teammates are terminal.
- `packages/opencode/src/team/README.md` "Lead Waiting And Parallel Spawn"
  (161-182) and "Lead Finalization Barrier" (285-310): update to describe async
  spawn and input-driven park wakes.

## Implementation Slices

### PR 1: Async teammate start

- `packages/opencode/src/tool/team_spawn.ts`: split the flow before the shared
  await (385). Task members return the "Teammate Started" result immediately;
  the dependency-blocked branch (349-366) stays; daemon members keep the inline
  await for PR 1. Drop the tool-side abort-to-cancel of members (368-376) since
  the tool no longer runs the member; keep the terminalize/onExit safety
  (426-438) for real failures.
- `packages/opencode/src/session/lifecycle-reconciler.ts`: confirm both
  `startMember` paths (1502-1574) run only on the reconciler and are guarded by
  `runningMembers`; verify `reconcile` (2086-2091) starts the freshly created
  task member on the next poll.
- Update `team_spawn.txt` and `team/README.md` (D4).
- Update tests that assert the final result inside the spawn tool result:
  `team_spawn.test.ts` lines 292, 376, 518, 1221, 1281, 1380, 1442 and the
  loop-completion assertions in `prompt.test.ts:1634`. Add tests: a task-member
  spawn returns `started` immediately while the member run completes in the
  background; the lead observes completion via team mail; the member starts
  exactly once; daemon spawn behavior is unchanged.

Verification:

- `bun test --timeout 30000 test/tool/team_spawn.test.ts test/session/lifecycle-reconciler.test.ts test/session/prompt.test.ts`
- `tsgo --noEmit`
- `bun run check:generated`

Review: fresh read-only reviewer compares the diff against the
`runningMembers` single-winner rule (no double-start), confirms no schema/SDK
change, confirms the spawn tool result no longer embeds the member's final
result, and confirms the daemon path is explicitly split and preserved.

### PR 2: Parked lead wakes on user input

- `packages/opencode/src/session/prompt.ts`: subscribe `finalizationBarrier`
  (1404-1463) to `SessionEvent.Prompted` (1235) with a `sessionID` filter; on a
  matching signal with a new user message since `lastUser`, continue the loop
  (call site 1598). Verify or remove the `experimentalEventSystem` gate.
- Add tests: user message wakes a parked lead, the lead processes it, then
  re-parks while teammates stay nonterminal; a teammate's prompt does not wake
  the lead's barrier (sessionID filter); team mail delivered while parked is
  unaffected; ordering of a user message vs. pending team mail.

Verification:

- `bun test --timeout 30000 test/session/prompt.test.ts test/team/team.test.ts test/tool/team_messages.test.ts test/session/run-state-suspend.test.ts`
- `tsgo --noEmit`

Review: fresh read-only reviewer checks that the barrier's team-event
subscriptions and mailbox claiming are untouched, the `sessionID` filter is
correct, and the continue-path re-parks correctly.

### PR 3: CLI delivers input during a parked lead

- `packages/opencode/src/cli/cmd/run/runtime.queue.ts` (`submit`, 253-300): when
  the session is a team lead with nonterminal finite members, submit via
  `promptAsync` immediately instead of queueing.
- `packages/opencode/src/cli/cmd/run/stream.transport.ts`: complete the turn on
  the lead's response to that message (target `complete`/`mark`/`applyEvent`,
  834-870), not on `session.status idle`.
- Add tests in `test/cli/run/runtime.queue.test.ts` and
  `test/cli/run/stream.transport.test.ts`.

Verification:

- `bun test --timeout 30000 test/cli/run/runtime.queue.test.ts test/cli/run/stream.transport.test.ts test/session/prompt.test.ts`
- `tsgo --noEmit`

Review: fresh read-only reviewer verifies the non-team path (queue-until-turn-
complete) is unchanged and the response-based turn completion does not break
normal turns.

### PR 4 (descopable): Async subagents for team leads

- `packages/opencode/src/tool/task.ts`: when the parent session is an active
  team lead, default to the existing background path (`background=true`,
  `task.ts:114-118`) and return the job handle; results arrive via
  `deliverBackgroundNotification` (`lifecycle-reconciler.ts:1720`).
- Because the background-result insert bypasses `createUserMessage`, PR 4 must
  publish `SessionEvent.Prompted` (or equivalent) after injection so the parked
  lead's barrier wakes (PR 2 dependency). Without it, the notification stays
  `"pending"` and reconcile retries every 500 ms with no effect (1865, 2167-2168).
- Keep the foreground default for all other sessions; keep the experimental
  flag as opt-out.
- Update `task` guidance that describes foreground semantics.

Verification:

- `bun test --timeout 30000 test/tool/task.test.ts test/session/prompt.test.ts`
- `tsgo --noEmit`

Review: fresh read-only reviewer confirms the change is scoped to team-lead
sessions, the background notification wakes a parked lead, and non-lead
sessions keep the foreground default.

## Future Work

- Suspend-as-park: model the barrier park as a `Runner` suspend so the session
  reports idle while teammates run; would simplify the CLI turn model but
  changes status semantics and many barrier tests.
- Bounded spawn wait: return the final result for fast teammates (reuse
  `LEAD_WAKE_TIMEOUT`, `team_wake.ts:7`).
- Reconcile-driven daemon members (remove the last inline `startMember` await).
- A member-status/result read tool so the lead can pull results on demand
  instead of relying on auto-notification mail.

## Open Questions

- Should PR 1 include a bounded wait for fast teammates before returning
  `started`? Default: no; return immediately and let reconcile (500 ms poll)
  drive the member. Tests must tolerate the poll latency.
- Park wake mechanism: reuse `SessionEvent.Prompted` with a `sessionID` filter
  (recommended) vs. suspend-as-park. Default: event reuse; suspend-as-park stays
  future work.
- Daemon members in PR 1: keep the inline await (recommended; bounded init) vs.
  make them reconcile-driven immediately. Default: keep inline for PR 1.
- CLI turn completion while parked: response-based completion (recommended) vs.
  treating park as idle. Default: response-based.
- `task` tool: lead-scoped async default (recommended, PR 4) vs. global default.
  Default: lead-scoped; descope PR 4 if review shows risk.
- Teammate teardown when the lead is interrupted: keep the team-cancel path
  (`prompt.ts:160-186`) for team shutdown, and let members continue on a lead
  interrupt only when the team stays open (recommended). The spec removes the
  tool's per-spawn abort-to-cancel; verify no stranded `starting|blocked` member
  in the interrupted-lead case.
