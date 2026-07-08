import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
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

describe("tool.team_shutdown", () => {
  it.live("returns disabled message when agent teams are disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const lead = yield* sessions.create({ title: "Lead" })
        const tool = yield* TeamShutdownTool
        const def = yield* tool.init()

        const result = yield* def.execute({}, context(lead.id))

        expect(result.title).toBe("Team Shutdown")
        expect(result.output).toBe("Agent teams disabled.")
      }),
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

  it.live("shuts down the active team for the lead", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "shutdown", goal: "Close", leadSessionID: lead.id })
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context(lead.id))
          const after = yield* team.get(info.id)

          expect(result.title).toBe("Team Shut Down")
          expect(result.output).toBe("Team shut down successfully.")
          expect(Option.isSome(after)).toBe(true)
          if (Option.isSome(after)) expect(after.value.status).toBe("closed")
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
          const tool = yield* TeamShutdownTool
          const def = yield* tool.init()

          yield* def.execute({}, context(lead.id))
          const members = yield* team.getMembers(info.id)

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
