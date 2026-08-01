# Deterministic Agent-Team Orchestration

## Goal

Harden agent-team orchestration so a lead can trust finite-member results, task ownership, handoff evidence, team lifecycle, and shutdown order. Keep one active team per lead session. Use fresh reviewer sessions inside that team instead of creating a second concurrent team.

Deliver the work as small runtime slices. Prompt guidance must describe the runtime contract, but prompt compliance must not be the only control for result settlement, structured-file collision prevention, or shutdown admission.

This spec extends, but does not replace:

- `specs/team-lead-finalization-barrier.md`: its atomic terminal handoff and lead exit barrier are prerequisites for the final-report and shutdown slices here.
- `specs/structured-team-handoffs.md`: this spec adds only a narrow terminal handoff for owned tasks. It does not supersede the broader plan and multi-recipient handoff model.

## Current State

- `packages/opencode/src/team/team.sql.ts` has a partial unique index for one active team per `lead_session_id`. This is not a project-wide or worktree-wide team limit.
- `packages/opencode/src/team/team.ts` prechecks for an active team, but `packages/opencode/src/tool/team_create.ts` converts the expected conflict to a defect with `Effect.orDie`.
- `packages/opencode/src/session/lifecycle-reconciler.ts` takes only the last text part from a live teammate result. Restart recovery reads parts without a stable order and also takes the last text part.
- `assistantResult` in `packages/opencode/src/session/lifecycle-reconciler.ts` treats any finish value as terminal. The main prompt loop in `packages/opencode/src/session/prompt.ts` treats `tool-calls` and `unknown` as nonterminal.
- A finite teammate can settle as `completed` with `result = ""`. The caller and automatic mailbox handoff then show `(no text result)`.
- `team_send_message` can wake a completed child session, but reconciliation skips completed members. The new turn does not replace the canonical result or rerun dependency settlement.
- Mailbox claim and delivery are transactional and pause-safe in `packages/opencode/src/team/team.ts` and `packages/opencode/src/session/prompt.ts`. Manual handoff bodies are still free-form.
- Child sessions share `ctx.directory` and `ctx.worktree`. Shared tasks have no durable file scope, and `write`, `edit`, and `apply_patch` do not consult task ownership.
- `team_report` records a report event, but the event is not bound to a team-state revision. Shutdown does not require a current final report.
- Tool shutdown is lead-only, but the Team HTTP shutdown handler allows team members. Authorization is not consistent across surfaces.

## Non-Negotiables

- Preserve the partial unique index as the race-safe one-active-team-per-lead guard.
- Empty, whitespace-only, synthetic-only, ignored-only, and tool-only finite results must not be successful completion. Daemon idle output is exempt.
- Live settlement and restart reconciliation must use the same terminal-result extractor.
- A plain mailbox message must not reopen a terminal finite member. General completed-member resume is out of scope.
- Use database transactions, compare-and-set updates, stable IDs, and event-backed barriers. Do not use fixed sleeps in tests.
- Existing protocol-0 teams and tasks must remain readable. Do not retroactively require file ownership or task handoffs for them.
- File ownership v1 covers exact files through `write`, `edit`, and `apply_patch` inside one running project instance. It does not claim full enforcement for shell, plugin, MCP, formatter, external-process, or cross-process writes.
- The lead-only Git rule is protocol guidance until shell or process-level enforcement exists. Do not describe it as a complete runtime guarantee.
- Before any implementation slice is complete, a fresh read-only teammate must review that slice's diff against this spec and its verification results.

## Deterministic Runtime Contract

### Canonical Finite Result

Use one helper from both live settlement and restart reconciliation.

An assistant message is eligible only when:

- It belongs to the admitted prompt message.
- It has no assistant error.
- Its finish reason exists and is neither `tool-calls` nor `unknown`, matching the successful-finalization rule in `packages/opencode/src/session/prompt.ts`.

For an eligible message:

1. Load parts in `PartTable.id ASC` order.
2. Keep only text parts where `synthetic !== true` and `ignored !== true`.
3. Join their text with `\n`.
4. Apply `trim()` once to the joined value.
5. Treat a blank result as invalid.

An assistant error is a failed attempt, not a blank result. Intermediate `tool-calls` and `unknown` messages are not terminal facts.

### Finite Run Generation And Retry

Add the following persisted facts:

```ts
type TeamProtocolVersion = 0 | 1

type MemberRunPhase = "running" | "retry_admitted" | "retry_running" | "terminal"

type MemberFailureCode = "empty_result" | "provider_error" | "dependency_failed" | "missing_task_handoff"
```

- `team.protocol_version INTEGER NOT NULL DEFAULT 0`
- `team_member.run_generation INTEGER NOT NULL DEFAULT 0`
- `team_member.failure_code TEXT NULL`
- Member status `failed`, which is terminal for finite members.
- Session lifecycle metadata with `memberID`, `generation`, `promptMessageID`, and `phase`.

Do not set `protocol_version = 1` until the finite-result, ownership, report, and shutdown gates that depend on it are all deployed. During incremental delivery, use feature-specific schema presence and behavior flags in tests. The final rollout slice switches new teams to protocol 1.

Finite attempts are bounded to two:

| Current fact               | Input                                     | Durable transition                                | Side effects after commit                             |
| -------------------------- | ----------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Generation 1, running      | Valid terminal result                     | `completed`, terminal metadata                    | Unblock dependents, wake lead                         |
| Generation 1, running      | Blank terminal result                     | Generation 2, `retry_admitted`, new prompt ID     | Start one completion-only prompt                      |
| Generation 1, running      | Valid result but owned task lacks handoff | Generation 2, `retry_admitted`, new prompt ID     | Start one completion-only prompt                      |
| Generation 2, running      | Valid terminal result                     | `completed`, terminal metadata                    | Unblock dependents, wake lead                         |
| Generation 2, running      | Blank terminal result                     | `failed(empty_result)`, terminal metadata         | Cancel blocked descendants, wake lead                 |
| Generation 2, running      | Owned task still lacks handoff            | `failed(missing_task_handoff)`, terminal metadata | Cancel owned tasks and blocked descendants, wake lead |
| Any running generation     | Provider/session error                    | `failed(provider_error)`, terminal metadata       | Cancel blocked descendants, wake lead                 |
| Any generation             | Stale generation or prompt ID             | No change                                         | None                                                  |
| Any nonterminal generation | Explicit cancel or shutdown               | `cancelled`, terminal metadata                    | Cancel blocked descendants as required                |

Retry admission must be crash-safe:

1. In one immediate transaction, compare member status, current generation, and prompt ID; allocate generation 2; persist `retry_admitted` and the new prompt ID.
2. After commit, call the prompt path with the same persisted prompt ID and the same child session.
3. The retry prompt allows only the task-handoff update and final text. It must not expose file mutation, shell, plugin, MCP, or other general tools.
4. After prompt admission, persist `retry_running` with compare-and-set semantics.
5. If the process stops before prompt admission, reconciliation reuses the persisted prompt ID and admits it once.
6. If the process stops after admission, reconciliation joins or observes that same prompt. It must not add another user prompt.
7. If the terminal assistant message exists but settlement did not commit, reconciliation extracts and settles the same generation once.

Generation 0 means "not admitted." New finite members move from 0 to 1 when the initial prompt ID is persisted. For an existing protocol-0 nonterminal member, reconciliation performs one compare-and-set adoption from 0 to 1 using its current persisted prompt ID; it does not create a new user prompt. An already-terminal legacy member is never adopted or retried.

Use generation-specific deterministic notification IDs. A stale attempt must not change a member, task, mailbox row, dependency, team revision, or wake state.

Terminal failure is one immediate transaction. It must persist the failed member result and code, terminal session metadata, one canonical lead message and recipient row, recursively cancelled blocked descendants, cancelled owned tasks and released reservations, and one team-revision increment. Publish events, schedule dependents, and wake the lead only after commit. Completion uses the same atomic terminal-handoff boundary required by `specs/team-lead-finalization-barrier.md`.

When a finite member fails, recursively cancel its still-blocked finite descendants with `failure_code = "dependency_failed"` and a stable reason naming the failed dependency. Do not leave an unreachable blocked graph. Active independent members continue.

Every status consumer must recognize `failed` as terminal, including lifecycle terminal sets, session control/finalization, shutdown, report/eval, events, HTTP/SDK schemas, and both TUI status renderers.

### Terminal Recipient Rule

- `team_send_message` must reject `completed`, `cancelled`, and `failed` finite recipients with a stable error.
- `idle` daemon recipients remain valid.
- A lead that needs more evidence from terminal work must inspect the mailbox and worktree, then spawn a fresh read-only reviewer in the same active team.
- Do not describe `team_send_message` as completed-member resume.

### Active Team Conflict

Add `Team.ActiveTeamConflict` as a typed expected error with `leadSessionID` and existing `teamID`.

- Keep the database unique index as the final race guard.
- Make concurrent creates return one success and one typed conflict.
- `team_create` must return stable `Team Create Failed` output with the existing team identity and instructions to reuse or shut down that team.
- Duplicate create must not create a second row or become a defect.

### Exact-File Collision Reservations

This feature is an exclusive reservation system for structured file tools. It is not a complete filesystem sandbox.

Add a Core-owned table because Core Drizzle scans only `packages/core/src/**/*.sql.ts`:

```ts
type TeamFileOwnership = {
  id: string
  team_id: string
  task_id: string
  root_key: string
  path_key: string
  display_path: string
  owner_session_id: string | null
  time_released: number | null
  time_created: number
  time_updated: number
}
```

- Use a partial unique index on active `path_key`, not `(team_id, path_key)`. Separate lead sessions can own different teams in the same worktree.
- Add indexes for `(team_id, task_id)` and `(team_id, owner_session_id, time_released)`.
- Preserve released rows for audit.

`team_task_create` gains `owned_paths?: string[]`. Protocol-v1 owned tasks must omit the free-form `assignee`; the owner is bound by `team_task_claim` from authoritative `ctx.sessionID`.

Use one canonicalizer for reservation and mutation checks:

1. Resolve with `ToolPath.resolveWithSession`, including its registered-root selection.
2. Store the selected canonical root identity in `root_key`.
3. For an existing target, use realpath.
4. For a missing target, realpath the nearest existing ancestor and append normalized missing segments.
5. Verify the canonical target remains inside the canonical selected root. Reject symlink escape.
6. Reject `.git` path segments and duplicate aliases.
7. Normalize separators to `/`.
8. Case-fold on Windows and macOS. This is conservative on a case-sensitive macOS volume but prevents unsafe alias ownership.
9. Store a stable root-relative display path separately from the canonical absolute key.

Accept exact files only. Directory and glob claims are future work.

### Owned Task State And Handoff

Owned-task invariants must live in `packages/opencode/src/team/team.ts`, not only in tool wrappers.

```ts
team_task_create({
  description: string,
  assignee?: string,
  dependency_ids?: string[],
  owned_paths?: string[],
})

team_task_update({
  task_id: string,
  status?: "pending" | "in_progress" | "completed" | "cancelled",
  assignee?: string,
  handoff?: {
    summary: string
    changed_paths: string[]
    verification: Array<{
      command: string
      status: "passed" | "failed" | "not_run"
      detail?: string
    }>
    risks?: string[]
  }
})
```

State rules:

- An owned task is a task created with a nonempty `owned_paths` array and at least one active or released reservation row. An empty or omitted array creates a legacy unowned task.
- Keep the existing public `assignee` and status inputs for protocol-0 and unowned tasks. Apply the stricter transition rules below only when the task is owned.
- Create the pending task and all reservations in one immediate transaction. Any conflict rolls back the full operation.
- Only `team_task_claim` may transition an owned task from `pending` to `in_progress`. It binds all reservations to `ctx.sessionID` in the same transaction.
- An owned task cannot transition directly from `pending` to `completed`.
- Do not reassign an in-progress owned task. The lead may cancel it and create a replacement task.
- Only the authoritative owner can complete an owned task. The owner or lead can cancel it.
- Completion requires a nonblank structured handoff. Canonical `changed_paths` must be a subset of reserved paths.
- Store the v1 terminal handoff in `team_task.metadata.handoff`; complete the task and release reservations in one transaction.
- Cancellation releases reservations without a handoff.
- A finite member cannot settle `completed` while it owns an in-progress task. The first such result enters the bounded completion retry with `missing_task_handoff`; a second invalid result fails the member and cancels its owned tasks.
- Member dependencies and shared-task dependencies remain separate graphs. Member settlement checks owned-task terminal state but does not infer task dependency edges.
- List tasks in `time_created, id` order and return authoritative `owned_paths` plus handoff metadata.

### Structured Tool Write Lease

Add `packages/opencode/src/team/file-ownership.ts` with canonicalization, reservation, and `withWriteLease(sessionID, paths, effect)`.

- Acquire in-process keyed locks for every canonical path in sorted order before the ownership check.
- Task creation and reservation insertion must acquire the same sorted path locks before the conflict check and hold them through commit.
- Verify all active reservations inside the lock.
- Hold all locks through permission checks and the complete mutation.
- Task release or cancellation must acquire the same sorted locks before changing reservation state.
- An active reservation with no owner or another owner denies the mutation.
- The owner succeeds. A protocol-0 or unreserved path remains allowed for compatibility.
- `apply_patch` must resolve and lock every source and move destination before one permission request. One denied path makes the patch write nothing.
- Perform ownership checks before permission and mutating I/O. Path resolution and realpath are read I/O.

This lease closes the check-to-release race inside one running project instance and serializes same-path structured writes. Cross-process writers and tools outside `write`, `edit`, and `apply_patch` remain out of scope.

### Revision-Bound Final Report

Add:

- `team.revision INTEGER NOT NULL DEFAULT 0`
- `team.final_report_revision INTEGER NULL`

Increment revision once per logical transaction that changes:

- Member creation, generation, lifecycle status, terminal result, or failure.
- Shared-task creation, claim, status, ownership, or handoff.
- File reservation or release.
- Logical team-message creation, including progress or blocker mail.

Do not increment for message claim, delivery, read state, wake state, the report event itself, or shutdown's terminal close transaction.

`team_report({ final: true })` must be lead-only and must:

1. Reject if any finite member is nonterminal.
2. For a protocol-v1 team, reject if any task belonging to that team is `pending` or `in_progress`. Protocol-0 teams do not use the final-report shutdown gate.
3. Allow terminal `failed` members, but include them as deterministic findings.
4. Allow idle daemons. Reject starting or active daemons.
5. Build the report at revision N.
6. In one immediate transaction, compare active status and revision N, set `final_report_revision = N`, then insert `report_generated` metadata `{ revision: N, final: true, stale: false }`.
7. If state changes during report construction, return a stale/interim report and create no final checkpoint or final event.

Any later material mutation increments revision and invalidates the checkpoint.

### Shutdown Admission And Forced Abort

Require lead authorization in the service, tool, and Team HTTP handler.

Normal protocol-v1 shutdown must, in one immediate transaction:

1. Compare team status `active`.
2. Compare `final_report_revision === revision`.
3. Close the team.
4. Cancel any remaining nonterminal daemon/member rows allowed by the checkpoint policy.
5. Cancel nonterminal tasks and release reservations.

The checked revision covers all pre-shutdown work. The close transaction does not increment revision. Publish events and cancel session runs only after commit. Return stable counts and per-session cancellation failures without reopening durable team state.

Add `team_shutdown({ force?: boolean, reason?: string })`:

- `force: true` is lead-only and requires a nonblank reason.
- It bypasses the report checkpoint for a wedged or explicitly abandoned team.
- It records a deterministic forced-shutdown event/finding and uses the same atomic close/cancel/release transaction.
- It must not become the normal completion path.

Preserve unread mailbox rows for audit. Reject new messages after close.

## Protocol Guidance

### Lead

- Reuse the current active team. Do not create another team for review.
- Create shared tasks before mutation and reserve disjoint exact files.
- Use fresh read-only reviewer sessions in the same team after implementation.
- Treat an empty result as untrusted runtime failure, not proof that no work occurred.
- Check mailbox once and inspect `git status --short` plus the focused diff before deciding whether work exists.
- Keep Git staging, commit, branch, stash, reset, restore, clean, rebase, push, and PR operations in the lead session.
- Run a current final report immediately before normal shutdown.

### Teammate

- Kick off with task ID, intended exact files, expected handoff, and planned checks.
- Claim the shared task before mutation.
- Stop on ownership conflict or unexpected concurrent change. Notify the lead and affected teammate before more mutation.
- Do not overwrite or revert another participant's work.
- Do not run whole-worktree Git mutation commands.
- Complete the owned task with structured handoff evidence, send a mailbox summary, and return a nonblank final result.

## Implementation Slices

### PR 1: Canonical Terminal Result Extraction

- Add one terminal-result extractor in `packages/opencode/src/session/lifecycle-reconciler.ts`.
- Align terminal finish reasons with `packages/opencode/src/session/prompt.ts`.
- Order restart parts by `PartTable.id ASC`.
- Exclude synthetic and ignored text; join remaining text with `\n` and trim.
- Keep current status behavior in this slice; only make live and restart extraction deterministic.

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/session/lifecycle-reconciler.test.ts test/tool/team_spawn.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must audit live/restart equivalence, terminal finish reasons, tool-only turns, trailing blank text, intermediate tool calls, synthetic/ignored parts, and stable part ordering.

### PR 2: Failed Member State And Propagation

- Add `team.protocol_version DEFAULT 0`, member `failed`, and `failure_code` with one manual additive Core SQL migration, TypeScript wrapper, SQL/snapshot artifact, and `migration.gen.ts` registration. Do not rely on Core Drizzle to scan `packages/opencode/src/team/team.sql.ts`.
- Treat `failed` as terminal in lifecycle, session control/finalization, shutdown, report/eval, events, HTTP/SDK, and both TUI renderers.
- Add deterministic cancellation of blocked descendants after upstream failure.
- Keep new teams on protocol 0.

Verification from `packages/core`:

- `bun run script/migration.ts --check`
- `bun test test/database-migration.test.ts`
- `bun run typecheck`

Verification from repository root:

- `./packages/sdk/js/script/build.ts`
- `bun run --cwd packages/sdk/js typecheck`
- `bun run --cwd packages/tui typecheck`
- `bun run check:generated`
- `bun run check:packages`

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/team/team.test.ts test/tool/team_spawn.test.ts test/tool/team_shutdown.test.ts test/team/team-eval.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must search every status consumer and challenge failure propagation, daemon exclusion, TUI output, migration compatibility, and generated clients.

### PR 3: Generation-Safe Bounded Retry

- Add `run_generation` and generation/phase session metadata with a manual additive Core migration.
- Implement one completion-only retry in the same session with a persisted prompt ID.
- Make every crash window recover the same generation without duplicate prompt admission.
- Suppress stale settlement and use generation-specific notification IDs.
- Adopt existing nonterminal generation-0 members without creating a new prompt; start new finite members at generation 1.
- Persist failed-member notification, descendant cancellation, owned-task cancellation, reservation release, and revision update in one terminal transaction before events or wakes.
- Add the missing-task-handoff hook but leave it disabled until owned tasks exist.

Verification from `packages/core`:

- `bun run script/migration.ts --check`
- `bun test test/database-migration.test.ts`
- `bun run typecheck`

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/session/lifecycle-reconciler.test.ts test/tool/team_spawn.test.ts test/session/run-state-suspend.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must audit the transition table, completion-only tool allowlist, concurrent retry admission, pause/cancel/shutdown races, every crash window, stale-result suppression, and exactly-once mailbox/wake effects.

### PR 4: Active-Team And Terminal-Recipient Errors

- Add typed `ActiveTeamConflict` handling in `packages/opencode/src/team/team.ts` and `packages/opencode/src/tool/team_create.ts`.
- Preserve the unique index and return the existing team identity.
- Reject messages to terminal finite members; keep idle daemon messaging.
- Update tool descriptions and error tests.

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/team/team.test.ts test/tool/team_create.test.ts test/tool/team_messages.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must use controlled barriers or two database handles to challenge concurrent create, confirm one active row, and verify that terminal messaging cannot create untracked lifecycle work.

### PR 5: Exact-File Reservation Schema And Task Invariants

- Add `packages/core/src/team/ownership.sql.ts`.
- Generate SQL/snapshot, TypeScript wrapper, and registry changes with `bun run script/migration.ts --name team_file_ownership` from `packages/core`.
- Add canonical path resolution and global active-path conflict handling.
- Add `owned_paths` to task creation/listing.
- Enforce owned-task state transitions, authoritative claim identity, stable ordering, and atomic reservation/claim/release in the service.
- Preserve existing `assignee` and status inputs for protocol-0 and unowned tasks.
- Do not add file-tool guards yet.

Verification from `packages/core`:

- `bun run script/migration.ts --name team_file_ownership`
- `bun run script/migration.ts --check`
- `bun test test/database-migration.test.ts`
- `bun run typecheck`

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/team/team.test.ts test/tool/team_tasks.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must audit canonical aliases, missing targets, symlink escape, cross-team same-worktree conflict, different-worktree isolation, service-level authorization, transition bypasses, transaction rollback, and stable output ordering.

### PR 6: Structured Write Lease And Owned-Task Handoff

- Add `packages/opencode/src/team/file-ownership.ts` and sorted multi-path locking.
- Guard `write`, `edit`, and `apply_patch` through the full structured mutation.
- Add structured handoff validation to owned-task completion.
- Prevent member completion while owned work remains in progress; enable the PR 3 missing-handoff retry path.
- Return `owned_paths` and handoff metadata through Team HTTP and SDK output.

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/tool/team_tasks.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts test/server/httpapi-team.test.ts`
- `bun run typecheck`

Verification from repository root:

- `./packages/sdk/js/script/build.ts`
- `bun run --cwd packages/sdk/js typecheck`
- `bun run check:generated`
- `bun run check:packages`

Review:

A fresh read-only teammate must audit sorted lock acquisition, release races, wrong-owner denial before permission and mutation, all-or-nothing patch/move behavior, task/member terminal coupling, legacy unreserved behavior, and the stated shell/plugin/cross-process limits.

### PR 7: Revision-Bound Final Report

- Add `revision` and `final_report_revision` with a manual additive Core migration.
- Increment revision once for each listed material transaction.
- Make `team_report({ final: true })` lead-only and reject nonterminal members/tasks under the stated daemon policy.
- Build before recording; use revision CAS; record only successful final checkpoints.
- Keep new teams on protocol 0.

Verification from `packages/core`:

- `bun run script/migration.ts --check`
- `bun test test/database-migration.test.ts`
- `bun run typecheck`

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/tool/team_report.test.ts test/team/team-eval.test.ts test/tool/team_messages.test.ts`
- `bun run typecheck`

Review:

A fresh read-only teammate must enumerate every revision source, verify one increment per logical transaction, and use controlled barriers to challenge report construction, message creation, terminal settlement, and stale-checkpoint races.

### PR 8: Shutdown Admission And Forced Abort

- Require lead authorization in service, tool, and HTTP shutdown paths.
- Gate normal shutdown on the current final-report revision.
- Add explicit forced shutdown with a required reason and deterministic finding.
- Close team/member/task/ownership state atomically; publish and cancel runs after commit.
- Switch new teams to protocol 1 only after PRs 1 through 7 and the prerequisite lead finalization barrier are deployed.

Verification from `packages/core`:

- `bun run script/migration.ts --check`
- `bun test test/database-migration.test.ts`
- `bun run typecheck`

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/tool/team_shutdown.test.ts test/server/httpapi-team.test.ts test/session/prompt.test.ts test/team/team.test.ts`
- `bun run typecheck`

Verification from repository root:

- `./packages/sdk/js/script/build.ts`
- `bun run --cwd packages/sdk/js typecheck`
- `bun run check:generated`
- `bun run check:packages`

Review:

A fresh read-only teammate must use controlled barriers to challenge authorization, report/shutdown CAS, post-close settlement, forced-abort audit, task/claim release, unread-mail preservation, session-cancel failures, and replacement-team creation.

### PR 9: Protocol And Documentation Alignment

- Update lead guidance in `packages/opencode/src/session/prompt.ts`.
- Update teammate guidance in `packages/opencode/src/session/lifecycle-reconciler.ts`.
- Update team tool `.txt` descriptions, `packages/opencode/src/command/template/use-team.txt`, and `packages/opencode/src/team/README.md`.
- Document one active team per lead session, same-team review phases, terminal recipient rejection, file reservation boundaries, structured handoff, lead-owned Git operations, final report, and forced abort.
- Do not claim runtime control for shell, plugin, MCP, formatter, external-process, or cross-process writes.

Verification from `packages/opencode`:

- `bun test --timeout 30000 test/session/prompt.test.ts test/tool/team_spawn.test.ts test/tool/team_messages.test.ts test/tool/shell.test.ts`
- `bun run docs:check`
- `bun run typecheck`

Review:

A fresh read-only teammate must compare every prompt and document claim with the shipped runtime behavior and reject any statement that overstates ownership, Git, resume, mailbox, or shutdown guarantees.

## Future Work

- General `team_resume` with generation history and explicit result replacement rules.
- Directory and glob reservations, ownership transfer, and cross-team scope UI.
- Shell, plugin, MCP, formatter, and external-process filesystem sandboxing.
- Cross-process file-operation leases and optimistic content hashes.
- First-class progress, blocker, review, and multi-recipient handoff records from `specs/structured-team-handoffs.md`.
- Verified command-output capture instead of teammate-reported verification evidence.
- Pending-mailbox archive and expiry policy after shutdown.

## Open Questions

- Should a failed finite member permit a normal final report after blocked descendants are cancelled? Default: yes. The report must contain deterministic failure findings.
- Should macOS canonical keys always be case-folded? Default: yes for v1 safety, even though this can create a conservative false conflict on a case-sensitive volume.
- Should forced shutdown remain a tool/API operation or be service-only for the first release? Default: expose it to the lead with a required reason so wedged teams have a deterministic exit.
