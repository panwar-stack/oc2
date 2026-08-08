# Event-Driven Lead Waiting

## Goal

When no useful coordination work remains, a lead session must finish its response normally. If finite teammates are still active, the runtime must park the lead without more model calls, wait commands, mailbox reads, task-status reads, or filler output.

Teammate mail, teammate completion, team closure, or new lead user input must wake the parked lead. Durable state must decide whether the lead resumes or remains parked.

## Current State

- `packages/opencode/src/session/prompt.ts` implements `SessionPrompt.finalizationBarrier`.
  - It subscribes to events before it reads durable state.
  - It parks on an Effect `Deferred`.
  - It does not use a timer or database polling.
- The lead prompt also says:
  - "Do not finalize while finite teammates remain nonterminal."
  - "Ask for periodic updates."

  These instructions prevent entry into the successful-finalization barrier and can cause sleep or status-poll actions.
- `packages/opencode/src/tool/team_get_messages.ts` detects repeated empty mailbox reads, but its result can still encourage more tool calls.
- `packages/opencode/src/tool/team_task_list.ts` does not block repeated unchanged status reads.
- Team mail and teammate settlement are durable before wake events are published:
  - `packages/opencode/src/team/team.ts`
  - `packages/opencode/src/session/lifecycle-reconciler.ts`
  - `packages/opencode/src/tool/team_wake.ts`
- A parked lead remains `Runner.Running`. A normal `Runner.wake` can reject new work in this state:
  - `packages/opencode/src/effect/runner.ts`
- The CLI transport polls session status every 250 ms in `packages/opencode/src/cli/cmd/run/stream.transport.ts`. This is client polling, not lead model polling.

## Non-Negotiables

- The lead must finish normally when it has no useful work.
- While parked, the lead must make no model or tool calls.
- The barrier must not use sleep, timers, or database polling.
- Events must only trigger a durable-state recheck.
- One mailbox read at a real coordination boundary remains valid.
- Task-list reads remain valid for planning, dependencies, ownership, and integration.
- Repeated empty mailbox reads and unchanged task-list reads must be blocked.
- Shell sleep, filler output, and semantic status requests are guidance-only in the first pass.
- Daemon teammates must not prevent lead finalization.
- Error, cancellation, interruption, and structured-output failure paths must continue to bypass the success-only barrier.
- The first pass guarantees live wake-up only inside one process.
- Do not remove the CLI 250 ms fallback in this work.

## Lead Wait Contract

All lead-facing guidance must use one contract:

1. Continue useful decomposition, integration, review, or decision work.
2. When no useful work remains, finish the current response normally.
3. The runtime parks successful finalization while finite teammates remain active.
4. Do not sleep, repeatedly read team state, ask for routine updates, or send filler.
5. Teammates must send material progress, blockers, questions, and results without a lead status request.
6. Relevant teammate or user events wake the lead.

Remove these phrases:

- "Do not finalize while finite teammates remain nonterminal."
- "Ask for periodic updates."
- "An empty mailbox does not require ending this turn."

## Polling Guards

### Mailbox

Keep the existing same-turn repeated-empty-read detection in `team_get_messages`.

A blocked result must tell the lead to finish normally. It must not suggest another mailbox or status read.

### Task List

Add tool metadata with this logical shape:

```ts
type TeamTaskListMetadata = {
  revision: TeamRevision
  repeated: boolean
}
```

Suppress `team_task_list` before reading tasks when:

- A completed task-list call exists in the same user turn.
- The team revision has not changed.

Allow the call when:

- The team revision changed.
- A new user turn started.
- A synthetic mailbox turn started.

The blocked result must use a stable title such as `Team Tasks (Polling Blocked)` and direct the lead to finish normally.

## Same-Process Park Signal

Add an instance-local parked-session registration in `packages/opencode/src/session/run-state.ts`.

- Key registrations by lead session ID.
- Register before the final durable-state checks.
- Replace the registration before the second durable check.
- Remove registrations with identity-safe cleanup.
- A matching wake must complete the current park signal and return without calling `Runner.wake`.
- Duplicate wakes must not start a second lead run.
- Keep current event subscriptions as a fallback.

Direct signals must follow durable writes for:

- Direct and broadcast teammate mail.
- Teammate terminal settlement.
- `Team.shutdown`.
- New user input for the lead session.

Input for a teammate session must not signal the lead registration.

In `packages/opencode/src/team/team.ts`, post-commit event publication must be best effort. A failed listener must not prevent the later direct wake after durable mail or closure state is committed.

## Failure Modes

- **Event before parking:** The second durable read must observe it.
- **Event after signal replacement:** The current registration must receive it.
- **Duplicate event:** The barrier can recheck, but no concurrent run can start.
- **Unrelated event:** The lead must return to the same park without a model call.
- **Publication failure after commit:** Durable state and the direct signal must still wake the lead.
- **Cancellation or error:** Registrations and subscriptions must be removed.
- **Process restart:** Durable mail remains available, but cross-process live wake-up is out of scope.

## Implementation Slices

### PR 1: Use One Lead Wait Contract

Update all lead-facing wait guidance:

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/command/template/use-team.txt`
- `packages/opencode/src/tool/team_spawn.txt`
- `packages/opencode/src/tool/team_get_messages.txt`
- `packages/opencode/src/tool/team_get_messages.ts`
- `packages/opencode/src/tool/team_task_list.txt`
- `packages/opencode/src/tool/team_send_message.ts`
- `packages/opencode/src/tool/team_broadcast.ts`
- `packages/opencode/src/team/README.md`

Add focused assertions for required and forbidden phrases in:

- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/tool/team_messages.test.ts`
- `packages/opencode/test/tool/team_spawn.test.ts`
- `packages/opencode/test/command/command.test.ts`

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/session/prompt.test.ts test/tool/team_messages.test.ts test/tool/team_spawn.test.ts test/command/command.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must compare the focused diff with this PR plan. The reviewer must search for conflicting wait instructions. Do not mark the PR complete until all findings are resolved.

### PR 2: Block Unchanged Task Polling

- Add the revision-aware guard to `packages/opencode/src/tool/team_task_list.ts`.
- Follow the stored tool-part pattern in `team_get_messages.ts`.
- Suppress the call before task retrieval.
- Add tests for:
  - First read allowed.
  - Same-turn and same-revision repeat blocked.
  - Revision change allowed.
  - New real or synthetic user turn allowed.
  - Blocked reads do not write team state.

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/tool/team_tasks.test.ts test/tool/team_messages.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must confirm that the guard does not block planning or reads after material state changes.

### PR 3: Add A Direct Park Signal

- Add instance-local registrations in `packages/opencode/src/session/run-state.ts`.
- Register and clean up the barrier signal in `packages/opencode/src/session/prompt.ts`.
- Short-circuit normal Runner scheduling when a parked signal matches.
- Route mail, settlement, closure, and lead-input wake sources to the signal after durable writes.
- Make post-commit team event publication best effort in `packages/opencode/src/team/team.ts`.
- Do not change durable resume-ticket semantics in this PR.
- Add deterministic tests without fixed sleeps for:
  - Direct wake from staged durable mail.
  - Failed event publication.
  - Duplicate wake behavior.
  - Cancellation cleanup.
  - Instance isolation.
  - Lead input wake and re-park.
  - Teammate-input filtering.
  - No extra model or tool calls before a wake event.

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/session/prompt.test.ts test/team/team.test.ts test/tool/team_messages.test.ts test/session/run-state-suspend.test.ts`
- `bun test --timeout 30000 test/cli/run/runtime.queue.test.ts test/cli/run/stream.transport.test.ts`
- `bun run typecheck`

Final verification from the repository root:

- `bun run check:generated`

Review:

A fresh read-only adversarial teammate must inspect the complete diff for wake races, duplicate runs, cleanup errors, instance leakage, and added polling or fixed sleeps. No implementation slice is complete until this review has no unresolved finding.

## Future Work

- Add a cross-process wake transport before claiming live wake delivery across processes.
- Replace the CLI 250 ms fallback after the runtime exposes an explicit parked-session event.
- Consider a lead-aware shell wait-command guard if prompt guidance remains insufficient.

## Open Questions

- **Must the first pass block shell sleep commands at runtime?**
  Recommended default: no. Generic shell blocking can reject valid tests and user commands and requires correct parsing for each supported shell. Measure prompt-contract failures before adding this enforcement.
