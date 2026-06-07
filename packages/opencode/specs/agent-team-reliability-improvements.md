# Agent Team Reliability Improvements

## Goal

Improve the experimental agent team feature by fixing the highest-risk coordination, authorization, and observability gaps found in the audit.

The first pass must focus on source-backed reliability fixes: mailbox delivery, wake behavior, task identity/authorization, teammate name ambiguity, plan-mode approval safety, and deterministic tests. Defer broad TUI polish and speculative evaluation features until the core tool/service behavior is reliable.

## Current State

- Core team state and services live in `packages/opencode/src/team/team.ts`.
- Team persistence tables live in `packages/opencode/src/team/team.sql.ts` and `packages/core/src/database/migration/20260511182000_team_tables.ts`.
- Team tools live under `packages/opencode/src/tool/team_*.ts`, including `team_create`, `team_spawn`, `team_send_message`, `team_get_messages`, `team_plan_submit`, `team_plan_decide`, `team_task_*`, `team_report`, and `team_shutdown`.
- Team prompt integration lives in `packages/opencode/src/session/prompt.ts`; pending mailbox messages are injected into sessions there.
- `Team.updateMemberStatus` inserts automatic member-status messages into `team_message`, but does not create `team_message_recipient` rows, so those messages are not deliverable via `team_get_messages`.
- `team_task_list` and `team_task_create` display short task IDs, while `team_task_claim` and `team_task_update` require full IDs.
- `Team.updateTask` and `Team.claimTask` mutate by task ID only and do not scope by current team.
- `team_task_update` does not enforce lead-or-assignee ownership.
- `team_task_create` accepts free-form `assignee` and arbitrary `dependency_ids`.
- Teammate names are not unique per team, but `team_spawn`, `team_send_message`, and `team_plan_decide` resolve by first matching name.
- `team_plan_decide` can approve a non-plan teammate and removes broad deny rules without proving those rules came from the plan-mode overlay.
- `team_wake.ts` intentionally calls `ops.wake` twice; this should be documented or replaced with an explicit idempotent wake path.
- HTTP team handlers in `packages/opencode/src/server/routes/instance/httpapi/handlers/team.ts` accept team IDs directly; ownership checks need to be explicit.
- HTTP task schema in `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts` omits stored task fields such as `assignee`, `dependency_ids`, and `metadata`.
- Existing tests cover core lifecycle, spawn dependencies, mailbox guardrails, reports, and evals in `packages/opencode/test/team` and `packages/opencode/test/tool`, but task tool wrappers, `team_send_message`, `team_plan_submit`, HTTP shutdown, and spawn cancellation are under-tested.

## Non-Negotiables

- Do not change non-team `task` subagent behavior except where team tools explicitly wake or prompt team sessions.
- Do not add a database migration unless service-level validation cannot solve the issue.
- Do not rely on LLM judgment for new checks; team report/eval additions must be deterministic.
- Do not broaden TUI or web UX scope in the first behavior-fix PRs.
- Preserve existing nested-team protections in `team_create.ts` and `team_spawn.ts`.
- Run tests from `packages/opencode`, not from the repo root.
- Before marking any implementation slice complete, a fresh read-only reviewer must inspect the diff against this spec and the slice checklist.

## Design

### Mailbox And Wake Semantics

- Automatic member-status notifications must create recipient rows for the intended recipient.
- `team_get_messages` must not allow concurrent reads to return the same pending message twice.
- Wake calls from lead tools must not block forever.
- The double-wake behavior in `team_wake.ts` must either be replaced with a named idempotent helper or documented and tested as intentional.
- Keep first-pass message state simple: if no explicit read action exists, report delivered/pending metrics instead of presenting impossible read counts.

### Task Identity And Authorization

Tool signatures remain stable:

```ts
team_task_claim({ task_id: string })
team_task_update({ task_id: string, status?: string, assignee?: string })
```

Behavior changes:

- `task_id` may be a full ID or an unambiguous prefix.
- Ambiguous prefixes must return a tool-level error listing matching prefixes, not mutate state.
- Claim/update must scope lookup by current `team.id`.
- Update must be allowed only for the lead session or the assigned teammate.
- Dependency IDs must resolve to tasks in the same team.
- Default dependency policy: only `completed` dependencies unblock claims; `cancelled` dependencies do not count as satisfied unless explicitly decided otherwise.

### Member Identity

- New teammate names must be unique within a team.
- Existing duplicate names must not crash tools.
- Name-based recipient/plan/dependency resolution must reject ambiguity and ask for a session ID.
- Session ID targeting remains authoritative.

### Plan Mode

- `team_plan_decide` must only approve or reject members that are currently in plan mode.
- Approval must remove only the permission deny overlay added by team plan mode.
- Approval should transition the member out of plan-only state in service-visible fields if those fields exist today.
- Rejection must keep plan-mode restrictions intact.
- `team_plan_submit` should remain a teammate-to-lead message path; adding usage events is optional unless report/eval needs them.

### HTTP And SDK Surface

- HTTP team handlers must check that the request is authorized for the team before returning tasks, messages, eval data, or shutting down.
- HTTP task response should expose task fields already persisted by `team_task`: `assignee`, `dependency_ids`, and `metadata`.
- If HTTP schema changes affect generated SDK types, regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts`.

### Docs To Update

- `packages/web/src/content/docs/agent-teams.mdx` should document task ID prefix behavior, teammate name uniqueness, and plan approval semantics.
- `packages/opencode/src/team/README.md` should document internal mailbox/wake/task invariants.
- `packages/web/src/content/docs/server.mdx` should be updated only if HTTP team response shapes change.

## Implementation Slices

### PR 1: Mailbox Delivery And Wake Safety

- Change automatic member-status notifications in `packages/opencode/src/team/team.ts` to create recipient rows or route through `sendMessage`.
- Make pending message delivery atomic so concurrent `team_get_messages` calls cannot return the same pending recipient row twice.
- Update `packages/opencode/src/tool/team_get_messages.ts` tests to cover duplicate-read prevention.
- Add or update tests for automatic member-status messages being visible through mailbox delivery.
- Add a bounded timeout or explicit non-blocking failure path around lead wake waits in `team_send_message.ts`, `team_broadcast.ts`, and `team_plan_decide.ts`.
- Document or replace the double-wake invariant in `packages/opencode/src/tool/team_wake.ts`.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/team/team.test.ts`
- `cd packages/opencode && bun test test/tool/team_messages.test.ts`
- `cd packages/opencode && bun test test/tool/team_spawn.test.ts`

Review:

Use a fresh read-only reviewer to verify that mailbox writes always create recipient rows, delivery claiming is atomic, wake waits are bounded, and existing lead/member async semantics are preserved.

### PR 2: Task ID, Dependency, And Authorization Discipline

- Update task lookup to accept full IDs or unambiguous prefixes within the current team.
- Scope `claimTask` and `updateTask` by team ID in `packages/opencode/src/team/team.ts`.
- Enforce `team_task_update` ownership: lead or assigned teammate only.
- Validate dependency IDs in `team_task_create` against tasks in the same team.
- Decide and implement dependency satisfaction semantics; default to `completed` only.
- Add direct tool tests for `team_task_create`, `team_task_list`, `team_task_claim`, and `team_task_update`.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/team/team.test.ts`
- `cd packages/opencode && bun test test/tool/team_messages.test.ts`

Review:

Use a fresh read-only reviewer to try adversarial task mutations: wrong team, wrong assignee, ambiguous prefix, nonexistent dependency, and cancelled dependency.

### PR 3: Member Name And Plan-Mode Safety

- Reject duplicate teammate names during `team_spawn` for the same active team.
- Reject ambiguous name resolution in `team_send_message`, `team_spawn` dependencies, and `team_plan_decide`.
- Require `team_plan_decide` targets to be current plan-mode members.
- Ensure approval removes only the plan-mode permission overlay.
- Add integration tests for `TeamPlanDecideTool` instead of duplicating permission-filter logic in tests.
- Add `team_plan_submit` tests for plan-mode member, non-member, and non-plan-mode member behavior.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/tool/team_spawn.test.ts`
- `cd packages/opencode && bun test test/tool/team_messages.test.ts`

Review:

Use a fresh read-only reviewer to verify duplicate-name behavior, ambiguous name errors, and plan approval/rejection permission transitions.

### PR 4: HTTP And Tool Surface Hardening

- Add explicit team ownership checks in `packages/opencode/src/server/routes/instance/httpapi/handlers/team.ts`.
- Extend `TeamTaskSchema` in `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts` with `assignee`, `dependency_ids`, and `metadata`.
- Add HTTP tests for get-by-team, tasks, messages, eval, and shutdown authorization.
- Add `team_shutdown` tool tests for disabled config, no active team, success, and member cancellation.
- Run registry tests if tool exposure changes.
- Regenerate SDK types if HTTP schema changes affect generated clients.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/server/httpapi-team.test.ts`
- `cd packages/opencode && bun test test/team/team.test.ts`
- `cd packages/opencode && bun test test/tool/registry.test.ts`
- `./packages/sdk/js/script/build.ts`

Review:

Use a fresh read-only reviewer to verify unauthorized team IDs cannot read or mutate team state and generated SDK changes match the HTTP schema change.

### PR 5: Deterministic Reporting, Eval, And Documentation

- Update `team_report` metrics so message delivery states reflect real transitions; do not report impossible `read` counts unless a real read transition is implemented.
- Add deterministic eval/report findings for the fixed failure modes where useful: ambiguous teammate names, stranded blocked members, pending mailbox rows, and missing final report.
- Keep `team_report` permission prompting behavior unchanged unless explicitly required.
- Replace fixed sleeps in team tests with readiness signals or bounded polling.
- Update `packages/web/src/content/docs/agent-teams.mdx`.
- Update `packages/opencode/src/team/README.md`.
- Update `packages/web/src/content/docs/server.mdx` only if HTTP response shape changed in PR 4.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/team/team-eval.test.ts`
- `cd packages/opencode && bun test test/tool/team_report.test.ts`
- `cd packages/opencode && bun test test/team/team.test.ts`

Review:

Use a fresh read-only reviewer to verify report/eval findings are deterministic, docs match implemented behavior, and no speculative UI promises were added.

## Future Work

- Add richer TUI rendering tests for team sidebar status, task/message tabs, pending permissions, and shutdown actions.
- Add resumable blocked-member scheduling after process restart.
- Add explicit `read` message state if a UI or API action needs to distinguish delivered vs read.
- Add foreign-key constraints or cleanup jobs for orphaned team rows if database compatibility allows it.
- Add context-aware tool exposure so teammates never see lead-only tools such as `team_shutdown` or `team_plan_decide`.

## Open Questions

- Should cancelled task dependencies unblock dependent tasks?
Default: no. Require `completed` dependencies only.
- Should task `assignee` remain a free-form label or become a session/member reference?
Default: keep free-form for creation, but require real session/member ownership for claim/update authorization.
- Should `team_plan_submit` record a usage event?
Default: leave out of first pass unless report/eval needs it.
- Should HTTP team authorization be session-based or workspace-wide?
Default: require the requester to be the lead session or a member session for that team.
