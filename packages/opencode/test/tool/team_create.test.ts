import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamTable } from "@/team/team.sql"
import { TeamCreateTool } from "@/tool/team_create"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { and, eq } from "drizzle-orm"
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

function context(sessionID: SessionID) {
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

describe("tool.team_create", () => {
  it.live("creates a team from a primary session", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "primary", goal: "Coordinate work" }, context(lead.id))
          const active = yield* team.getActive(lead.id)
          const { db } = yield* Database.Service
          const stored = yield* db
            .select({ protocolVersion: TeamTable.protocol_version })
            .from(TeamTable)
            .where(eq(TeamTable.lead_session_id, lead.id))
            .get()
            .pipe(Effect.orDie)

          expect(result.title).toBe("Team Created")
          expect(Option.isSome(active)).toBe(true)
          if (Option.isSome(active)) expect(active.value.protocol_version).toBe(1)
          expect(stored?.protocolVersion).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects child sessions before creating a team", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const child = yield* sessions.create({ parentID: lead.id, title: "Subagent" })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "nested", goal: "Nested work" }, context(child.id))

          expect(result.title).toBe("Team Create Failed")
          expect(result.output).toContain("Child sessions cannot create teams")
          expect(Option.isNone(yield* team.getActive(child.id))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("duplicate create returns stable Team Create Failed with existing team identity", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const existing = yield* team.create({ name: "primary", goal: "Coordinate work", leadSessionID: lead.id })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "duplicate", goal: "Duplicate work" }, context(lead.id))

          expect(result.title).toBe("Team Create Failed")
          expect(result.output).toContain(existing.name)
          expect(result.output).toContain(existing.id)
          expect(result.output).toContain("Reuse that team")
          expect(result.output).toContain("team_shutdown")
          expect(Option.isSome(yield* team.getActive(lead.id))).toBe(true)

          // The duplicate create must not add a second active team row.
          const { db } = yield* Database.Service
          const rows = yield* db
            .select({ id: TeamTable.id })
            .from(TeamTable)
            .where(and(eq(TeamTable.lead_session_id, lead.id), eq(TeamTable.status, "active")))
            .all()
            .pipe(Effect.orDie)
          expect(rows).toHaveLength(1)
          expect(rows[0]?.id).toBe(existing.id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects teammate sessions before creating a team", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "primary", goal: "Coordinate work", leadSessionID: lead.id })
          const teammate = yield* sessions.create({ parentID: lead.id, title: "Teammate" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: teammate.id,
            name: "teammate",
            agentType: "general",
            rolePrompt: "Work",
          })
          const tool = yield* TeamCreateTool
          const def = yield* tool.init()

          const result = yield* def.execute({ name: "nested", goal: "Nested work" }, context(teammate.id))

          expect(result.title).toBe("Team Create Failed")
          expect(result.output).toContain("Team members cannot create nested teams")
          expect(Option.isNone(yield* team.getActive(teammate.id))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
