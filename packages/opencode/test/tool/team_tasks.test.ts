import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TeamTaskTable } from "@/team/team.sql"
import { Team } from "@/team/team"
import { TeamTaskClaimTool } from "@/tool/team_task_claim"
import { TeamTaskCreateTool } from "@/tool/team_task_create"
import { TeamTaskListTool } from "@/tool/team_task_list"
import { TeamTaskUpdateTool } from "@/tool/team_task_update"
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

describe("tool.team_tasks", () => {
  it.live("creates, lists, claims, and updates tasks through direct tools", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-happy")
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const listTool = yield* TeamTaskListTool
          const listDef = yield* listTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          const created = yield* createDef.execute(
            { description: "Implement the task workflow", assignee: seed.worker.session_id },
            context(seed.lead.id),
          )
          const taskID = (yield* getTasks(seed.info.id)).find(
            (task) => task.description === "Implement the task workflow",
          )?.id
          const listed = yield* listDef.execute({}, context(seed.lead.id))

          if (!taskID) throw new Error("created task was not persisted")
          const claimed = yield* claimDef.execute({ task_id: taskID }, context(seed.worker.session_id))
          const updated = yield* updateDef.execute(
            { task_id: taskID, status: "completed" },
            context(seed.worker.session_id),
          )
          const row = yield* getTask(taskID)

          expect(created.title).toBe("Task Created")
          expect(created.output).toContain("Implement the task workflow")
          expect(listed.title).toBe("Team Tasks")
          expect(listed.output).toContain("Implement the task workflow")
          expect(claimed.title).toBe("Task Claimed")
          expect(updated.title).toBe("Task Updated")
          expect(row?.status).toBe("completed")
          expect(row?.assignee).toBe(seed.worker.session_id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("accepts unambiguous task ID prefixes for claim and update", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-prefix")
          yield* insertTask({ id: "task_prefix_other", teamID: seed.info.id, description: "Other task" })
          yield* insertTask({ id: "task_prefix_target", teamID: seed.info.id, description: "Prefix target" })
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          const claimed = yield* claimDef.execute({ task_id: "task_prefix_t" }, context(seed.worker.session_id))
          const updated = yield* updateDef.execute(
            { task_id: "task_prefix_t", status: "completed" },
            context(seed.worker.session_id),
          )
          const row = yield* getTask("task_prefix_target")

          expect(claimed.title).toBe("Task Claimed")
          expect(updated.title).toBe("Task Updated")
          expect(row?.status).toBe("completed")
          expect(row?.assignee).toBe(seed.worker.session_id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects ambiguous task ID prefixes without mutating tasks", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-ambiguous")
          yield* insertTask({ id: "task_ambiguous_alpha", teamID: seed.info.id, description: "Alpha" })
          yield* insertTask({ id: "task_ambiguous_alpine", teamID: seed.info.id, description: "Alpine" })
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()

          const result = yield* claimDef.execute({ task_id: "task_ambiguous_al" }, context(seed.worker.session_id))
          const alpha = yield* getTask("task_ambiguous_alpha")
          const alpine = yield* getTask("task_ambiguous_alpine")

          expect(result.title).toBe("Task Claim Failed")
          expect(result.output.toLowerCase()).toContain("ambiguous")
          expect(alpha?.status).toBe("pending")
          expect(alpha?.assignee).toBeNull()
          expect(alpine?.status).toBe("pending")
          expect(alpine?.assignee).toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects wrong-team claim and update attempts", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const owner = yield* seedTeam("tasks-owner")
          const other = yield* seedTeam("tasks-other")
          yield* insertTask({ id: "task_wrong_team", teamID: owner.info.id, description: "Owner task" })
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          const claimed = yield* claimDef.execute({ task_id: "task_wrong_team" }, context(other.worker.session_id))
          const updated = yield* updateDef.execute(
            { task_id: "task_wrong_team", status: "completed" },
            context(other.worker.session_id),
          )
          const row = yield* getTask("task_wrong_team")

          expect(claimed.title).toBe("Task Claim Failed")
          expect(claimed.output.toLowerCase()).toContain("claim")
          expect(claimed.output.toLowerCase()).toContain("task")
          expect(updated.title).toBe("Task Update Failed")
          expect(updated.output.toLowerCase()).toContain("task")
          expect(row?.status).toBe("pending")
          expect(row?.assignee).toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("allows lead or assigned teammate to update and rejects unrelated teammates", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-ownership")
          yield* insertTask({ id: "task_lead_update", teamID: seed.info.id, description: "Lead task" })
          yield* insertTask({
            id: "task_assignee_update",
            teamID: seed.info.id,
            description: "Assignee task",
            assignee: seed.worker.session_id,
          })
          yield* insertTask({
            id: "task_unrelated_update",
            teamID: seed.info.id,
            description: "Unrelated task",
            assignee: seed.worker.session_id,
          })
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          const leadUpdated = yield* updateDef.execute(
            { task_id: "task_lead_update", status: "completed" },
            context(seed.lead.id),
          )
          const assigneeUpdated = yield* updateDef.execute(
            { task_id: "task_assignee_update", status: "completed" },
            context(seed.worker.session_id),
          )
          const unrelatedUpdated = yield* updateDef.execute(
            { task_id: "task_unrelated_update", status: "completed" },
            context(seed.other.session_id),
          )
          const unrelated = yield* getTask("task_unrelated_update")

          expect(leadUpdated.title).toBe("Task Updated")
          expect(assigneeUpdated.title).toBe("Task Updated")
          expect(unrelatedUpdated.title).toBe("Task Update Failed")
          expect(unrelatedUpdated.output.toLowerCase()).toContain("assigned")
          expect(unrelated?.status).toBe("pending")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects nonexistent dependencies in create", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-missing-dep")
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()

          const result = yield* createDef.execute(
            { description: "Blocked task", dependency_ids: ["missing_dependency"] },
            context(seed.lead.id),
          )
          const tasks = yield* getTasks(seed.info.id)

          expect(result.title).toBe("Task Create Failed")
          expect(result.output.toLowerCase()).toContain("dependency")
          expect(result.output.toLowerCase()).toContain("not found")
          expect(tasks).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects cross-team dependencies in create", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const owner = yield* seedTeam("tasks-dep-owner")
          const other = yield* seedTeam("tasks-dep-other")
          yield* insertTask({ id: "task_foreign_dependency", teamID: owner.info.id, description: "Foreign dependency" })
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()

          const result = yield* createDef.execute(
            { description: "Cross-team blocked", dependency_ids: ["task_foreign_dependency"] },
            context(other.lead.id),
          )
          const tasks = yield* getTasks(other.info.id)

          expect(result.title).toBe("Task Create Failed")
          expect(result.output.toLowerCase()).toContain("dependency")
          expect(result.output.toLowerCase()).toContain("not found")
          expect(tasks).toEqual([])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("does not unblock claim when a dependency is cancelled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-cancelled-dep")
          yield* insertTask({
            id: "task_cancelled_dependency",
            teamID: seed.info.id,
            description: "Cancelled dependency",
            status: "cancelled",
          })
          yield* insertTask({
            id: "task_waiting_on_cancelled",
            teamID: seed.info.id,
            description: "Waiting task",
            dependencyIDs: ["task_cancelled_dependency"],
          })
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()

          const result = yield* claimDef.execute(
            { task_id: "task_waiting_on_cancelled" },
            context(seed.worker.session_id),
          )
          const row = yield* getTask("task_waiting_on_cancelled")

          expect(result.title).toBe("Task Claim Failed")
          expect(result.output.toLowerCase()).toContain("claim")
          expect(result.output.toLowerCase()).toContain("task")
          expect(row?.status).toBe("pending")
          expect(row?.assignee).toBeNull()
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

const seedTeam = Effect.fn("TeamTasksTest.seedTeam")(function* (name: string) {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const lead = yield* sessions.create({ title: `${name} Lead` })
  const info = yield* team.create({ name, goal: "Coordinate task work", leadSessionID: lead.id })
  const workerSession = yield* sessions.create({ parentID: lead.id, title: `${name} Worker` })
  const worker = yield* team.addMember({
    teamID: info.id,
    sessionID: workerSession.id,
    name: `${name}-worker`,
    agentType: "general",
    rolePrompt: "Do the work",
  })
  const otherSession = yield* sessions.create({ parentID: lead.id, title: `${name} Other` })
  const other = yield* team.addMember({
    teamID: info.id,
    sessionID: otherSession.id,
    name: `${name}-other`,
    agentType: "general",
    rolePrompt: "Do unrelated work",
  })
  yield* team.updateMemberStatus(worker.id, "active")
  yield* team.updateMemberStatus(other.id, "active")
  return { lead, info, worker, other }
})

const insertTask = Effect.fn("TeamTasksTest.insertTask")(function* (input: {
  id: string
  teamID: string
  description: string
  status?: "pending" | "in_progress" | "completed" | "cancelled"
  assignee?: string
  dependencyIDs?: string[]
}) {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(TeamTaskTable)
    .values({
      id: input.id,
      team_id: input.teamID,
      description: input.description,
      status: input.status ?? "pending",
      assignee: input.assignee ?? null,
      dependency_ids: input.dependencyIDs ?? null,
      metadata: null,
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
})

const getTask = Effect.fn("TeamTasksTest.getTask")(function* (id: string) {
  const { db } = yield* Database.Service
  return yield* db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, id)).get().pipe(Effect.orDie)
})

const getTasks = Effect.fn("TeamTasksTest.getTasks")(function* (teamID: string) {
  const { db } = yield* Database.Service
  return yield* db.select().from(TeamTaskTable).where(eq(TeamTaskTable.team_id, teamID)).all().pipe(Effect.orDie)
})
