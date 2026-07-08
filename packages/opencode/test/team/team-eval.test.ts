import { describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Database } from "@/storage/db"
import { TeamEval, type TeamEvalFindingCategory, type TeamEvalReport } from "@/team/eval"
import { Team } from "@/team/team"
import { TeamMemberTable, TeamTable, TeamTaskTable } from "@/team/team.sql"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Team.defaultLayer, Bus.layer, Database.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

describe("team eval", () => {
  it.live("builds team DAG nodes and edges", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "eval-dag", goal: "Build a DAG", leadSessionID: "ses_eval_lead_dag" })
        const first = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_dag_first",
          name: "first",
          agentType: "general",
          rolePrompt: "Do first work",
        })
        const second = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_dag_second",
          name: "second",
          agentType: "general",
          rolePrompt: "Do second work",
          dependencyIDs: [first.session_id],
        })
        const firstTask = yield* team.createTask({ teamID: info.id, description: "First task" })
        const secondTask = yield* team.createTask({
          teamID: info.id,
          description: "Second task",
          dependencyIDs: [firstTask.id],
        })
        const message = yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [second.session_id],
          body: "Please continue after first.",
        })

        yield* team.updateMemberStatus(first.id, "completed", "first result")

        const report = yield* TeamEval.build(info.id)

        expect(report.nodes.some((item) => item.id === node("team", info.id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("member", first.session_id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("task", secondTask.id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("message", message.id))).toBe(true)
        expect(report.nodes.some((item) => item.id === node("result", first.session_id))).toBe(true)
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "depends_on",
            from: node("member", first.session_id),
            to: node("member", second.session_id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "depends_on",
            from: node("task", firstTask.id),
            to: node("task", secondTask.id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "message_to",
            from: node("team", info.id),
            to: node("member", second.session_id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "produces",
            from: node("member", first.session_id),
            to: node("result", first.session_id),
          }),
        )
        expect(report.summary.longest_dependency_chain).toBe(1)
      }),
    ),
  )

  it.live("reports missing dependencies and empty results", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-findings",
          goal: "Find deterministic failures",
          leadSessionID: "ses_eval_lead_findings",
        })
        const empty = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_empty_result",
          name: "empty",
          agentType: "general",
          rolePrompt: "Complete without a result",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_member_dep",
          name: "missing-dep",
          agentType: "general",
          rolePrompt: "Depend on a missing member",
          dependencyIDs: ["ses_eval_missing_dependency"],
        })
        const now = Date.now()
        yield* Database.Database.Service.use((database) =>
          database.db
            .insert(TeamTaskTable)
            .values({
              id: "task_eval_missing_dependency_holder",
              team_id: info.id,
              description: "Task with missing dependency",
              status: "pending",
              assignee: null,
              dependency_ids: ["task_missing_dependency"],
              metadata: null,
              time_created: now,
              time_updated: now,
            })
            .run(),
        )

        yield* team.updateMemberStatus(empty.id, "completed")

        const report = yield* TeamEval.build(info.id)

        expect(
          categories(report).filter((category) => category === "planning.missing_or_wrong_dependency").length,
        ).toBe(2)
        expect(categories(report)).toContain("execution.empty_result")
        expect(finding(report, "execution.empty_result")?.root_cause).toBe(true)
        expect(report.summary.root_cause_count).toBe(3)
      }),
    ),
  )

  it.live("propagates cancelled dependency to blocked dependent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-propagation",
          goal: "Propagate failures",
          leadSessionID: "ses_eval_lead_propagation",
        })
        const upstream = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_cancelled_upstream",
          name: "upstream",
          agentType: "general",
          rolePrompt: "Fail upstream",
        })
        const dependent = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_blocked_dependent",
          name: "dependent",
          agentType: "general",
          rolePrompt: "Wait for upstream",
          dependencyIDs: [upstream.session_id],
        })

        yield* team.updateMemberStatus(upstream.id, "cancelled")
        yield* team.updateMemberStatus(dependent.id, "blocked")

        const report = yield* TeamEval.build(info.id)
        const blocked = finding(report, "execution.stuck_or_blocked", node("member", dependent.session_id))

        expect(finding(report, "execution.cancelled_member", node("member", upstream.session_id))?.root_cause).toBe(
          true,
        )
        expect(blocked?.root_cause).toBe(false)
        expect(blocked?.propagated_from).toBe(node("member", upstream.session_id))
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "propagates_to",
            from: node("member", upstream.session_id),
            to: node("member", dependent.session_id),
          }),
        )
      }),
    ),
  )

  it.live("does not propagate through containment or lead spawn edges", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-local-failures",
          goal: "Keep local failures local",
          leadSessionID: "ses_eval_lead_local",
        })
        const active = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_active_at_close",
          name: "active",
          agentType: "general",
          rolePrompt: "Stay active",
        })
        const cancelled = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_local_cancelled",
          name: "cancelled",
          agentType: "general",
          rolePrompt: "Cancel locally",
        })

        yield* team.updateMemberStatus(active.id, "active")
        yield* team.updateMemberStatus(cancelled.id, "cancelled")
        yield* closeTeam(info.id)

        const report = yield* TeamEval.build(info.id)

        expect(finding(report, "integration.premature_shutdown", node("team", info.id))?.root_cause).toBe(true)
        expect(finding(report, "execution.cancelled_member", node("member", cancelled.session_id))?.root_cause).toBe(
          true,
        )
        expect(
          finding(report, "execution.cancelled_member", node("member", cancelled.session_id))?.propagated_from,
        ).toBeUndefined()
      }),
    ),
  )

  it.live("reports pending delivery after close and expected edge deviations", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-closed-message",
          goal: "Find pending messages",
          leadSessionID: "ses_eval_lead_pending",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pending_recipient",
          name: "recipient",
          agentType: "general",
          rolePrompt: "Receive message",
        })

        yield* team.updateMemberStatus(member.id, "completed", "recipient result")
        yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [member.session_id],
          body: "Pending when closed",
        })
        yield* closeTeam(info.id)

        const report = yield* TeamEval.build(info.id, {
          expectedEdges: [{ type: "depends_on", from: node("member", "missing-a"), to: node("member", "missing-b") }],
        })

        expect(categories(report)).toContain("messaging.pending_delivery")
        expect(categories(report)).toContain("structure.unexpected_or_missing_edge")
        expect(report.summary.structural_deviation_count).toBe(1)
      }),
    ),
  )

  it.live("reports legacy duplicate teammate names as ambiguous", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-duplicate-names",
          goal: "Detect ambiguous legacy names",
          leadSessionID: "ses_eval_lead_duplicate_names",
        })
        const now = Date.now()
        yield* Database.Database.Service.use((database) =>
          database.db
            .insert(TeamMemberTable)
            .values([
              {
                id: "mem_eval_duplicate_name_first",
                team_id: info.id,
                session_id: "ses_eval_duplicate_name_first",
                name: "worker",
                agent_type: "general",
                model: null,
                role_prompt: "Do first work",
                status: "completed",
                plan_mode: false,
                work_mode: "implement",
                dependency_ids: null,
                result: "first result",
                time_created: now,
                time_updated: now,
              },
              {
                id: "mem_eval_duplicate_name_second",
                team_id: info.id,
                session_id: "ses_eval_duplicate_name_second",
                name: "worker",
                agent_type: "general",
                model: null,
                role_prompt: "Do second work",
                status: "completed",
                plan_mode: false,
                work_mode: "implement",
                dependency_ids: null,
                result: "second result",
                time_created: now + 1,
                time_updated: now + 1,
              },
            ])
            .run(),
        )
        yield* team.createTask({ teamID: info.id, description: "Track duplicate-name audit" })

        const report = yield* TeamEval.build(info.id)
        const duplicateName = finding(report, "member.ambiguous_name", node("team", info.id))

        expect(duplicateName?.root_cause).toBe(true)
        expect(duplicateName?.message).toContain('Teammate name "worker" is used by 2 members')
        expect(duplicateName?.metadata).toEqual(
          expect.objectContaining({
            name: "worker",
            session_ids: ["ses_eval_duplicate_name_first", "ses_eval_duplicate_name_second"],
          }),
        )
      }),
    ),
  )

  it.live("reports daemon lifecycle findings", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-daemons",
          goal: "Evaluate daemons",
          leadSessionID: "ses_eval_daemon_lead",
        })
        const idle = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_daemon_idle",
          name: "idle-daemon",
          agentType: "general",
          rolePrompt: "Monitor",
          lifecycle: "daemon",
          daemonState: "idle",
        })
        const failed = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_daemon_failed",
          name: "failed-daemon",
          agentType: "general",
          rolePrompt: "Monitor failures",
          lifecycle: "daemon",
          daemonState: "error",
          daemonError: "boom",
        })
        const finite = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_daemon_completed",
          name: "completed-daemon",
          agentType: "general",
          rolePrompt: "Should stay daemon",
          lifecycle: "daemon",
          daemonState: "idle",
        })

        yield* team.updateMemberStatus(idle.id, "idle", { daemonState: "idle" })
        yield* team.updateMemberStatus(failed.id, "cancelled", { daemonState: "error", daemonError: "boom" })
        yield* team.updateMemberStatus(finite.id, "completed")

        const report = yield* TeamEval.build(info.id)
        const daemonNode = report.nodes.find((item) => item.id === node("member", idle.session_id))

        expect(daemonNode?.metadata).toEqual(expect.objectContaining({ lifecycle: "daemon", daemon_state: "idle" }))
        expect(categories(report)).toContain("daemon_without_activity")
        expect(categories(report)).toContain("daemon_error")
        expect(categories(report)).toContain("daemon_used_for_finite_task")
        expect(categories(report)).not.toContain("execution.cancelled_member")
      }),
    ),
  )

  it.live("detects daemon final result messages without counting automatic idle messages as activity", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-daemon-message",
          goal: "Evaluate daemon messages",
          leadSessionID: "ses_eval_daemon_message_lead",
        })
        const daemon = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_daemon_message",
          name: "sentinel",
          agentType: "general",
          rolePrompt: "Monitor",
          lifecycle: "daemon",
          daemonState: "idle",
        })
        yield* team.updateMemberStatus(daemon.id, "idle", { daemonState: "idle", daemonLastActive: Date.now() - 1 })
        yield* team.sendMessage({
          teamID: info.id,
          sender: daemon.session_id,
          recipients: [info.lead_session_id],
          body: [
            "Daemon completed and returned this result:",
            "",
            "<teammate_result>",
            "done",
            "</teammate_result>",
          ].join("\n"),
        })

        const report = yield* TeamEval.build(info.id)

        expect(categories(report)).toContain("daemon_used_for_finite_task")
      }),
    ),
  )

  it.live("reports daemon left active after shutdown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-daemon-shutdown",
          goal: "Close daemons",
          leadSessionID: "ses_eval_daemon_shutdown_lead",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_daemon_left_active",
          name: "left-active",
          agentType: "general",
          rolePrompt: "Monitor",
          lifecycle: "daemon",
          daemonState: "idle",
        })
        yield* closeTeam(info.id)

        const report = yield* TeamEval.build(info.id)

        expect(categories(report)).toContain("daemon_left_active_on_shutdown")
      }),
    ),
  )

  it.live("does not report errored cancelled daemon as left active after shutdown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-daemon-error-shutdown",
          goal: "Close errored daemons",
          leadSessionID: "ses_eval_daemon_error_shutdown_lead",
        })
        const daemon = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_daemon_error_shutdown",
          name: "errored",
          agentType: "general",
          rolePrompt: "Monitor",
          lifecycle: "daemon",
          daemonState: "error",
          daemonError: "boom",
        })
        yield* team.updateMemberStatus(daemon.id, "cancelled", { daemonState: "error", daemonError: "boom" })
        yield* closeTeam(info.id)

        const report = yield* TeamEval.build(info.id)

        expect(categories(report)).not.toContain("daemon_left_active_on_shutdown")
        expect(categories(report)).toContain("daemon_error")
      }),
    ),
  )

  it.live("reports no findings for completed independent teammate fixture", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-pr4-happy",
          goal: "Complete independent work",
          leadSessionID: "ses_eval_pr4_happy_lead",
        })
        const first = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_happy_first",
          name: "first",
          agentType: "general",
          rolePrompt: "Complete first independent work",
        })
        const second = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_happy_second",
          name: "second",
          agentType: "general",
          rolePrompt: "Complete second independent work",
        })
        yield* team.createTask({ teamID: info.id, description: "Track completed work" })

        yield* team.updateMemberStatus(first.id, "completed", "first result")
        yield* team.updateMemberStatus(second.id, "completed", "second result")

        const report = yield* TeamEval.build(info.id)

        expect(report.findings).toEqual([])
        expect(report.summary.root_cause_count).toBe(0)
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "lead_to_member",
            from: node("team", info.id),
            to: node("member", first.session_id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "lead_to_member",
            from: node("team", info.id),
            to: node("member", second.session_id),
          }),
        )
      }),
    ),
  )

  it.live("summarizes usage metrics from deterministic team state", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-usage-metrics",
          goal: "Summarize usage",
          leadSessionID: "ses_eval_usage_metrics_lead",
        })
        const planner = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_usage_metrics_planner",
          name: "planner",
          agentType: "general",
          rolePrompt: "Plan first",
          planMode: true,
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_usage_metrics_builder",
          name: "builder",
          agentType: "general",
          rolePrompt: "Build second",
          dependencyIDs: [planner.session_id],
        })
        const firstTask = yield* team.createTask({ teamID: info.id, description: "Plan task" })
        yield* team.createTask({ teamID: info.id, description: "Build task", dependencyIDs: [firstTask.id] })
        yield* team.createUsageEvent({ teamID: info.id, memberID: planner.id, type: "plan_approved" })
        yield* team.createUsageEvent({ teamID: info.id, type: "broadcast_sent" })
        yield* team.createUsageEvent({ teamID: info.id, type: "report_generated" })

        const report = yield* TeamEval.build(info.id)

        expect(report.summary.usage).toEqual({
          work_item_count: 2,
          task_count: 2,
          member_count: 2,
          dependency_count: 2,
          plan_mode_member_count: 1,
          plan_approval_count: 1,
          broadcast_count: 1,
          final_report_generated: true,
          shallow_usage: false,
        })
      }),
    ),
  )

  it.live("detects shallow usage", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-shallow-usage",
          goal: "Detect shallow usage",
          leadSessionID: "ses_eval_shallow_usage_lead",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_shallow_usage_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Do work",
        })

        const report = yield* TeamEval.build(info.id)

        expect(report.summary.usage.shallow_usage).toBe(true)
        expect(categories(report)).toContain("shallow_usage")
      }),
    ),
  )

  it.live("detects missing task lists for non-trivial teams", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-missing-task-list",
          goal: "Detect missing tasks",
          leadSessionID: "ses_eval_missing_task_list_lead",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_task_list_a",
          name: "a",
          agentType: "general",
          rolePrompt: "Do A",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_task_list_b",
          name: "b",
          agentType: "general",
          rolePrompt: "Do B",
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_task_list_c",
          name: "c",
          agentType: "general",
          rolePrompt: "Do C",
        })
        yield* team.createUsageEvent({ teamID: info.id, type: "report_generated" })

        const report = yield* TeamEval.build(info.id)

        expect(categories(report)).toContain("missing_task_list")
        expect(report.summary.usage.work_item_count).toBe(3)
      }),
    ),
  )

  it.live("detects missing final reports for non-trivial completed teams", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-missing-final-report",
          goal: "Detect missing final report",
          leadSessionID: "ses_eval_missing_final_report_lead",
        })
        const first = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_final_report_a",
          name: "a",
          agentType: "general",
          rolePrompt: "Do A",
        })
        const second = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_final_report_b",
          name: "b",
          agentType: "general",
          rolePrompt: "Do B",
        })
        const third = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_missing_final_report_c",
          name: "c",
          agentType: "general",
          rolePrompt: "Do C",
        })
        yield* team.updateMemberStatus(first.id, "completed", "a result")
        yield* team.updateMemberStatus(second.id, "completed", "b result")
        yield* team.updateMemberStatus(third.id, "completed", "c result")
        yield* closeTeam(info.id)

        const report = yield* TeamEval.build(info.id)

        expect(categories(report)).toContain("missing_final_report")
      }),
    ),
  )

  it.live("matches expected depends_on edge for dependent teammate fixture", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-pr4-dependency",
          goal: "Pass result context",
          leadSessionID: "ses_eval_pr4_dep_lead",
        })
        const upstream = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_dep_upstream",
          name: "upstream",
          agentType: "general",
          rolePrompt: "Produce context",
        })
        const dependent = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_dep_dependent",
          name: "dependent",
          agentType: "general",
          rolePrompt: "Use upstream context",
          dependencyIDs: [upstream.session_id],
        })

        yield* team.updateMemberStatus(upstream.id, "completed", "upstream result context")
        yield* team.sendMessage({
          teamID: info.id,
          sender: upstream.session_id,
          recipients: [dependent.session_id],
          body: "Use upstream result context.",
        })
        yield* team.updateMemberStatus(dependent.id, "completed", "dependent used upstream result context")

        const report = yield* TeamEval.build(info.id, {
          expectedEdges: [
            { type: "depends_on", from: node("member", upstream.session_id), to: node("member", dependent.session_id) },
          ],
        })

        expect(report.summary.structural_deviation_count).toBe(0)
        expect(report.findings).toEqual([])
        expect(report.summary.root_cause_count).toBe(0)
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "depends_on",
            from: node("member", upstream.session_id),
            to: node("member", dependent.session_id),
          }),
        )
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "message_to",
            from: node("member", upstream.session_id),
            to: node("member", dependent.session_id),
          }),
        )
      }),
    ),
  )

  it.live("reports blocked dependent after completed dependency fixture", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-pr4-blocked",
          goal: "Detect stuck dependent",
          leadSessionID: "ses_eval_pr4_blocked_lead",
        })
        const upstream = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_blocked_upstream",
          name: "upstream",
          agentType: "general",
          rolePrompt: "Complete before dependent",
        })
        const dependent = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_blocked_dependent",
          name: "dependent",
          agentType: "general",
          rolePrompt: "Should be unblocked",
          dependencyIDs: [upstream.session_id],
        })

        yield* team.updateMemberStatus(upstream.id, "completed", "upstream result")
        yield* team.updateMemberStatus(dependent.id, "blocked")

        const report = yield* TeamEval.build(info.id)
        const blocked = finding(report, "execution.stuck_or_blocked", node("member", dependent.session_id))

        expect(blocked?.root_cause).toBe(true)
        expect(blocked?.metadata?.dependency_ids).toEqual([upstream.session_id])
      }),
    ),
  )

  it.live("reports pending delivery for closed team fixture", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-pr4-pending",
          goal: "Detect pending delivery",
          leadSessionID: "ses_eval_pr4_pending_lead",
        })
        const recipient = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_pending_recipient",
          name: "recipient",
          agentType: "general",
          rolePrompt: "Receive pending message",
        })
        const message = yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [recipient.session_id],
          body: "Pending after close.",
        })

        yield* team.updateMemberStatus(recipient.id, "completed", "recipient completed before close")
        yield* closeTeam(info.id)

        const report = yield* TeamEval.build(info.id)
        const pending = finding(report, "messaging.pending_delivery", node("message", message.id))

        expect(pending?.root_cause).toBe(true)
        expect(pending?.metadata?.recipient).toBe(recipient.session_id)
      }),
    ),
  )

  it.live("propagates cancelled member to blocked dependent fixture", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "eval-pr4-cancelled",
          goal: "Propagate cancellation",
          leadSessionID: "ses_eval_pr4_cancelled_lead",
        })
        const upstream = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_cancelled_upstream",
          name: "upstream",
          agentType: "general",
          rolePrompt: "Cancel upstream",
        })
        const dependent = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_eval_pr4_cancelled_dependent",
          name: "dependent",
          agentType: "general",
          rolePrompt: "Wait on cancelled upstream",
          dependencyIDs: [upstream.session_id],
        })

        yield* team.updateMemberStatus(upstream.id, "cancelled")
        yield* team.updateMemberStatus(dependent.id, "blocked")

        const report = yield* TeamEval.build(info.id)
        const blocked = finding(report, "execution.stuck_or_blocked", node("member", dependent.session_id))

        expect(finding(report, "execution.cancelled_member", node("member", upstream.session_id))?.root_cause).toBe(
          true,
        )
        expect(blocked?.root_cause).toBe(false)
        expect(blocked?.propagated_from).toBe(node("member", upstream.session_id))
        expect(report.edges).toContainEqual(
          expect.objectContaining({
            type: "propagates_to",
            from: node("member", upstream.session_id),
            to: node("member", dependent.session_id),
          }),
        )
      }),
    ),
  )
})

function finding(report: TeamEvalReport, category: TeamEvalFindingCategory, nodeID?: string) {
  return report.findings.find((item) => item.category === category && (nodeID === undefined || item.node_id === nodeID))
}

function categories(report: TeamEvalReport) {
  return report.findings.map((item) => item.category)
}

function closeTeam(teamID: string) {
  return Database.Database.Service.use((database) =>
    database.db
      .update(TeamTable)
      .set({ status: "closed", time_updated: Date.now() })
      .where(eq(TeamTable.id, teamID))
      .run(),
  )
}

function node(type: string, id: string) {
  return `${type}:${id}`
}
