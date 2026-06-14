# Orchestration Playbook Prompt Port

## Goal

Bring the high-leverage orchestration playbook from opencode into oc2 so the model uses teams, subagents, shared tasks, mailbox handoffs, plan mode, daemon teammates, shell tools, and todo tracking with the same discipline that makes opencode effective.

The first pass should port guidance and model-visible context, not rewrite oc2's team mechanics. oc2 already has persisted teams, members, tasks, mailbox, plan approval, daemons, reports, subagents, and tool execution. The missing layer is the prompt/playbook contract that tells the model when and how to use those mechanics.

## Current State

- `src/agent/prompts.ts` defines `mainAgentSystemPrompt` as a minimal two-sentence prompt.
- `src/session/context.ts` builds model context from `profile.systemPrompt`, workspace roots, transcript messages, and materialized tools. It does not inject role-specific orchestration guidance.
- `src/team/prompts.ts` builds teammate prompts with only team name, team goal, member name, role prompt, and optional daemon reporting criteria.
- `src/team/team-tools.ts` exposes `team_create`, `team_spawn`, `team_send_message`, `team_broadcast`, `team_get_messages`, shared task tools, plan tools, `team_shutdown`, and `team_report`, but descriptions are API-level rather than behavior-level.
- `src/team/team-service.ts` already implements teams, dependencies, bounded concurrency, mailbox, shared tasks, plan approval, daemons, reports, and a plan-mode config that blocks mutating tools before approval.
- `src/subagent/subagent-tool.ts` exposes child subagent sessions, but oc2 lacks opencode's rich `task` tool guidance about concurrent delegation and avoiding duplicated work.
- Tests under `test/team/`, `test/session/`, `test/subagent/`, and `test/tools/` cover mechanics, but not prompt/playbook content or dynamic role context injection.
- There is no oc2 spec or doc dedicated to orchestration playbook prompts.

## Opencode Reference Map

- `packages/opencode/src/session/prompt.ts:1236-1284` injects pending team mailbox messages as synthetic `<team-messages>` input and tells leads to delegate, wait, integrate, and avoid doing teammate work.
- `packages/opencode/src/session/prompt.ts:1286-1346` defines `teamLeadSystemPrompt`, the primary lead orchestration playbook: create teams early, delegate aggressively, spawn independent teammates in parallel, use shared tasks, dependencies, plan mode, broadcasts, daemons, final reports, and continuous decomposition.
- `packages/opencode/src/session/prompt.ts:1544-1559` shows system prompt assembly order: environment, team guidance, memory workflow, instruction files, and skills.
- `packages/opencode/src/tool/team_create.txt` and `team_spawn.txt` duplicate lead/team guidance at tool-description level so models see constraints at call time.
- `packages/opencode/src/tool/team_spawn.ts:41-64` and `391-404` build teammate prompts with communication, kickoff, progress, blocker, final-result, dependency, daemon, and mailbox guidance.
- `packages/opencode/src/tool/team_get_messages.txt` and `team_get_messages.ts:59-81` document and enforce no-poll mailbox behavior.
- `packages/opencode/src/tool/team_send_message.txt`, `team_broadcast.txt`, `team_task_*.txt`, `team_plan_*.txt`, and `team_report.txt` provide model-visible usage rules for coordination tools.
- `packages/opencode/src/tool/task.txt` defines the subagent playbook: use for complex work, launch independent agents concurrently, do not duplicate delegated work, trust outputs, and provide precise prompts.
- `packages/opencode/src/tool/todowrite.txt` defines the todo playbook: when to use, status rules, exactly one in-progress task, verification before completion, and preserving user commands.
- `packages/opencode/src/tool/shell/shell.txt` and `tool/shell/prompt.ts:86-127` define shell hygiene: use terminal only for terminal operations, prefer specialized tools, verify directories, quote paths, avoid `cd`, parallelize independent commands, and follow git/PR safety rules.
- `packages/opencode/src/agent/subagent-permissions.ts` hard-denies nested team spawning and constrains subagent permissions.
- `packages/opencode/src/team/README.md:151-343` documents lead blocking, parallel spawn semantics, daemon lifecycle, dependencies, mailbox delivery, plan mode, shared tasks, team reports, and shallow usage anti-patterns.
- `packages/opencode/specs/deeper-team-usage-guidance.md`, `agent-team-reliability-improvements.md`, `prevent-nested-team-spawning.md`, `daemon-teammates.md`, and `structured-team-handoffs.md` contain proven design constraints and future enhancements.

## Non-Negotiables

- Preserve oc2's local-first architecture, TypeScript class style, Bun runtime, SQLite persistence, and existing tool names.
- Do not copy Effect.ts service patterns from opencode.
- Do not rewrite `TeamService` mechanics unless a small API addition is required to expose current team context to prompt builders.
- Keep prompt builders deterministic and easy to unit test.
- Keep user-configured `AgentProfile.systemPrompt` support. The playbook must augment, not silently replace, configured prompts.
- Do not expose hidden credentials, environment secrets, OAuth tokens, or sensitive config in prompt context.
- Keep nested team creation/spawn blocked from teammate and subagent contexts through both prompt guidance and execution guards.
- Tool descriptions must include concise behavioral constraints, but the long playbook belongs in prompt builders to avoid bloating every model tool schema.
- Each implementation slice must receive a fresh read-only review before being marked complete.

## Design

### Prompt Surfaces

Add a dedicated orchestration prompt module, preferably `src/agent/orchestration-prompts.ts`, with pure builders:

```ts
interface TeamLeadPromptInput {
  readonly enabled: boolean
  readonly currentModel?: string
  readonly teammateVariants?: readonly string[]
  readonly activeTeam?: {
    readonly id: string
    readonly name: string
    readonly goal: string
    readonly members: readonly TeamMemberPromptInfo[]
  }
}

interface TeamMemberPromptInput {
  readonly teamName: string
  readonly teamGoal: string
  readonly memberName: string
  readonly leadSessionId: string
  readonly memberSessionId: string
  readonly rolePrompt: string
  readonly lifecycle: "task" | "daemon"
  readonly daemonReportingCriteria?: string
  readonly dependencySummaries?: readonly string[]
  readonly currentMembers?: readonly TeamMemberPromptInfo[]
  readonly availableTeamTools?: readonly string[]
  readonly planMode?: boolean
}
```

Required builders:

- `buildTeamLeadOrchestrationPrompt(input)` returns `undefined` when orchestration guidance should not be injected.
- `buildTeamMemberPrompt(input)` replaces the current minimal implementation in `src/team/prompts.ts` or delegates to the new module.
- `buildSubagentDelegationPrompt(input)` provides opencode-style subagent rules for child sessions if oc2 exposes a subagent/system prompt surface.
- `buildToolUsePlaybookPrompt()` provides general shell/todo/tool-use guidance only when the relevant tools are materialized.

### Lead System Prompt Injection

Extend `buildAgentModelContext` in `src/session/context.ts` to accept optional orchestration context from `SessionRunService`:

```ts
interface AgentModelContextInput {
  readonly session: SessionRecord
  readonly messages: readonly SessionMessage[]
  readonly profile: AgentProfile
  readonly registry: ToolRegistry
  readonly config: Pick<Oc2Config, "tools">
  readonly orchestration?: OrchestrationPromptContext
}
```

Injection order must be deterministic:

1. Agent profile system prompt.
2. General tool-use playbook, when relevant tools exist.
3. Team lead orchestration guidance, only for top-level lead sessions that can own a team.
4. Active team status, if the current session owns an active team.
5. Workspace roots.
6. Transcript messages.

Do not inject team lead guidance for teammate sessions, child subagent sessions, sessions with `parentSessionId`, or sessions already associated with a member team context.

### Lead Orchestration Playbook Content

The lead prompt must cover these opencode behaviors:

- Create a team early for non-trivial research, implementation, review, or verification work.
- Spawn multiple independent teammates in parallel whenever possible.
- Use shared tasks and assign owners before implementation starts for multi-step team work.
- Use dependencies only when one teammate truly needs another result.
- Use plan mode for broad, risky, or write-heavy teammate assignments.
- Use daemon teammates only for monitoring, sentinels, rolling checklists, or long-lived work.
- Give daemons explicit reporting criteria and shut down teams when they are no longer needed.
- Broadcast scope changes and key discoveries that affect multiple teammates.
- Run a final team report for non-trivial team sessions.
- Trust teammate outputs and do not duplicate delegated work while waiting.
- Continuously decompose: before substantial local work, decide whether it can be split and delegated.
- Do not create a team for trivial one-step work or when the user explicitly asks the model to work alone.

If oc2 has model variant metadata available, include exact available teammate variants. If it cannot resolve variants, say to omit the variant field rather than guess. If oc2 does not support variants yet, omit variant guidance from the first pass.

### Teammate Prompt Content

The teammate prompt must include:

- Team name, goal, teammate name, lead session id, member session id, and lifecycle.
- Assignment prompt supplied by the lead.
- Available team tools and a statement that nested `team_create` and `team_spawn` are not available from teammate sessions.
- Communication contract: send kickoff, meaningful progress, handoff, blocker, and final result updates through the mailbox.
- Mailbox contract: check pending messages at handoff points or after the lead contacts you; do not poll in a loop.
- Shared task contract: claim assigned tasks, update status in real time, and mark complete only after verification.
- Dependency context: list completed dependency members or summaries when a teammate starts after dependencies.
- Plan mode contract: if `planMode` is true, submit a concrete plan and wait for approval before mutating files or running destructive commands.
- Daemon contract: if lifecycle is `daemon`, report only when criteria are met, return to idle between checks, and avoid spamming the lead.
- Final result contract: return a concise summary of work, files changed/read, verification performed, blockers, and follow-up recommendations.

### Tool Description Upgrades

Enhance `src/team/team-tools.ts` descriptions with compact behavior guidance matching opencode's `.txt` descriptions:

- `team_create`: non-trivial tasks only, create early, assign shared tasks, final report expected.
- `team_spawn`: prefer parallel independent spawns, use dependencies only when necessary, no duplicate work, plan mode for risky edits, daemon lifecycle limits.
- `team_get_messages`: do not poll; empty mailbox is not a reason to broadcast status checks.
- `team_send_message` and `team_broadcast`: use for coordination, scope changes, blockers, handoffs; avoid routine status checks.
- `team_task_create`, `team_task_claim`, `team_task_update`, `team_task_list`: tasks are tracking records and do not wake or spawn teammates.
- `team_plan_submit` and `team_plan_decide`: approval workflow and waiting semantics.
- `team_report`: run after non-trivial team sessions and include deterministic findings.

Enhance `src/subagent/subagent-tool.ts` description with opencode's `task.txt` behavior:

- Use subagents for complex, multi-step, independently researchable work.
- Launch independent subagents concurrently when possible.
- Do not duplicate delegated subagent work.
- Provide precise prompts and expected return shape.

### Mailbox Context And No-Poll Guardrail

First pass should at least make pending mailbox messages model-visible in the next run for the recipient session.

Preferred behavior:

- Before the model call, `SessionRunService` asks `TeamService` for pending messages for the current session.
- Delivered messages are appended as a synthetic/system message or injected into context as `<team-messages>`.
- Lead messages include guidance to coordinate, delegate, wait, and integrate instead of taking over teammate tasks.
- Teammate messages include guidance to handle the message, respond if needed, and continue the assignment.

Add a no-poll guardrail for `team_get_messages` if oc2 can distinguish repeated empty reads in the same run:

- First empty read returns normal empty output plus concise guidance.
- Repeated empty reads in one run return a deterministic "Polling Blocked" style output.
- If run-scoped tracking is not available, leave this as PR 2 and document the missing run-state hook.

### Permission And Nested Team Guardrails

Prompt guidance is not enough. Verify existing execution guards and add missing tests for:

- Child subagent sessions cannot call `team_create` or `team_spawn`.
- Teammate sessions cannot create nested teams or spawn nested teammates.
- Plan-mode teammates cannot use mutating tools before approval.
- Daemon teammates cannot broadcast and can report only when their criteria/state allow it.

If execution already enforces a rule, add a regression test rather than changing code.

### Todo And Shell Playbooks

oc2 may not have opencode's exact `todowrite`, `apply_patch`, `read`, or shell prompt split. Port only guidance that matches real oc2 tools.

First pass requirements:

- Add shell/tool-use guidance to the system prompt only when shell-like tools are exposed.
- Avoid instructing the model to use tools that do not exist in oc2.
- If oc2 lacks a durable todo tool, do not invent one in this spec. Instead, include a future slice for a lightweight tasklist tool only if product scope requires it.

### Documentation

Add `docs/orchestration.md` after prompt behavior lands. It should explain:

- When oc2 creates teams and subagents.
- Lead versus teammate responsibilities.
- Shared tasks, dependencies, plan mode, daemons, mailbox, and reports.
- Known limitations versus opencode.

## Implementation Slices

### PR 1: Prompt Builder Module And Unit Tests

- Add pure orchestration prompt builders under `src/agent/orchestration-prompts.ts` or `src/team/prompts.ts` if a separate agent module feels unnecessary.
- Port the lead playbook content from opencode's `teamLeadSystemPrompt` with oc2-specific tool names and without unsupported variant claims.
- Replace or extend `buildTeamMemberPrompt` with teammate communication, task, mailbox, plan-mode, daemon, dependency, and final-result guidance.
- Add unit tests for prompt content in `test/agent/orchestration-prompts.test.ts` or `test/team/prompts.test.ts`.
- Assert key phrases instead of snapshotting full prompts: `team_create early`, `team_spawn`, `parallel`, `plan mode`, `daemon`, `team_get_messages`, `do not poll`, `final team report`, and `do not duplicate delegated work`.

Verification:

- `bun test test/team/team-service.test.ts test/team/plan.test.ts test/team/report.test.ts`
- `bun test test/agent/orchestration-prompts.test.ts` or `bun test test/team/prompts.test.ts`
- `bun run typecheck`

Review:

- A fresh read-only reviewer must compare prompt content against the opencode reference map and confirm no unsupported oc2 tools are mentioned.

### PR 2: Dynamic Lead Context Injection

- Extend `buildAgentModelContext` to accept optional orchestration context without breaking existing callers.
- Have `SessionRunService.run` build the orchestration context from `SessionRecord`, `TeamService`, selected profile, materialized tools, and current team/member state.
- Inject lead guidance only for top-level sessions that can own a team.
- Inject active team status for lead sessions with active teams: id, name, goal, member names, lifecycle, status, and session ids.
- Keep teammate sessions from receiving lead guidance.
- Update `test/agent/agent.test.ts` or add a session context test for injection order and role gating.

Verification:

- `bun test test/agent/agent.test.ts test/session/run.test.ts test/team/team-service.test.ts`
- `bun run typecheck`

Review:

- A fresh read-only reviewer must verify prompt injection cannot leak unrelated team state or credentials and does not replace configured profile prompts.

### PR 3: Tool Description Guidance

- Upgrade descriptions in `src/team/team-tools.ts` with concise behavior guidance for create, spawn, mailbox, task, plan, shutdown, and report tools.
- Upgrade `src/subagent/subagent-tool.ts` description with delegation guidance adapted from opencode `task.txt`.
- Add tests that materialized tool definitions contain critical guidance phrases.
- Keep JSON schemas unchanged unless an existing field description needs clearer wording.

Verification:

- `bun test test/team/team-tools.test.ts test/subagent/subagent-tool.test.ts`
- `bun run typecheck`

Review:

- A fresh read-only reviewer must confirm descriptions remain concise enough for model schemas and do not contradict service behavior.

### PR 4: Mailbox Message Injection And Empty-Poll Guidance

- Add a run/context hook that delivers pending mailbox messages before model execution and injects them as deterministic synthetic context.
- Format injected context as `<team-messages>` with sender names and message bodies.
- Include lead-specific guidance in injected messages: coordinate, delegate, wait, integrate, and do not take over teammate work.
- Include teammate-specific guidance in injected messages: handle the message, reply if useful, update tasks, and continue assignment.
- Add or defer run-scoped repeated-empty-read guardrail for `team_get_messages`; document the decision in code comments or this spec if deferred.
- Add tests for pending message delivery, delivered status, context injection, and no duplicate delivery.

Verification:

- `bun test test/team/team-service.test.ts test/session/run.test.ts`
- `bun run typecheck`

Review:

- A fresh read-only reviewer must verify mailbox delivery remains per-recipient, idempotent after delivery, and does not cause polling loops.

### PR 5: Guardrail Regression Tests And Docs

- Add regression tests for nested team tool denial from teammate and subagent sessions.
- Add regression tests for plan-mode mutation blocking before approval.
- Add regression tests for daemon reporting restrictions if missing.
- Add `docs/orchestration.md` describing the ported playbook and current limitations.
- Link the doc from `README.md` only if README already has a docs index or agent-team section; otherwise leave it discoverable under `docs/`.

Verification:

- `bun test test/team/team-service.test.ts test/team/plan.test.ts test/subagent/subagent-tool.test.ts`
- `bun run check`

Review:

- A fresh read-only reviewer must verify docs match implemented behavior and tests cover both prompt and execution guardrails.

## Acceptance Criteria

- A normal lead session context includes oc2-specific orchestration guidance when team tools are available and the session can own a team.
- A teammate session context does not include lead guidance and cannot create or spawn nested teams.
- Teammate prompts include kickoff, progress, blocker, mailbox, task, plan-mode, daemon, and final-result contracts.
- Team tool descriptions include model-visible behavior guidance, not just API summaries.
- Pending team mailbox messages are visible to recipient model runs without requiring manual `team_get_messages` polling.
- Tests assert the presence of critical guidance and role gating.
- Existing team mechanics tests continue to pass.

## Future Work

- Port structured team handoffs from opencode's `structured-team-handoffs.md` after the prompt baseline is in place.
- Add deterministic team usage metrics and shallow-usage findings if oc2 reports need stronger anti-pattern detection.
- Add model variant guidance if oc2 exposes provider/model variant metadata for teammate runs.
- Add a durable todo/tasklist tool only if oc2 intends to support opencode-style `todowrite` behavior as a real tool.
- Add global/project instruction-file loading (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`) as a separate spec because it affects configuration, discovery, and security scope beyond orchestration prompts.

## Open Questions

- Should oc2 expose model variants for team spawning now? Default recommendation: no; omit variant guidance until variant metadata exists.
- Should mailbox injection happen in `SessionRunService` or `buildAgentModelContext`? Default recommendation: collect delivery in `SessionRunService`, pass already-sanitized orchestration context into `buildAgentModelContext`.
- Should the first pass add a todo tool? Default recommendation: no; include only guidance that maps to existing tools.
