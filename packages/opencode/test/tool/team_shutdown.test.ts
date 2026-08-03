import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { and, eq } from "drizzle-orm"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamTable, TeamUsageEventTable } from "@/team/team.sql"
import { TeamShutdownTool } from "@/tool/team_shutdown"
import type { Context } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const setLegacyProtocol = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  yield* db.update(TeamTable).set({ protocol_version: 0 }).where(eq(TeamTable.id, teamID)).run().pipe(Effect.orDie)
})

describe("tool.team_shutdown", () => {
  it.live("returns disabled message when agent teams are explicitly disabled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(lead.id))

          expect(result.title).toBe("Team Shutdown")
          expect(result.output).toBe("Agent teams disabled.")
        }),
      { config: { experimental: { agent_teams: false } } },
    ),
  )

  it.live("returns no active team when the session has none", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(lead.id))

          expect(result.title).toBe("Team Shutdown")
          expect(result.output).toBe("No active team.")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("shuts down the active team for the lead and returns stable counts", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown", goal: "Close", leadSessionID: lead.id })
          yield* setLegacyProtocol(info.id)
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(lead.id))
          const after = yield* team.get(info.id)

          expect(result.title).toBe("Team Shut Down")
          expect(result.output).toContain("Team shut down successfully.")
          expect(result.metadata).toMatchObject({
            cancelledMembers: 0,
            cancelledTasks: 0,
            releasedReservations: 0,
            sessionCancellationFailures: 0,
          })
          expect(Option.isSome(after)).toBe(true)
          if (Option.isSome(after)) expect(after.value.status).toBe("closed")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects a member session explicitly as lead-only", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-member", goal: "Close", leadSessionID: lead.id })
          yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_shutdown_member",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(SessionID.make("ses_shutdown_member")))
          const after = yield* team.get(info.id)

          expect(result.title).toBe("Team Shutdown Failed")
          expect(result.output).toBe("Only the team lead can shut down a team.")
          expect(Option.isSome(after)).toBe(true)
          if (Option.isSome(after)) expect(after.value.status).toBe("active")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects protocol-1 normal shutdown without a current final report", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-p1", goal: "Close", leadSessionID: lead.id })
          const { db } = yield* Database.Service
          yield* db
            .update(TeamTable)
            .set({ protocol_version: 1 })
            .where(eq(TeamTable.id, info.id))
            .run()
            .pipe(Effect.orDie)
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(lead.id))
          const after = yield* team.get(info.id)

          expect(result.title).toBe("Team Shutdown Rejected")
          expect(result.output).toContain("final report")
          expect(Option.isSome(after)).toBe(true)
          if (Option.isSome(after)) expect(after.value.status).toBe("active")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("forced shutdown with a reason bypasses the final-report gate and records the event", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-force", goal: "Close", leadSessionID: lead.id })
          yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_shutdown_force_member",
            name: "worker",
            agentType: "general",
            rolePrompt: "Do the work",
          })
          const { db } = yield* Database.Service
          yield* db
            .update(TeamTable)
            .set({ protocol_version: 1 })
            .where(eq(TeamTable.id, info.id))
            .run()
            .pipe(Effect.orDie)
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({ force: true, reason: "team wedged" }, context(lead.id))
          const after = yield* team.get(info.id)
          const forcedEvents = yield* db
            .select()
            .from(TeamUsageEventTable)
            .where(and(eq(TeamUsageEventTable.team_id, info.id), eq(TeamUsageEventTable.type, "forced_shutdown")))
            .all()
            .pipe(Effect.orDie)

          expect(result.title).toBe("Team Shut Down")
          expect(Option.isSome(after)).toBe(true)
          if (Option.isSome(after)) expect(after.value.status).toBe("closed")
          expect(forcedEvents).toHaveLength(1)
          expect(forcedEvents[0]?.metadata).toEqual(expect.objectContaining({ reason: "team wedged", force: true }))
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("forced shutdown without a nonblank reason is rejected", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-force-noreason", goal: "Close", leadSessionID: lead.id })
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const missing = yield* def.execute({ force: true }, context(lead.id))
          const blank = yield* def.execute({ force: true, reason: "   " }, context(lead.id))
          const after = yield* team.get(info.id)

          expect(missing.title).toBe("Team Shutdown Rejected")
          expect(missing.output).toContain("reason")
          expect(blank.title).toBe("Team Shutdown Rejected")
          expect(blank.output).toContain("reason")
          expect(Option.isSome(after)).toBe(true)
          if (Option.isSome(after)) expect(after.value.status).toBe("active")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("cancels non-completed members and preserves completed members", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-members", goal: "Close", leadSessionID: lead.id })
          const active = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_shutdown_active",
            name: "active",
            agentType: "general",
            rolePrompt: "Keep working",
          })
          const completed = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_shutdown_completed",
            name: "completed",
            agentType: "general",
            rolePrompt: "Finish",
          })
          yield* team.updateMemberStatus(active.id, "active")
          yield* team.updateMemberStatus(completed.id, "completed")
          yield* setLegacyProtocol(info.id)
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(lead.id))
          const members = yield* team.getMembers(info.id)

          expect(result.metadata.cancelledMembers).toBe(1)
          expect(members.find((member) => member.id === active.id)?.status).toBe("cancelled")
          expect(members.find((member) => member.id === completed.id)?.status).toBe("completed")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("cancels daemon state on shutdown", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-daemon", goal: "Close", leadSessionID: lead.id })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_shutdown_daemon",
            name: "sentinel",
            agentType: "general",
            rolePrompt: "Monitor",
            lifecycle: "daemon",
            daemonState: "idle",
          })
          yield* team.updateMemberStatus(daemon.id, "idle", { daemonState: "idle" })
          yield* setLegacyProtocol(info.id)
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          yield* def.execute({}, context(lead.id))
          const member = (yield* team.getMembers(info.id)).find((member) => member.id === daemon.id)

          expect(member?.status).toBe("cancelled")
          expect(member?.daemon_state).toBe("cancelled")
          expect(member?.daemon_last_active).toBeNumber()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("shutdown does not cancel failed members", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown-failed", goal: "Close", leadSessionID: lead.id })
          const failed = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_shutdown_failed",
            name: "failed",
            agentType: "general",
            rolePrompt: "Fail",
          })
          yield* team.updateMemberStatus(failed.id, "failed", { failureCode: "provider_error" })
          yield* setLegacyProtocol(info.id)
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          yield* def.execute({}, context(lead.id))
          const member = (yield* team.getMembers(info.id)).find((member) => member.id === failed.id)

          expect(member?.status).toBe("failed")
          expect(member?.failure_code).toBe("provider_error")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

function context(sessionID: SessionID): Context {
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
