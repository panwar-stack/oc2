# Daemon Teammates

## Goal

Add first-class daemon teammates to agent teams: long-lived team members that remain active for the team lifecycle and continuously pursue an open-ended assignment provided by the lead.

Daemon teammates are a lifecycle primitive, not a domain-specific watcher feature. The lead defines the daemon's eternal task in `role_prompt`, and the daemon uses its normal available tools plus team mailbox communication to perform that task until the team is shut down or the daemon is explicitly cancelled.

Examples:

- Observe logs and report actionable errors.
- Monitor test output and notify the lead on failures.
- Periodically inspect repo state for risky changes.
- Track a running server's health.
- Watch team mailbox traffic and summarize coordination risks.
- Maintain a rolling integration checklist during a multi-agent refactor.

## Current State

- Agent team docs in `packages/web/src/content/docs/agent-teams.mdx` describe teammates as background child sessions that coordinate with mailbox messages.
- `packages/opencode/src/tool/team_spawn.ts` starts a child session, waits for the teammate prompt to finish, stores the final text result, marks the member `completed`, and notifies the lead.
- `packages/opencode/src/tool/team_spawn.txt` explicitly says the spawn call waits for the teammate's current run to finish.
- `packages/opencode/src/team/team.sql.ts` stores `team_member.status` as `starting`, `blocked`, `active`, `idle`, `completed`, or `cancelled`, but does not distinguish finite task workers from long-lived members.
- `packages/opencode/src/tool/team_send_message.ts`, `team_broadcast.ts`, and `team_wake.ts` already provide bidirectional mailbox delivery and wake behavior.
- `packages/opencode/src/team/team.ts` shuts down a team by closing the team, cancelling non-terminal members, and cancelling member sessions through `SessionRunState`.
- `packages/opencode/src/tool/task.ts` has experimental background subagents, but they are still finite jobs that eventually inject a completion or error result.
- There is no first-class teammate mode that remains active until `team_shutdown`, carries a durable assignment, or treats idle as the normal state between work cycles.

## Non-Negotiables

- Do not ship log watching, command watching, timers, or any other specific trigger provider as part of the core daemon implementation.
- Do not implement daemon behavior as an unbounded LLM loop.
- Do not repeatedly call `team_get_messages` to simulate background work.
- Preserve current finite teammate behavior by default.
- Daemon teammates must be cancelled by `team_shutdown`.
- Daemon teammates must use the existing mailbox system for lead communication.
- Daemon assignments must be generic and lead-defined through `role_prompt`.
- Domain-specific trigger tools belong in future work.
- Run tests from `packages/opencode`, never from repo root.
- Before each implementation slice is marked complete, use a fresh read-only reviewer to compare the diff against this spec.

## Terminology

Use **daemon teammate** as the product and implementation term.

Definition:

```ts
type DaemonTeammate = {
  lifecycle: "daemon"
  assignment: string
  lifetime: "team"
}
```

A daemon teammate is a team member whose assignment remains valid until the team closes. It can become `idle` between work cycles or messages, but it must not become `completed` just because one assistant turn finished.

## Data Model

Extend `team_member` with lifecycle metadata:

```ts
team_member {
  lifecycle: "task" | "daemon"
  daemon_state: "initializing" | "running" | "idle" | "cancelled" | "error" | null
  daemon_last_active: integer | null
  daemon_error: text | null
}
```

Defaults:

- Existing rows default to `lifecycle = "task"`.
- `daemon_state` is null for task teammates.
- Existing task teammates keep current completion semantics.
- Daemon teammates do not use `completed` as their normal terminal state.

Status semantics:

```txt
task: starting -> active -> completed | cancelled
daemon: starting -> active -> idle -> active -> idle ... -> cancelled
failure: starting | active | idle -> cancelled
```

Prefer carrying daemon-specific lifecycle in `daemon_state` if that avoids broad status enum churn. Keep `team_member.status` compatible with existing team displays unless a separate status is required.

## Tool Surface

Extend `team_spawn`:

```ts
team_spawn({
  name: string
  agent_type: string
  role_prompt: string
  lifecycle?: "task" | "daemon"
  depends_on?: string[]
  wait_for?: string[]
  plan_mode?: boolean
  variant?: string
})
```

Behavior:

- `lifecycle` defaults to `"task"`.
- `lifecycle: "task"` preserves current finite teammate behavior.
- `lifecycle: "daemon"` creates a child session and member row for a long-lived teammate.
- The daemon's durable assignment is exactly the lead-provided `role_prompt` plus daemon prompt guidance.
- A daemon spawn returns after the daemon's initialization work cycle, not after team shutdown.
- A daemon teammate should be marked `idle` or `active` after initialization, not `completed`.
- Dependencies still apply before daemon initialization starts.
- Daemon teammates receive daemon-specific prompt guidance and the existing team mailbox tools.
- Daemon teammates must not use `team_spawn` or create nested teams.

Do not add domain-specific daemon tools in the first pass. In particular, do not add `team_daemon_watch`, scheduler tools, process-tail tools, or health-check tools until the generic daemon lifecycle is proven.

## Execution Model

A daemon teammate should run as a long-lived child session with a persistent assignment.

The daemon does not need to continuously consume model tokens. Instead:

- The daemon receives its assignment during initialization.
- It performs one work cycle.
- If it has no immediate work, it becomes `idle`.
- It remains registered as a daemon member.
- The lead can send additional instructions through `team_send_message`.
- The daemon can notify the lead through existing team mailbox tools.
- Team shutdown cancels the daemon session.

This keeps daemon teammates generic and avoids infinite LLM loops.

The first pass should rely on existing wake behavior:

- Mailbox messages wake idle daemon sessions.
- Lead broadcasts can wake daemon sessions.
- Future trigger providers can wake daemon sessions through the same mailbox/wake path.

## Prompt Contract

Daemon teammate prompt guidance must say:

- You are a daemon teammate.
- Your assignment is long-lived and remains active until the team shuts down.
- Do not treat the first response as final completion.
- Work in cycles: inspect, act, report, then wait when there is no useful work.
- Use `team_send_message` to alert the lead when your assignment discovers something actionable.
- Use `team_get_messages` at natural boundaries, not in a polling loop.
- If your assignment requires periodic or external triggers, explain what trigger you need instead of inventing an unbounded loop.
- Never mark yourself done unless explicitly cancelled or told the daemon assignment is over.

Lead guidance must say:

- Use daemon teammates for monitoring, sentinels, rolling checklists, and other long-lived assignments.
- Do not spawn daemon teammates for ordinary finite research or implementation tasks.
- Give daemon teammates specific reporting criteria so they do not spam the lead.
- Shut down the team when daemon monitoring is no longer needed.

## Reporting And Evaluation

Extend `team_report` output with daemon information:

```ts
type TeamDaemonMetrics = {
  daemon_member_count: number
  active_daemon_count: number
  idle_daemon_count: number
  daemon_error_count: number
}
```

Add deterministic findings:

- `daemon_without_activity`: daemon teammate initialized but never sent or received any mailbox messages after initialization.
- `daemon_error`: daemon teammate entered `daemon_state: "error"`.
- `daemon_left_active_on_shutdown`: team closed but daemon member was not cancelled.
- `daemon_used_for_finite_task`: daemon teammate completed or returned a final-result-shaped message immediately after spawn without any long-lived behavior.

## TUI And HTTP

TUI first pass:

- Show daemon teammates distinctly in the team panel.
- Show daemon state such as `running`, `idle`, `cancelled`, or `error`.
- Do not add interactive daemon trigger management in the first pass.

HTTP first pass:

- Include `lifecycle`, `daemon_state`, `daemon_last_active`, and `daemon_error` in team member response schemas if team member schemas are already returned there.
- If HTTP schemas change, update `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts`.
- If generated SDK types change, run `./packages/sdk/js/script/build.ts`.

## Failure Modes

- `lifecycle` values other than `task` or `daemon` fail schema validation.
- A daemon initialization prompt failure marks the member `cancelled` and records `daemon_error`.
- A daemon that calls a final answer during initialization does not become `completed`; it becomes `idle` unless the run failed.
- A daemon that cannot perform its assignment without an external trigger should report the missing trigger to the lead and become `idle`.
- `team_shutdown` must cancel daemon sessions even if the daemon is currently active.
- Dependencies on daemon teammates must not be considered satisfied merely because the daemon initialized.

## Implementation Slices

### PR 1: Persist Daemon Lifecycle

- Add `lifecycle`, `daemon_state`, `daemon_last_active`, and `daemon_error` fields to `team_member`.
- Add an additive migration in `packages/core/src/database/migration`.
- Update `Team.addMember`, `Team.updateMemberStatus`, and member serialization in `packages/opencode/src/team/team.ts`.
- Keep existing rows and default behavior as `lifecycle: "task"`.
- Add service tests for task member compatibility and daemon member persistence.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/team/team.test.ts`
- `cd packages/opencode && bun test test/tool/team_spawn.test.ts`

Review:

Use a fresh read-only reviewer to verify the migration is additive, existing task teammates still complete, and daemon fields do not change current tool output unless lifecycle is daemon.

### PR 2: Add Daemon Spawn Semantics

- Extend `team_spawn` parameters with `lifecycle?: "task" | "daemon"`.
- Split current finite completion path from daemon initialization path in `packages/opencode/src/tool/team_spawn.ts`.
- For daemon teammates, run initialization and then mark the member `idle` or `active`, not `completed`.
- Ensure daemon spawn returns promptly after initialization.
- Ensure dependencies and plan mode still work or fail explicitly with clear errors.
- Prevent daemon initialization from satisfying downstream `depends_on` relationships unless a future explicit handoff mechanism is added.
- Add tests for daemon spawn, daemon dependency blocking, initialization failure, and shutdown cancellation.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/tool/team_spawn.test.ts`
- `cd packages/opencode && bun test test/tool/team_shutdown.test.ts`

Review:

Use a fresh read-only reviewer to verify finite teammate behavior is unchanged and daemon teammates cannot accidentally unblock dependent task teammates as if they completed.

### PR 3: Add Daemon Prompting, Reporting, And Docs

- Add daemon-specific teammate prompt guidance in `packages/opencode/src/tool/team_spawn.ts`.
- Update lead guidance in `packages/opencode/src/session/prompt.ts` and relevant team tool descriptions.
- Extend `team_report` with daemon metrics and deterministic findings.
- Update `packages/web/src/content/docs/agent-teams.mdx` with daemon teammate behavior and examples.
- Update `packages/opencode/src/team/README.md` with daemon lifecycle invariants.
- Update TUI and HTTP surfaces if member lifecycle is exposed.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/tool/team_report.test.ts`
- `cd packages/opencode && bun test test/team/team-eval.test.ts`
- `cd packages/opencode && bun test test/server/httpapi-team.test.ts`
- `cd packages/web && bun typecheck`
- `./packages/sdk/js/script/build.ts`

Review:

Use a fresh read-only reviewer to verify docs match implemented behavior, report findings are deterministic, and no domain-specific trigger provider is described as part of the initial daemon implementation.

## Future Work

After generic daemon lifecycle exists, add optional trigger providers that wake or feed daemon teammates:

- File watcher trigger.
- Command output trigger.
- Timer or schedule trigger.
- HTTP health-check trigger.
- MCP event trigger.
- Team-event trigger.
- Repo-change trigger.

These should be independent wake/input mechanisms for daemon teammates, not part of the base daemon abstraction.

## Open Questions

- Should daemon teammates be allowed to satisfy `depends_on` dependencies?
  Default: no. Daemon teammates are lifecycle services, not finite producers. A dependent teammate should depend on a separate finite setup or handoff member.
- Should daemon teammates use a separate `daemon_state` field or add new `team_member.status` values?
  Default: use `daemon_state` to minimize status enum churn and preserve existing displays.
- Should daemon teammates be restartable after process crash?
  Default: no in the first pass. Persist lifecycle state for observability, but do not promise daemon recovery until clustered/recovery semantics are designed.
- Should the lifecycle option be named `lifecycle`, `mode`, or `kind`?
  Default: `lifecycle`, because it describes task-vs-daemon lifetime without conflicting with existing agent modes or plan mode.
