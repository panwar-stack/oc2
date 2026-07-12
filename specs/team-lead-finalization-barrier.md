# Team Lead Finalization Barrier

## Goal

Prevent an active team lead from successfully finalizing while finite teammates remain nonterminal or team mail remains unconsumed.

Implement this at the existing session finalization boundary. Do not redesign scheduling, restore `team_wait`, change general runner semantics, or add public APIs.

## Current State

- `packages/opencode/src/session/prompt.ts:1393-1406` delivers team mail only at the start of a prompt-loop iteration.
- Successful exits at `packages/opencode/src/session/prompt.ts:1419-1437` and `packages/opencode/src/session/prompt.ts:1613-1648` do not recheck team state.
- `packages/opencode/src/effect/runner.ts:115-138` joins an existing run when a wake arrives; it does not schedule another pass.
- `packages/opencode/src/team/team.ts:326-371` publishes a terminal member update before separately persisting its automatic notification.
- `packages/opencode/src/tool/team_spawn.ts:471-503` sends additional completion or cancellation details after the terminal transition.
- Failures during setup before the catch at `packages/opencode/src/tool/team_spawn.ts:413` can strand a created member in `starting`.
- Finite statuses are `starting`, `blocked`, `active`, `idle`, `completed`, and `cancelled` in `packages/opencode/src/team/team.sql.ts:34-40`.
- `packages/opencode/src/tool/team_get_messages.ts` tells a lead to end its turn while waiting, but there is no distinct parked response.
- `specs/agent-team-reliability-improvements.md` covers mailbox and wake reliability but not final-answer admission.

## Non-Negotiables

- Apply the barrier only to the active team's lead session.
- Treat only `completed` and `cancelled` as terminal for `lifecycle: "task"` members.
- Never let daemon members block finalization.
- Use event-driven parking. Do not poll the database, sleep, or invoke the LLM while parked.
- Subscribe to events before reading durable state to avoid check-then-sleep races.
- Persist each terminal transition and its canonical lead notification atomically and idempotently.
- Preserve progress messages, bounded wake behavior, dependency scheduling, interruption, and error propagation.
- Do not change `Runner`, introduce `team_wait`, add tools or configuration, alter database schemas, or redesign daemon lifecycle.
- Do not change HTTP schemas or generated clients.
- PR 2 must depend on PR 1 because the exit barrier requires atomic terminal handoffs.

## Terminal Handoff

The first transition into `completed` or `cancelled` must atomically persist:

- The terminal member status and result.
- One canonical lead notification containing the result or failure reason.
- The notification's lead recipient row.

`packages/opencode/src/team/team.ts` must provide an internal transaction-local message insertion path reusable by terminal status updates and normal message persistence.

`packages/opencode/src/tool/team_spawn.ts` must:

- Stop sending duplicate terminal messages after `updateMemberStatus`.
- Preserve the existing wake-only behavior after the transaction commits.
- Convert every failure after `addMember` into a notified `cancelled` transition.
- Avoid emitting another notification for repeated terminal updates.

Member and message events must publish only after commit. The transition through event publication must not be interruptible.

Daemon `idle` notifications remain unchanged and are not terminal handoffs.

## Lead Exit Barrier

Add one private helper in `packages/opencode/src/session/prompt.ts` and route both successful-finalization paths through it.

The helper must:

1. Confirm that the session is the active team lead.
2. Register scoped listeners for `team.message.received`, `team.member.updated`, and `team.closed`.
3. Read and deliver pending lead mail through the existing durable mailbox path.
4. Continue the model loop if mail was delivered.
5. Query current members from durable state.
6. Park if any finite member is not `completed` or `cancelled`.
7. Recheck durable mail and member state after every signal.
8. Permit exit when all finite members are terminal, the team is closed, or the session is no longer the active lead.

Event listeners only signal the parked fiber. Durable database state remains authoritative.

Progress or blocker mail must resume the lead so it can process the handoff. If finite work remains after that turn, the next successful-finalization attempt parks again.

## Exit And Cancellation Semantics

The barrier applies only to successful finalization.

The following paths must bypass it:

- Lead interruption or cancellation.
- Provider and processor errors.
- Structured-output errors.
- Compaction errors.
- Other existing unsuccessful termination paths.

Closing the team releases a parked lead regardless of stale member rows. Cancelling one member releases the barrier only when no other finite member remains nonterminal.

Lead cancellation must interrupt the parked lead before team shutdown can release it as a successful completion.

A cancelled dependency does not make a blocked dependent terminal; the lead remains parked until that dependent is cancelled, completed, or the team closes.

## Structured Output

Team mail continuation must preserve structured-output contracts:

- Synthetic mailbox user messages must retain the original user message's `format` and `system`.
- Captured structured output must be scoped or reset per provider turn.
- The barrier must run before committing `handle.message.structured`.
- If team mail requires continuation, discard the preliminary structured candidate.
- Require one fresh structured-output result after the handoff is integrated.

## Implementation Slices

### PR 1: Atomic Terminal Handoffs

- Refactor terminal persistence in `packages/opencode/src/team/team.ts`.
- Consolidate completion and cancellation notifications in `packages/opencode/src/tool/team_spawn.ts`.
- Preserve wake behavior without persisting duplicate messages.
- Terminalize every failure after member creation.
- Add idempotency, atomic visibility, failure, and rollback coverage in `test/team/team.test.ts`.
- Add setup-failure and single-notification coverage in `test/tool/team_spawn.test.ts`.

Verification from `packages/opencode`:

- `bun test test/team/team.test.ts`
- `bun test test/tool/team_spawn.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must review the PR diff against this slice and its tests. It must specifically challenge duplicate notifications, stranded `starting` members, transaction interruption, and wake preservation. Resolve all findings and rerun verification before marking the slice complete.

### PR 2: Private Finalization Barrier

- Add the event-backed barrier to `packages/opencode/src/session/prompt.ts`.
- Guard both successful-finalization paths through the same private helper.
- Preserve successful versus error exit distinctions.
- Preserve mailbox `format` and `system`.
- Reset structured-output candidates between provider turns.
- Ensure lead cancellation interrupts parking before shutdown releases it.
- Update affected fixtures that currently leave finite members in `starting`.

Deterministic tests in `test/session/prompt.test.ts` must cover:

- Mail arriving after the initial mailbox check.
- `starting`, `blocked`, `active`, and anomalous task `idle`.
- Completion and cancellation release.
- Cancelled dependency with a blocked dependent.
- Pending mail from an already-terminal teammate.
- Progress mail while a teammate remains active.
- Team closure and lead cancellation.
- Active and idle daemon exclusion.
- Two-turn structured output without stale reuse.
- Existing finished-assistant and current-processor exit paths.

Verification from `packages/opencode`:

- `bun test test/session/prompt.test.ts`
- `bun test test/tool/team_shutdown.test.ts`
- `bun test test/tool/team_messages.test.ts`
- `bun typecheck`

Review:

A new read-only teammate, different from the PR 1 reviewer, must adversarially review the diff. It must verify race-free event registration, listener cleanup, error-path bypass, daemon exclusion, cancellation ordering, and structured-output behavior before the slice is marked complete.

### PR 3: Align Team Waiting Guidance

- Replace "end this turn" guidance in `packages/opencode/src/tool/team_get_messages.ts` and `packages/opencode/src/tool/team_get_messages.txt` with automatic parking semantics.
- State in `packages/opencode/src/session/prompt.ts` guidance that leads must not finalize while finite teammates remain nonterminal.
- Correct bounded-wait descriptions in:
  - `packages/opencode/src/tool/team_send_message.txt`
  - `packages/opencode/src/tool/team_broadcast.txt`
  - `packages/opencode/src/tool/team_plan_decide.txt`
- Document the barrier and daemon exclusion in `packages/opencode/src/team/README.md`.
- Append follow-up slices to `specs/agent-team-reliability-improvements.md`; do not renumber its existing PR 1 through PR 5 plan.
- Update assertions in `test/tool/team_messages.test.ts`.

Verification from `packages/opencode`:

- `bun test test/tool/team_messages.test.ts`
- `bun typecheck`

Review:

A fresh read-only teammate must compare every description against the implemented behavior, especially one-second bounded wakes, progress-mail continuation, daemon exclusion, and error bypass. Resolve discrepancies before marking the slice complete.

## Future Work

Leave these out of the first pass:

- General queued-rerun semantics in `Runner`.
- A public `team_wait` tool.
- Cross-process team execution ownership.
- Team scheduler or daemon lifecycle redesign.
- A premature-finalization evaluation metric.

## Open Questions

- Should all progress mail resume the lead while finite work continues? Default: yes, preserving current mailbox semantics; the next finalization attempt parks again.
- Should explicit team closure override nonterminal member rows? Default: yes, because closure is the authoritative lifecycle boundary and prevents permanent parking.
