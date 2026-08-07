# Agent Teams Developer Guide

This guide explains the agent team system from the implementation side.

The short version: one normal OpenCode session becomes the **lead**, and every teammate is a **child session** registered as a team member. Coordination happens through tool calls, persisted team tables, mailbox messages, dependency checks, and the normal session prompt loop.

## Mental Model

Agent teams are not a separate runtime.

They are built on top of the existing session system:

- the lead is a regular session
- each teammate is a regular child session
- each teammate runs through the normal prompt loop
- team tools are normal model tools
- coordination state is stored in SQLite tables
- mailbox delivery is injected back into sessions as synthetic user messages

So when you read the code, do not look for a central "team scheduler" that owns every step. Most behavior is the lead or teammate model choosing tools, and the team service recording and routing state.

## Important Files

- `src/team/team.sql.ts`: database schema for teams, members, tasks, messages, per-recipient delivery, and usage events.
- `src/team/team.ts`: core service for creating teams, adding members, updating status, tasks, messages, and shutdown.
- `src/tool/team_create.ts`: tool that makes the current session the lead.
- `src/tool/team_spawn.ts`: tool that creates and runs teammate child sessions.
- `src/tool/team_send_message.ts`: direct mailbox messages.
- `src/tool/team_broadcast.ts`: mailbox broadcast to active participants.
- `src/tool/team_get_messages.ts`: explicit mailbox read tool.
- `src/tool/team_task_create.ts`: shared task creation with optional exact-file reservations.
- `src/tool/team_task_list.ts`: shared task listing.
- `src/tool/team_task_claim.ts`: task claim that binds owned-task reservations to a session.
- `src/tool/team_task_update.ts`: task status updates and structured handoff on owned-task completion.
- `src/tool/team_plan_submit.ts`: teammate submits a plan to the lead.
- `src/tool/team_plan_decide.ts`: lead approves or rejects a plan.
- `src/tool/team_report.ts`: builds a human-readable team effectiveness report and includes eval metadata.
- `src/tool/team_shutdown.ts`: lead-only team shutdown with the optional forced-abort path.
- `src/team/file-ownership.ts`: canonical exact-file paths, reservation rows, and the structured write lease that guards `write`, `edit`, and `apply_patch`.
- `src/team/eval.ts`: builds the team evaluation graph, summary counts, and findings.
- `src/session/prompt.ts`: prompt loop integration that injects pending team messages.
- `src/tool/registry.ts`: enables team tools when `experimental.agent_teams` is true.

## Who Is The Lead?

The lead is the session that calls `team_create`.

`team_create` calls `team.create` with `leadSessionID: ctx.sessionID`. That value is stored on the `team` row as `lead_session_id`.

There is only one active team per lead session. The schema enforces this with a unique partial index on active `lead_session_id`, and `team.create` also checks before inserting.

The lead is responsible for:

- creating the team
- reusing the current active team (never creating a second concurrent team, including for review)
- creating shared tasks for multi-step work
- assigning owners before implementation starts
- reserving disjoint exact files with `owned_paths` before teammates mutate
- spawning teammates
- using dependencies when one task or teammate needs another result
- receiving start, waiting, completion, and blocker updates
- using plan mode for risky or broad edits
- broadcasting scope changes or key discoveries
- approving or rejecting plan-mode work
- coordinating follow-up work
- spawning fresh read-only reviewer sessions inside the same team after implementation
- running a current final `team_report({ final: true })` immediately before normal shutdown
- keeping Git staging, commit, branch, stash, reset, restore, clean, rebase, push, and PR operations in the lead session
- shutting down the team when needed

The lead is still just a normal assistant session. It does these things by choosing team tools in response to the user's request.

## Who Are The Workers?

Workers are called teammates in the code and docs.

A teammate is a child session plus a row in `team_member`.

`team_spawn` creates the child session with:

```ts
sessions.create({
  parentID: ctx.sessionID,
  title: `${params.name} (@${ag.name} teammate)`,
  permission: permissionRules,
})
```

Then it calls `team.addMember` to store:

- team ID
- child session ID
- teammate name
- agent type
- model
- role prompt
- status
- plan mode flag
- work mode
- dependency session IDs
- final result
- lifecycle (`task` or `daemon`)
- daemon state and error fields for daemon teammates

The child session is what actually runs the model. The team member row is the coordination record for that session.

## How The Lead Calls `team_spawn`

`team_spawn` is exposed to the lead model as a normal tool.

The path is:

1. `ToolRegistry` checks config.
2. If `experimental.agent_teams === true`, it includes `team_spawn` and the other team tools.
3. `SessionPrompt.resolveTools` exposes those tools to the model during the lead session prompt loop.
4. The lead model emits one `team_spawn` tool call per teammate it wants.
5. The tool dispatcher calls `item.execute(args, ctx)`.
6. `team_spawn` uses `ctx.sessionID` as the lead session ID.

Example model-level intent:

```json
{ "name": "auth-explorer", "agent_type": "explore", "role_prompt": "Inspect auth flow" }
{ "name": "api-explorer", "agent_type": "explore", "role_prompt": "Inspect API routes" }
{ "name": "implementer", "agent_type": "general", "role_prompt": "Implement after findings", "depends_on": ["auth-explorer", "api-explorer"] }
```

Those are just separate tool calls. Independent calls can happen in parallel. Dependent teammates are created but blocked until their dependencies finish.

## What `team_spawn` Does

`team_spawn` is the main orchestration entry point.

The flow is:

1. Read config and stop if agent teams are disabled.
2. Find the active team for `ctx.sessionID`.
3. Validate the requested `agent_type`.
4. Require `promptOps`; without it, a teammate cannot actually run.
5. Resolve `depends_on` / `wait_for` names into teammate session IDs.
6. Create a child session under the lead.
7. Insert a `team_member` row with status `starting`.
8. Notify active dependency teammates if someone is waiting on them.
9. If dependencies are incomplete, mark the new teammate `blocked`.
10. If dependencies are complete, return a "Teammate Started" handle immediately; the lifecycle reconciler starts the teammate on its next poll (for task members) or the spawn tool initializes it inline (for daemon members).

Starting a teammate means building a prompt that includes:

- teammate identity
- team goal
- lead session ID
- teammate session ID
- available team tools
- current teammates
- communication rules
- dependency results, if any
- the role prompt from the lead

Then `ops.prompt` runs the child session with the selected agent and model.

## Lead Waiting And Parallel Spawn

Task teammates no longer block the lead's current assistant step.

`team_spawn` returns immediately with a "Teammate Started" handle once the member and child session are created. The teammate's run is claimed by the lifecycle reconciler poll on its own fiber (each member runs on its own session's `Runner`, so cross-session concurrency already works); the lead session is free to keep reasoning while teammates work in the background. The member's final result is no longer embedded in the spawn tool result — completion arrives through the durable mailbox auto-notification, which the lead's finalization barrier delivers and the lead consumes (see [Lead Finalization Barrier](#lead-finalization-barrier)).

The lead can still start multiple teammates in parallel by emitting multiple `team_spawn` tool calls in the same assistant step. Each call returns its handle immediately, so the whole step is not blocked on any teammate.

Inside the teammate run:

1. The reconcile poll claims the new `starting` member and runs it (single-winner: the in-memory `runningMembers` set guarantees a member starts exactly once, whether claimed by the poll or by `claimReadyDependents`).
2. Member status becomes `active`.
3. Lead gets an automatic "teammate started" message.
4. The child session receives its assignment prompt.
5. The teammate runs through the normal session prompt pipeline.
6. When the teammate finishes, the canonical terminal result is extracted (see [Canonical Final Results And Empty-Result Handling](#canonical-final-results-and-empty-result-handling)).
7. The lead gets an automatic completion message containing the result.
8. Member status becomes `completed` — or `failed` with a deterministic `failure_code` after a blank retry, a provider error, or a missing owned-task handoff.
9. Any blocked teammates that depended on this session are checked and possibly started.

When a completed teammate unblocks multiple dependents, those newly ready teammates are started concurrently. Because the spawn call returns before the member finishes, a teammate started in the same step may still be nonterminal when the lead's own assistant step completes. Successful finalization therefore does not exit the session while finite teammates remain nonterminal: the lead finalization barrier parks the exit and resumes the model loop on mail delivery or a new user message; it releases the exit when every finite teammate is terminal. See [Lead Finalization Barrier](#lead-finalization-barrier).

## Daemon Teammates

Daemon teammates are team members with `lifecycle: "daemon"`.

They are for long-lived assignments such as monitoring, sentinels, rolling checklists, or coordination-risk tracking. They are not a special watcher subsystem and they do not introduce timers, log tails, file watchers, or scheduler tools.

Daemon lifecycle invariants:

- `team_spawn` still creates a normal child session and `team_member` row.
- The lead-provided `role_prompt` is the durable daemon assignment.
- Initialization runs one normal prompt cycle and then returns to the lead.
- A successful daemon initialization moves the member to `status: "idle"` and `daemon_state: "idle"`, not `completed`.
- A daemon prompt failure moves the member to `status: "cancelled"`, `daemon_state: "error"`, and records `daemon_error`.
- Daemons use mailbox messages for lead communication and wake behavior.
- Daemons must use `team_get_messages` at natural boundaries, not in a polling loop.
- Daemons do not satisfy teammate `depends_on` relationships merely by initializing or becoming idle.
- `team_shutdown` cancels daemon sessions and records `daemon_state: "cancelled"`.

Future trigger providers should feed or wake daemon teammates through mailbox/wake paths. They should remain separate from the base daemon lifecycle.

## Model Variants

Teammates keep the lead session's selected provider/model unless the selected teammate agent has an explicit model configured. `team_spawn` does not expose a teammate `model` parameter.

When the active model exposes variants, the lead prompt lists the exact variant keys for that current model. The lead may pass `variant` to `team_spawn` to choose one of those exposed variants for a teammate's task complexity. If the lead omits `variant`, inherited lead-model teammates keep the lead's current variant, and explicit-agent-model teammates leave variant resolution to the normal session prompt path.

`team_spawn` validates explicit variants against the teammate's effective model before creating the child session or member row. Invalid variants fail the tool call instead of falling back silently.

For dependency-blocked teammates, the resolved provider/model and any lead-selected or lead-inherited variant are stored in `team_member.model` at spawn time. When the teammate later starts, it uses that stored model object rather than recomputing from the lead's current session state.

This first pass is intentionally tool-driven. There is no central scheduler, automatic model ranking, cost optimizer, post-hoc quality scorer, SQLite migration, or public HTTP team schema change for variants.

## Dependencies

Dependencies are teammate-level dependencies, not task-list dependencies.

`team_spawn` accepts:

- `depends_on`
- `wait_for`

Both are resolved against existing teammate names or session IDs.

Teammate names must be unique inside a team. `team_spawn` rejects a new teammate when an active team already has that name.

Name resolution still handles old data that may contain duplicates. If a dependency name matches more than one teammate, `team_spawn` fails and asks the lead to use a session ID. Session IDs are authoritative and bypass name ambiguity.

If a dependency is missing, spawn fails. If a dependency exists but is not completed, the new member is marked `blocked`.

When a task teammate completes, `startReadyBlockedMembers` checks blocked members that reference the completed session. A blocked member starts only when every dependency session has status `completed` and is not a daemon teammate.

When a finite member fails, its still-blocked descendants are cancelled deterministically with `failure_code: "dependency_failed"` so no blocked graph is left unreachable. Active independent members continue.

When it starts, the dependency results are injected into the prompt under `Dependency results:`.

## Mailbox Coordination

The mailbox is the main communication mechanism.

Messages are stored in:

- `team_message`: one row per logical message
- `team_message_recipient`: one row per recipient, with independent delivery status

This per-recipient table matters. A message sent to two teammates can be delivered to one while still pending for the other.

Common tools:

- `team_send_message`: send to `lead`, teammate name, teammate session ID, or comma-separated recipients
- `team_broadcast`: send to the lead and active teammates except the sender
- `team_get_messages`: explicitly read pending messages for the current session

Sending a message also tries to wake recipients through `wakeTeamSession`.

Terminal finite teammates (`completed`, `cancelled`, or `failed`) are rejected as message recipients with a stable error. Idle daemon recipients remain reachable, and a mailbox message cannot reopen a terminal finite member. See [Terminal Recipient Rule](#terminal-recipient-rule).

Message recipient resolution follows the same identity rule as teammate dependencies. `lead` resolves to the lead session, a teammate session ID is authoritative, and a teammate name must match exactly one member. Ambiguous names fail without sending a message so older duplicate-name teams do not silently route to the wrong recipient.

Every logical message must have one `team_message_recipient` row per recipient. Delivery state is tracked on recipient rows, not just on `team_message`, so reports and evals can distinguish pending and delivered recipients.

Pending mailbox delivery is a claim operation. `team_get_messages` and prompt injection claim pending recipient rows before returning them, so concurrent reads should not deliver the same pending message twice.

## How Waking Works

Waking is intentionally simple.

`wakeTeamSession` calls `ops.wake` twice for the target session. This nudges an idle recipient session to continue its normal prompt loop.

The actual delivery happens in `SessionPrompt.deliverTeamMessages`:

1. Get team context for the current session.
2. Read pending messages for that session.
3. Create a synthetic user message.
4. Put the pending mailbox content inside a `<team-messages>` block.
5. Mark those recipient rows delivered.
6. Continue the prompt loop.

So a teammate does not need to poll forever. If another participant sends a message, the recipient is woken and sees the message as a normal prompt input on the next loop.

Lead-initiated wake waits are bounded. Lead tools briefly wait for woken teammate runs, while teammate-initiated delivery remains asynchronous so teammate work is not blocked.

## Lead Finalization Barrier

Successful finalization of the active team's lead session is event-backed.

When the lead attempts to finalize, the prompt loop runs a private finalization barrier before exiting. The barrier:

1. Confirms the session is still the active team lead.
2. Registers scoped listeners for `team.message.received`, `team.member.updated`, and `team.closed` before reading members or delivering mail.
3. Reads and delivers pending lead mail through the durable mailbox path; a delivery resumes the model loop.
4. Queries current members from durable state.
5. Parks while any finite (task-lifecycle) member is not terminal.
6. Rechecks durable mail and member state after every signal.
7. Permits exit when every finite member is terminal, the team is closed, or the session is no longer the active lead.

Because task teammates spawn asynchronously and complete on their own fibers, the barrier is how the lead observes teammate completion: the completion auto-notification arrives as pending mail, the mail delivery wakes the parked lead, and the loop continues to integrate the result. A new user message can also wake a parked lead so it can act while teammates continue in the background.

Listeners only signal the parked fiber. Durable database state remains authoritative; the barrier never polls the database, sleeps, or invokes the LLM while parked.

Key properties:

- Terminal statuses are `completed` and `cancelled`. Legacy `failed` rows also count as terminal so old teams cannot park the lead forever.
- Daemon members never block in any status. Daemon `idle` notifications are not terminal handoffs; a parked lead is not released by daemon idle events.
- Pending lead mail resumes the lead even while finite work continues. Progress or blocker mail wakes the parked lead, and the next successful-finalization attempt parks again.
- Team closure releases a parked lead regardless of stale member rows. Cancelling one member releases the barrier only when no other finite member remains nonterminal.
- Error paths bypass the barrier: lead interruption or cancellation, provider and processor errors, structured-output errors, compaction errors, and other unsuccessful termination paths exit immediately.
- Mailbox continuations preserve the structured-output contract: the synthetic user message keeps the original format and system, and a fresh structured-output result is required after the handoff is integrated.

The barrier applies only to successful finalization of the active team lead. It is not a scheduling primitive: it does not start work, run teammates, or replace `team_get_messages`.

## Plan Mode

Plan mode is a guardrail for teammates that should not edit immediately.

When `team_spawn` receives `plan_mode: true`, it adds deny rules for:

- `bash`
- `write`
- `edit`
- `apply_patch`

The teammate also receives the `team_plan_submit` tool in its prompt instructions.

The flow is:

1. Teammate starts with mutating tools denied.
2. Teammate calls `team_plan_submit`.
3. The lead receives a mailbox message with the plan.
4. Lead calls `team_plan_decide`.
5. If approved, deny rules are removed from the child session permissions.
6. The teammate is messaged and woken.
7. If rejected, feedback is sent and the teammate stays in plan mode.

Plan mode is not a separate model mode. It is implemented with session permission rules plus mailbox coordination.

`team_plan_decide` can target a teammate by session ID or by an unambiguous name. Ambiguous names fail and ask for a session ID.

Plan decisions only apply to teammates that are currently in plan mode. Approval removes only the plan-mode deny overlay for `bash`, `write`, `edit`, and `apply_patch`, then updates the member to implementation mode. Rejection sends feedback and keeps the plan-mode restrictions intact.

## Shared Tasks

Shared tasks are separate from teammate dependencies.

They live in `team_task` and are manipulated by:

- `team_task_create`
- `team_task_list`
- `team_task_claim`
- `team_task_update`

Creating a task only records tracking state. It does not spawn or wake a teammate.

`team_task_create` also accepts `owned_paths` to exclusively reserve exact file paths for the task. See [Exact-File Reservations And Their Boundaries](#exact-file-reservations-and-their-boundaries) for the reservation contract and its limits.

Task IDs passed to `team_task_claim`, `team_task_update`, and task dependencies may be full IDs or unambiguous prefixes scoped to the current team. Ambiguous prefixes fail with the matching short prefixes and must not mutate state.

Task lookup, updates, and claims are always scoped by `team_id`; a task ID from another team must not be resolved or mutated.

Claiming a task enforces task dependency IDs. A pending task cannot be claimed until all dependency tasks in the same team are `completed`. `cancelled` dependencies do not count as satisfied.

`team_task_update` is restricted to the lead session or the current task assignee. `team_task_claim` assigns the claiming session ID and moves the task from `pending` to `in_progress` in one transaction.

Use this for shared work tracking inside a team. Use `depends_on` / `wait_for` when one teammate should not start until another teammate completes.

## Protocol And Runtime Contract

The prompts, tool descriptions, and this guide describe one protocol. Some parts of it are enforced by the runtime; others are protocol guidance that the lead and teammate prompts ask participants to follow. Keep the two distinct: guidance describes the expected contract, and it is not a complete runtime guarantee.

### One Active Team Per Lead Session

A lead session has at most one active team. The database enforces this with a partial unique index on active `lead_session_id`, and `team.create` checks again before inserting.

A second `team_create` while a team is already active does not create another team and is not a defect. It returns a stable `Team Create Failed` result that names the existing team and its ID, with instructions to reuse that team or shut it down before creating a replacement.

Review phases use the same active team. A lead that wants more evidence after a teammate finishes spawns a fresh read-only reviewer session inside the current team. It does not create a second concurrent team for review.

### Terminal Recipient Rule

`team_send_message` rejects finite teammates that already reached a terminal status (`completed`, `cancelled`, or `failed`) with a stable error. Idle daemon recipients remain reachable.

A mailbox message cannot reopen a terminal finite member. General completed-member resume is out of scope. To get more evidence from finished work, inspect the mailbox and worktree, then spawn a fresh read-only reviewer in the same active team.

### Exact-File Reservations And Their Boundaries

`team_task_create` accepts `owned_paths` to reserve exact file paths for a task. The reservations are exclusive: a path already reserved by another task rejects the create, and claiming an owned task binds every reserved path to the claiming session.

The ownership check is enforced for the structured file tools `write`, `edit`, and `apply_patch` inside one running project instance. A mutation to a path actively reserved by another owner is denied before any write happens. Protocol-0 and unreserved paths keep their previous behavior.

This is an exclusive reservation system for structured file tools, not a complete filesystem sandbox. Shell, plugin, MCP, formatter, external-process, and cross-process writes are not runtime controlled. The write lease serializes same-path structured writes but does not intercept other tool surfaces. Directory and glob reservations are future work.

### Structured Handoff

An owned task is a task created with a nonempty `owned_paths` array and at least one active or released reservation row. Only the authoritative owner (bound by `team_task_claim`) can complete it; the owner or the lead can cancel it.

Completion of an owned task requires a nonblank structured handoff stored in `team_task.metadata.handoff`:

- `summary`: nonblank description of the completed work
- `changed_paths`: canonical paths that must be a subset of the task's reserved `owned_paths`
- `verification`: command/check entries with a status of `passed`, `failed`, or `not_run`

Completion and cancellation release the task's reservations atomically in the same transaction. Cancellation stores no handoff. A finite teammate cannot settle `completed` while it still owns an in-progress task; the first such result enters the bounded completion retry with `missing_task_handoff`, and a second invalid result fails the member and cancels its owned tasks.

### Canonical Final Results And Empty-Result Handling

Live settlement and restart reconciliation share one terminal-result extractor. An assistant error is a failed attempt, and intermediate `tool-calls` / `unknown` turns are not terminal facts. Eligible text is the non-synthetic, non-ignored text parts joined with `\n` and trimmed once; a blank result is invalid.

A finite member gets at most two attempts. A blank, whitespace-only, synthetic-only, ignored-only, or tool-only finite result is not successful completion and enters the bounded completion-only retry; a second invalid result fails the member with a deterministic `failure_code`. Daemon idle output is exempt from the empty-result rule.

An empty teammate result is therefore an untrusted runtime failure, not proof that no work occurred. Before deciding whether work exists, check the mailbox once and inspect `git status --short` plus the focused diff.

### Lead-Owned Git Operations

Git staging, commit, branch, stash, reset, restore, clean, rebase, push, and PR operations belong in the lead session. Teammates are instructed not to run whole-worktree Git mutation commands.

This is protocol guidance. There is no shell or process-level enforcement of the Git rule yet; do not describe it as a complete runtime guarantee.

### Final Report And Forced Abort

`team_report({ final: true })` records a revision-bound final-report checkpoint:

- lead-only; a teammate session is rejected
- every finite (task-lifecycle) teammate must be terminal; a failed teammate is allowed and appears as a deterministic finding
- no daemon may be starting or running; idle daemons are allowed
- for protocol-1 teams, every shared task must be finished (protocol-0 teams skip this gate)
- the checkpoint is bound to the team revision at build time and records only if the team is still active and unchanged during construction; a changing team gets `stale: true` and no checkpoint

Run a current final report immediately before normal shutdown. `team_shutdown` for protocol-1 teams requires that `final_report_revision` matches `revision`.

`team_shutdown({ force: true, reason })` is the lead-only escape hatch for a wedged or explicitly abandoned team. It requires a nonblank reason, bypasses the report checkpoint, records a deterministic forced-shutdown finding, and still closes/cancels/releases state atomically. It must not become the normal completion path.

### Protocol Version

New teams are created with `protocol_version = 1`. For these teams, normal shutdown requires `final_report_revision === revision`, and the final-report task gate requires every shared task to be finished. Existing protocol-0 teams remain compatible: they skip both gates and keep the legacy shutdown behavior.

## Usage Metrics And Shallow Usage

Team evaluation computes deterministic usage metrics from persisted team state. These metrics do not judge teammate output quality; they check whether the lead modeled coordination work.

The usage summary contains:

- `work_item_count`: `max(task_count, member_count)`
- `task_count`: shared tasks in `team_task`
- `member_count`: teammates in `team_member`
- `dependency_count`: members or tasks with non-empty `dependency_ids`
- `plan_mode_member_count`: members spawned with `plan_mode: true`
- `plan_approval_count`: persisted `plan_approved` usage events
- `broadcast_count`: persisted `broadcast_sent` usage events
- `final_report_generated`: true when a final `team_report` persisted a `report_generated` event
- `shallow_usage`: true when teammates were spawned but no shared tasks, dependencies, plan approvals, or final report were recorded

Rollups in `team_report` use teams with at least one teammate as the denominator. The report includes percentages for task-list usage, dependency modeling, plan-mode usage, final report generation, and shallow usage.

The shallow-usage anti-pattern is "spawn teammates and summarize" without modeling work. It is surfaced as a finding, not blocked at runtime. A non-trivial team with at least three work items also gets findings when it has no shared tasks or when a completed team has no final report.

Report message counts are based on persisted recipient rows. `pending` means the recipient row has not been claimed for prompt injection or `team_get_messages`; `delivered` means it has. Do not report `read` counts unless a real read transition exists in stored delivery state.

Evaluation findings must stay deterministic. Current findings are derived from persisted team state, including missing dependencies, cancelled members, blocked members whose dependencies are complete, blocked members with cancelled dependencies, pending delivery rows on closed teams, shallow usage, missing task lists for non-trivial teams, and missing final reports for non-trivial completed teams.

## Status Events And UI

The service publishes bus events for team lifecycle and member updates:

- `team.created`
- `team.closed`
- `team.member.updated`
- `team.message.received`

The lead finalization barrier subscribes to `team.closed`, `team.member.updated`, and `team.message.received` to wake a parked lead (see [Lead Finalization Barrier](#lead-finalization-barrier)).

The TUI sidebar lists child sessions for the current parent session. That means older `task` subagents and team teammates can appear in the same Team section because both are child sessions. `team_member_status` is keyed by session ID and adds team-specific status for teammate children; plain subagents do not have a `team_member` row.

The UI does not orchestrate work. It reads state, shows members/tasks/messages, displays pending permissions/questions, and can call shutdown.

## Shutdown

`team_shutdown` only works from the lead session because it looks up the active team by `ctx.sessionID`.

Shutdown:

- marks the team `closed`
- marks non-finished members `cancelled`
- cancels active member session run state
- releases task file reservations
- publishes `team.closed`
- does not cancel the lead session

Normal shutdown for a protocol-1 team requires a current final report: `team_report({ final: true })` must have recorded a checkpoint at the team's current revision, and the lead should run that report immediately before shutdown. `team_shutdown({ force: true, reason })` is the lead-only escape hatch for a wedged or abandoned team; it requires a nonblank reason, bypasses the report checkpoint, records a deterministic forced-shutdown finding, and must not become the normal completion path. See [Final Report And Forced Abort](#final-report-and-forced-abort).

## Pause And Start

Pause is not shutdown and not member cancellation.

`POST /session/:sessionID/pause` commits a durable pause cascade for that session and its full descendant subtree, then signals interruption to every affected session that is currently running. The TUI exposes this as `/pause` in the viewed session. The lead session is the root of the team, so pausing the lead pauses every teammate; pausing one teammate pauses only that member's subtree.

A session is paused while it has at least one active blocker, and cascades stack. `/unpause` on a session releases only the cascade that session owns: a child `/unpause` can never clear an ancestor pause. If a child `/unpause` succeeds but the child stays paused, an ancestor-owned cascade is still blocking it; the TUI reports that explicitly.

While paused:

- prompts and V2 inputs are admitted durably but do not execute, and set durable resume intent
- team mailbox rows stay pending; they are not claimed early
- team members and tasks keep their status; nothing is marked completed or cancelled, and no dependency is unblocked
- shutdown, deletion, and explicit cancellation stay authoritative

Resume intent is durable per session and reason (`running`, `queued-input`, `team-wake`, `background-result`). `/unpause` releases the root's cascade and schedules exactly the sessions that still have resume intent and no remaining blockers, once, without waking completed, cancelled, idle, or dependency-blocked sessions. After a process restart, `/unpause` reconstructs execution solely from the durable blockers, resume intents, queued inputs, member/task rows, and mailbox state. The former `/start` name still works as a deprecated alias for `/unpause`.

The typed pause/start actions live in the session HTTP API (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`) and return a `SessionControlResult` with the affected closure, interrupted subset, still-blocked subset, scheduled subset, and an `unchanged` flag for idempotent repeats.

## HTTP API

The HTTP API is read-heavy:

- `GET /team?sessionID=<session>`: get active team by lead session
- `GET /team/:teamID`: get team by ID
- `GET /team/:teamID/eval`: build the JSON evaluation report for a team
- `GET /team/:teamID/tasks`: list tasks
- `GET /team/:teamID/messages`: list messages
- `POST /team/:teamID/shutdown`: shut down team

Tool calls are still the primary way models create teams, spawn teammates, and coordinate.

`GET /team?sessionID=<session>` only resolves active teams. For a closed historical team, pass `teamID` directly or recover it from a completed `team_create` / `team_report` tool part in the lead session transcript.

`team_report` is a tool, not a direct HTTP endpoint. The formatted markdown report is stored in the completed tool part at `GET /session/:sessionID/message`; structured metadata includes the full eval report at `state.metadata.eval`.

The report also includes a `Team usage` section and stores current-team usage metrics at `state.metadata.usage` plus rollup percentages at `state.metadata.usage_rollup`.

For local debugging, `script/fetch-team-report.sh` wraps the common flow:

```bash
LEAD_SESSION_ID=ses_... ./script/fetch-team-report.sh
TEAM_ID=... RUN_SESSION_ID=ses_... ./script/fetch-team-report.sh
GENERATE_REPORT=1 LEAD_SESSION_ID=ses_... ./script/fetch-team-report.sh
```

The script assumes an HTTP server is running, for example:

```bash
bun run dev serve --port 4096
```

## Common Misreadings

`team_spawn` is not the same as the older `task` tool.

The `task` tool runs a subagent-style task and returns a result to the current session. `team_spawn` creates a persistent child session that can receive mailbox messages, have dependencies, be displayed in the TUI, and keep team membership state.

There is no central loop polling all teammates.

Each teammate runs through the normal session prompt loop. Mailbox messages wake sessions. Dependencies are checked when a dependency completes.

The lead is not special at the session layer.

The lead is special because the team row points to its session ID. The lead still uses normal tools and normal prompt processing.

Tasks do not start teammates.

The shared task list is bookkeeping. Spawning and dependency orchestration happen through `team_spawn`.

## Debugging Path

For "why did spawn fail":

1. Check `experimental.agent_teams`.
2. Check that the current session has an active team.
3. Check that `agent_type` exists.
4. Check that `promptOps` is present.
5. Check dependency names/session IDs.

For "why did a teammate not start":

1. Look at `team_member.status`.
2. If `blocked`, inspect `dependency_ids`.
3. Confirm each dependency member is `completed`.
4. Check whether the background prompt task failed and marked the member `cancelled`.

For "why did a message not arrive":

1. Check `team_message`.
2. Check `team_message_recipient` for the target recipient.
3. Confirm the recipient session ID matches the lead or member session.
4. Check whether `deliverTeamMessages` marked it delivered.
5. Check whether `promptOps` was available to wake the recipient.

## Tests To Read

Good starting tests:

- `test/team/team.test.ts`: service-level team behavior, messages, tasks, plan-mode helpers, shutdown.
- `test/tool/team_spawn.test.ts`: actual spawn behavior, prompt context, dependency blocking, and automatic dependent start.

Run tests from the package directory, not the repo root:

```bash
cd packages/opencode
bun test test/team/team.test.ts
bun test test/tool/team_spawn.test.ts
```

## One-Screen Flow

```txt
user asks for agent team
  |
lead session calls team_create
  |
lead model calls team_spawn once per teammate
  |
team_spawn creates child session + team_member row
  |
if dependencies incomplete:
  member status = blocked
else:
  run child session and wait for teammate result
  |
teammate runs normal prompt loop
  |
teammate sends mailbox updates / uses shared tasks / submits plans
  |
messages wake recipient sessions and inject <team-messages>
  |
teammate finishes with a canonical result
  |
result sent to lead and stored on team_member
  |
dependent blocked teammates may start
  |
lead spawns fresh read-only reviewers in the same team when more evidence is needed
  |
lead runs team_report({ final: true }) immediately before normal shutdown
  |
lead shuts down the team (or uses force: true only for a wedged team)
```
