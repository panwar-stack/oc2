# Agent Team Reliability Medium-Severity Backlog

## Scope

This backlog records the validated medium-severity findings from the agent-team reliability audit. It excludes high- and low-severity findings.

## 1. Durable Wake Intent Loss

**Evidence**

- `packages/core/src/session/control.ts` (`requestResume`, `finishResume`): resume requests are durable, but `finishResume` deletes a generation ticket.
- `packages/opencode/src/session/prompt.ts` (`SessionPrompt.wake`): the ticket is deleted before a new run completes, or when the wake attaches to an existing run.
- `packages/opencode/src/tool/team_wake.ts` (`wakeTeamSession`): wake outcomes are ignored and do not provide a recovery path.

**Impact**

A crash or failed run after ticket deletion can leave pending work without an active run or a durable resume intent. A team session can remain asleep until unrelated work wakes it.

**Acceptance criteria**

- A wake intent remains recoverable until a run durably adopts or completes its work.
- A failed or interrupted run restores or preserves unacknowledged demand.
- Restart reconciliation schedules each runnable intent once logically and tolerates duplicate physical attempts.
- Regression tests cover a crash or failure after scheduling and before work adoption.

## 2. Mailbox Delivered-Before-Message Crash Gap

**Evidence**

- `packages/opencode/src/team/team.ts` (`claimPendingMessages`, `releaseClaimedMessages`, `markMessageDelivered`): mailbox rows move from `pending` to `read` to `delivered`; cleanup only restores `read` rows.
- `packages/opencode/src/session/prompt.ts` (`deliverTeamMessages`): delivery is marked before the synthetic user message and text part are persisted.
- `packages/opencode/src/tool/team_get_messages.ts`: the tool marks messages delivered before its result is persisted by the surrounding tool flow.

**Impact**

A crash after the delivery marker and before recipient-visible persistence can permanently remove a message from future mailbox reads without adding it to the conversation.

**Acceptance criteria**

- Delivery acknowledgement and recipient-visible persistence are atomic, or use an idempotent durable inbox or outbox record.
- A crash before visible persistence leaves the message reclaimable.
- Recovery produces one logical message without loss or duplicate visible injection.
- A regression test covers the boundary between delivery acknowledgement and message persistence.

## 3. Concurrent Duplicate Member Names

**Evidence**

- `packages/opencode/src/tool/team_spawn.ts`: name uniqueness uses a read-before-write check before child session creation.
- `packages/opencode/src/team/team.ts` (`addMember`): the authoritative transaction inserts a member without repeating the name check.
- `packages/opencode/src/team/team.sql.ts`: member indexes do not enforce uniqueness for `(team_id, name)`.
- `packages/opencode/test/tool/team_spawn.test.ts`: current coverage checks sequential duplicate creation, not concurrent creation.

**Impact**

Two concurrent spawns can commit the same name. Name-based recipient and dependency resolution then becomes ambiguous, and a losing spawn flow can leave an extra child session.

**Acceptance criteria**

- At most one canonical member name commits per team under concurrent requests.
- The invariant is enforced by the database or the authoritative immediate transaction.
- The losing request returns a stable duplicate-name error and leaves no orphan child session or member.
- A simultaneous same-name spawn test proves the race is closed.

## 4. Real Failures Rewritten To Cancelled

**Evidence**

- `packages/opencode/src/session/lifecycle-reconciler.ts` (`settleMember` call sites and retry exhaustion): provider errors, error results, empty results, and missing handoffs can persist `cancelled` with a failure code.
- `packages/opencode/src/tool/team_spawn.ts` (`terminalizeCancelled` and spawn exit handling): setup defects after member creation are terminalized as `cancelled`.
- `packages/opencode/src/team/team.sql.ts` and `packages/opencode/src/team/eval.ts`: `failed` is a distinct stored status with distinct evaluation behavior.

**Impact**

Reports, notifications, APIs, and the TUI cannot reliably distinguish explicit cancellation from execution failure. Failure metrics are understated and cancellation metrics are inflated.

**Acceptance criteria**

- Provider errors, setup defects, exhausted empty results, and missing required handoffs persist `failed` with an applicable failure code.
- Only explicit user or system cancellation persists `cancelled`.
- Cleanup of owned tasks and blocked descendants remains correct for failed members.
- Tests, reports, notifications, and TUI labels distinguish failed and cancelled terminal states.

## 5. Post-Shutdown Event Failure Skips Run Cancellation

**Evidence**

- `packages/opencode/src/team/team.ts` (`shutdown`): the close transaction commits, then unprotected member, team, and toast events publish before `runState.cancel` is called.
- `packages/opencode/src/team/team.ts` (`safePublish`): a best-effort event helper exists but is not used by this shutdown sequence.

**Impact**

An event publication failure can leave the team durably closed while underlying member runs continue. The caller also receives no stable shutdown result for the committed operation.

**Acceptance criteria**

- After the close transaction commits, every target run cancellation is attempted regardless of event failures.
- Post-commit event failures are best-effort or are collected without short-circuiting cancellation.
- The shutdown result reports actual cancellation failures and does not hide skipped attempts.
- A failing-event regression test proves that closure commits and all run cancellations are attempted.

## 6. Nullable Task-Handoff OpenAPI And SDK Mismatch

**Evidence**

- `packages/opencode/src/team/team.ts` (`Task`, `createTask`, `getTask`): `handoff` is required but can be `null`.
- `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts` (`TeamTaskSchema`): the source endpoint schema uses `Schema.NullOr(TeamTaskHandoffSchema)`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/team.ts` (`getTasks`): the handler serializes `handoff`, including `null`.
- `packages/sdk/openapi.json`: the generated `handoff` property contains only the handoff reference.
- `packages/sdk/js/src/v2/gen/types.gen.ts` (`TeamTask`): the generated type is non-nullable.

**Impact**

Normal pending-task responses can violate the published contract. Generated SDK users and validators can treat a runtime `null` as a non-null handoff.

**Acceptance criteria**

- OpenAPI represents `handoff` as `TeamTaskHandoff | null` with a generator-supported form.
- The generated TypeScript type is `handoff: TeamTaskHandoff | null`.
- A pending-task response with `"handoff": null` validates against the generated contract.
- Contract-generation coverage prevents nullable references from losing their null branch.

## 7. TUI False Success On Shutdown Errors

**Evidence**

- `packages/tui/src/component/dialog-team.tsx`: the shutdown dialog clears in `.then(...)` without checking the response for an error.
- `packages/sdk/js/src/v2/gen/sdk.gen.ts` and `packages/sdk/js/src/v2/gen/client/client.gen.ts`: generated calls default to `throwOnError: false`, so HTTP errors can resolve instead of reject.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/team.ts` (`shutdown`): expected shutdown rejections return HTTP 400.

**Impact**

The TUI can close the dialog as if shutdown succeeded while the team remains active. The user receives no actionable information about authorization, final-report, closed-team, or force-reason errors.

**Acceptance criteria**

- The dialog closes only after a successful shutdown response.
- The call uses `throwOnError: true` or explicitly checks `response.error`.
- An error keeps the dialog open and shows actionable feedback.
- A TUI test proves that an HTTP 400 does not trigger the success transition.

## 8. TUI Missing Persisted Member-State Hydration

**Evidence**

- `packages/tui/src/context/sync.tsx`: `team_member_status` starts empty and is populated only by live `team.member.updated` events; bootstrap does not load persisted members.
- `packages/tui/src/component/dialog-team.tsx` and `packages/tui/src/feature-plugins/sidebar/team.tsx`: views derive members from child sessions and fall back to `idle` when team state is absent.
- `packages/tui/src/component/prompt/index.tsx`: teammate-working state depends on entries in the event-populated map.
- `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts`: a member schema exists, but the team API does not expose a member-list endpoint.

**Impact**

After restart or reconnect, completed, failed, cancelled, blocked, starting, and daemon states can display incorrectly until a new event arrives. Working-state calculations can also omit active teammates.

**Acceptance criteria**

- A persisted team-member read model is available and loads during TUI bootstrap and reconnect.
- Hydration and live events use ordering or version rules so stale responses cannot replace newer state.
- Persisted status, lifecycle, and daemon state display correctly without a new event.
- Restart and reconnect tests cover active, blocked, completed, failed, cancelled, and daemon members.
