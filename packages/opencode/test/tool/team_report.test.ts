import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Database } from "@/storage/db"
import { TeamTable } from "@/team/team.sql"
import { eq } from "drizzle-orm"
import type { TeamEvalReport } from "@/team/eval"
import { Team } from "@/team/team"
import { TeamReportTool } from "@/tool/team_report"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
  ),
)

describe("tool.team_report", () => {
  it.live("includes evaluation summary and metadata", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "report-team",
            goal: "Evaluate report output",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_cancelled_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "cancelled")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ lead_session_id: lead.id }, context(lead.id))
          const evalReport = result.metadata.eval as TeamEvalReport

          expect(result.title).toBe("Team Report: report-team")
          expect(result.output).toContain("## Team throughput")
          expect(result.output).toContain("## Team usage")
          expect(result.output).toContain("- final report generated: yes")
          expect(result.output).toContain("## Cost and latency")
          expect(result.output).toContain("## Evaluation")
          expect(result.output).toContain("- root causes: 1")
          expect(result.output).toContain("Top root-cause findings:")
          expect(result.output).toContain("error execution.cancelled_member")
          expect(result.metadata.team_id).toBe(info.id)
          expect(result.metadata.throughput).toEqual(expect.objectContaining({ member_count: 1 }))
          expect(result.metadata.usage).toEqual(expect.objectContaining({ final_report_generated: true }))
          expect(evalReport.team_id).toBe(info.id)
          expect(evalReport.summary.root_cause_count).toBe(1)
          expect(evalReport.findings.some((finding) => finding.category === "execution.cancelled_member")).toBe(true)
          expect((yield* team.getUsageEvents(info.id)).map((event) => event.type)).toEqual(["report_generated"])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("reports no root causes for healthy teams", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "healthy-report-team",
            goal: "Evaluate healthy report",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_healthy_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "completed", "work complete")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id }, context(lead.id))
          const evalReport = result.metadata.eval as TeamEvalReport

          expect(result.output).toContain("- root causes: 0")
          expect(result.output).toContain("- top root causes: none")
          expect(result.metadata.usage).toEqual(expect.objectContaining({ shallow_usage: false }))
          expect(evalReport.summary.root_cause_count).toBe(0)
          expect(evalReport.nodes.some((node) => node.id === `team:${info.id}`)).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("includes daemon metrics", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "daemon-report-team", goal: "Monitor", leadSessionID: lead.id })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_daemon",
            name: "sentinel",
            agentType: "general",
            rolePrompt: "Monitor risks",
            lifecycle: "daemon",
            daemonState: "idle",
          })
          yield* team.updateMemberStatus(daemon.id, "idle", { daemonState: "idle" })

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id }, context(lead.id))

          expect(result.output).toContain("## Daemons")
          expect(result.output).toContain("- daemon members: 1")
          expect(result.output).toContain("- idle daemons: 1")
          expect(result.metadata.daemon).toEqual({
            daemon_member_count: 1,
            active_daemon_count: 0,
            idle_daemon_count: 1,
            daemon_error_count: 0,
          })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("omits read metrics while preserving delivery metrics", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "delivery-report-team",
            goal: "Evaluate delivery metrics",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_delivery_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Receive the message",
          })
          const message = yield* team.sendMessage({
            teamID: info.id,
            sender: info.lead_session_id,
            recipients: [worker.session_id],
            body: "Delivery metrics only.",
          })
          yield* team.markMessageDelivered(message.id, worker.session_id)

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id }, context(lead.id))

          expect(result.output).toContain("- delivered: 1 (100.0%)")
          expect(result.output).toContain("- pending: 0 (0.0%)")
          expect(result.output).toContain("- message delivery avg/p50:")
          expect(result.output).not.toContain("- read:")
          expect(result.metadata.messages).toEqual({ total: 1, recipient_count: 1, delivered: 1, pending: 0 })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("does not record report events for interim reports", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "interim-report-team",
            goal: "Evaluate interim report",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_active_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "active")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id }, context(lead.id))

          expect(result.title).toBe("Team Report: interim-report-team")
          expect(result.output).toContain("- final report generated: no")
          expect(result.metadata.usage).toEqual(expect.objectContaining({ final_report_generated: false }))
          expect(yield* team.getUsageEvents(info.id)).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rolls up usage percentages across teams with members", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          yield* team.create({
            name: "empty-team",
            goal: "Exclude from rollup",
            leadSessionID: "ses_report_empty_lead",
          })
          const shallowLead = yield* sessions.create({ title: "Shallow Lead" })
          const shallow = yield* team.create({
            name: "shallow-team",
            goal: "No task list",
            leadSessionID: shallowLead.id,
          })
          yield* team.addMember({
            teamID: shallow.id,
            sessionID: "ses_report_rollup_shallow_worker",
            name: "shallow-worker",
            agentType: "general",
            rolePrompt: "Do shallow work",
          })
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({
            name: "rollup-report-team",
            goal: "Evaluate rollup",
            leadSessionID: lead.id,
          })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_rollup_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
            planMode: true,
          })
          const firstTask = yield* team.createTask({ teamID: info.id, description: "First task" })
          yield* team.createTask({ teamID: info.id, description: "Second task", dependencyIDs: [firstTask.id] })
          yield* team.updateMemberStatus(worker.id, "completed", "work complete")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id }, context(lead.id))

          expect(result.metadata.usage_rollup).toEqual({
            team_session_count: 2,
            task_list_usage_percent: 50,
            dependency_modeling_percent: 50,
            plan_mode_usage_percent: 50,
            final_report_percent: 50,
            shallow_usage_percent: 50,
          })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("tool.team_report final checkpoint", () => {
  const teamRow = (teamID: string) =>
    Database.Database.Service.use((database) =>
      database.db
        .select()
        .from(TeamTable)
        .where(eq(TeamTable.id, teamID))
        .get()
        .pipe(Effect.orDie),
    )

  it.live("final:true is lead-only and rejects member sessions", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
          const info = yield* team.create({ name: "final-lead-only", goal: "Lead gate", leadSessionID: lead.id })
          const member = yield* team.addMember({
            teamID: info.id,
            sessionID: worker.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(member.id, "completed", "done")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(worker.id))

          expect(result.title).toBe("Team Report")
          expect(result.output).toContain("lead-only")
          expect(yield* team.getUsageEvents(info.id)).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("final:true rejects while a finite member is active", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "final-active", goal: "Active gate", leadSessionID: lead.id })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_final_active_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "active")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(lead.id))

          expect(result.title).toBe("Team Report")
          expect(result.output).toContain("non-terminal")
          expect(yield* team.getUsageEvents(info.id)).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("final:true rejects while a daemon is starting or running", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "final-daemon", goal: "Daemon gate", leadSessionID: lead.id })
          yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_final_daemon",
            name: "sentinel",
            agentType: "general",
            rolePrompt: "Monitor",
            lifecycle: "daemon",
            daemonState: "running",
          })

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(lead.id))

          expect(result.title).toBe("Team Report")
          expect(result.output).toContain("daemon")
          expect(yield* team.getUsageEvents(info.id)).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("final:true allows idle daemons and failed members", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "final-allowed", goal: "Allowed gate", leadSessionID: lead.id })
          const failed = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_final_failed",
            name: "failed",
            agentType: "general",
            rolePrompt: "Fail",
          })
          yield* team.updateMemberStatus(failed.id, "failed", { failureCode: "provider_error" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_final_idle_daemon",
            name: "sentinel",
            agentType: "general",
            rolePrompt: "Monitor",
            lifecycle: "daemon",
            daemonState: "idle",
          })
          yield* team.updateMemberStatus(daemon.id, "idle", { daemonState: "idle" })

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(lead.id))

          expect(result.metadata.final).toBe(true)
          expect(result.metadata.stale).toBe(false)
          expect(result.output).toContain("- final: yes")
          expect(result.output).toContain("- stale: no")
          expect(result.output).toContain("error execution.failed_member")
          const row = yield* teamRow(info.id)
          expect(row?.final_report_revision).toBe(row?.revision)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("protocol-0 teams skip the task gate and allow pending tasks", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "final-protocol0", goal: "Task gate skip", leadSessionID: lead.id })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_final_protocol0_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "completed", "done")
          yield* team.createTask({ teamID: info.id, description: "Unfinished on purpose" })

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(lead.id))

          expect(result.metadata.final).toBe(true)
          expect(result.metadata.stale).toBe(false)
          const row = yield* teamRow(info.id)
          expect(row?.final_report_revision).toBe(row?.revision)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("final:true records the checkpoint event with revision, final, and stale flags", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "final-success", goal: "Success path", leadSessionID: lead.id })
          const worker = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_report_final_success_worker",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(worker.id, "completed", "done")
          const rowBefore = yield* teamRow(info.id)
          const revisionBefore = rowBefore?.revision ?? -1

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(lead.id))

          expect(result.metadata.final).toBe(true)
          expect(result.metadata.stale).toBe(false)
          expect(result.metadata.revision).toBe(revisionBefore)

          const row = yield* teamRow(info.id)
          expect(row?.final_report_revision).toBe(revisionBefore)
          expect(row?.revision).toBe(revisionBefore)
          const events = yield* team.getUsageEvents(info.id)
          expect(events).toHaveLength(1)
          expect(events[0]).toEqual(
            expect.objectContaining({
              team_id: info.id,
              type: "report_generated",
              metadata: expect.objectContaining({
                revision: revisionBefore,
                final: true,
                stale: false,
              }),
            }),
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("build-then-record with a mutation between them returns stale and records nothing", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
          const info = yield* team.create({ name: "final-stale", goal: "Stale barrier", leadSessionID: lead.id })
          const member = yield* team.addMember({
            teamID: info.id,
            sessionID: worker.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(member.id, "completed", "done")

          // Controlled barrier: build the report at revision N, then mutate the team before record.
          const built = yield* team.buildFinalReport(info.id)
          yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [worker.id],
            body: "Concurrent material mutation.",
          })
          const recorded = yield* team.recordFinalReport({
            teamID: info.id,
            revision: built.revision,
            sessionID: lead.id,
          })

          expect(recorded).toBe(false)
          const row = yield* teamRow(info.id)
          expect(row?.final_report_revision).toBeNull()
          expect(row?.revision).toBe(built.revision + 1)
          expect(yield* team.getUsageEvents(info.id)).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a later material mutation invalidates a recorded final checkpoint", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
          const info = yield* team.create({ name: "final-invalidate", goal: "Invalidate", leadSessionID: lead.id })
          const member = yield* team.addMember({
            teamID: info.id,
            sessionID: worker.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          yield* team.updateMemberStatus(member.id, "completed", "done")

          const tool = yield* TeamReportTool
          const def = yield* tool.init()
          const result = yield* def.execute({ team_id: info.id, final: true }, context(lead.id))
          expect(result.metadata.stale).toBe(false)

          let row = yield* teamRow(info.id)
          expect(row?.final_report_revision).toBe(row?.revision)

          // A later material mutation (a message) moves the revision and invalidates the checkpoint.
          yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [worker.id],
            body: "After the final report.",
          })
          row = yield* teamRow(info.id)
          expect(row?.revision).toBeGreaterThan(row?.final_report_revision ?? -1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

function context(sessionID: SessionID): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}
