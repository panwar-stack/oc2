import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { eq, isNull } from "drizzle-orm"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TeamTable, TeamTaskTable } from "@/team/team.sql"
import { Team } from "@/team/team"
import { TeamTaskClaimTool } from "@/tool/team_task_claim"
import { TeamTaskCreateTool } from "@/tool/team_task_create"
import { TeamTaskListTool } from "@/tool/team_task_list"
import { TeamTaskUpdateTool } from "@/tool/team_task_update"
import { TeamFileOwnershipTable } from "@oc2-ai/core/team/ownership.sql"
import type { Context } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { ModelID, ProviderID } from "@/provider/schema"
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
    FSUtil.defaultLayer,
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

  it.live("blocks an unchanged same-turn task-list repeat before retrieval without team writes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const baseTeam = yield* Team.Service
          const seed = yield* seedTeam("tasks-poll-block")
          const turn = yield* startTurn({ session: seed.lead, text: "Inspect the current tasks.", synthetic: false })
          const retrievals = { value: 0 }
          const observedTeam = Team.Service.of({
            ...baseTeam,
            getTasks: (teamID) =>
              Effect.sync(() => {
                retrievals.value++
              }).pipe(Effect.andThen(baseTeam.getTasks(teamID))),
          })
          const listTool = yield* TeamTaskListTool.pipe(Effect.provideService(Team.Service, observedTeam))
          const listDef = yield* listTool.init()

          const first = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: turn.assistant,
              callID: "task-list-first",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )
          expect(first.title).toBe("Team Tasks")
          expect(first.output).toBe("No tasks found.")
          expect(first.metadata).toEqual(expect.objectContaining({ revision: expect.any(Number), repeated: false }))
          expect(retrievals.value).toBe(1)

          yield* storeTaskListRead({
            assistant: turn.assistant,
            callID: "task-list-first",
            result: first,
          })
          const continuation = yield* createAssistant(seed.lead, turn.user.id)
          const before = yield* getTeamRow(seed.info.id)

          const blocked = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: continuation,
              callID: "task-list-repeat",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )
          const after = yield* getTeamRow(seed.info.id)

          expect(blocked.title).toBe("Team Tasks (Polling Blocked)")
          expect(blocked.output).toContain("Repeated unchanged task-list read suppressed")
          expect(blocked.output).toContain("finish the current response normally")
          expect(blocked.metadata).toEqual(
            expect.objectContaining({ revision: first.metadata.revision, repeated: true }),
          )
          expect(retrievals.value).toBe(1)
          expect(after).toEqual(before)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("allows a same-turn task-list read after the team revision changes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const seed = yield* seedTeam("tasks-poll-revision")
          const turn = yield* startTurn({ session: seed.lead, text: "Plan the task work.", synthetic: false })
          const listTool = yield* TeamTaskListTool
          const listDef = yield* listTool.init()
          const first = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: turn.assistant,
              callID: "task-list-before-change",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )
          yield* storeTaskListRead({
            assistant: turn.assistant,
            callID: "task-list-before-change",
            result: first,
          })

          yield* team.createTask({ teamID: seed.info.id, description: "Material revision change" }).pipe(Effect.orDie)
          const continuation = yield* createAssistant(seed.lead, turn.user.id)
          const result = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: continuation,
              callID: "task-list-after-change",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )
          const current = yield* getTeamRow(seed.info.id)

          expect(result.title).toBe("Team Tasks")
          expect(result.output).toContain("Material revision change")
          expect(result.metadata).toEqual(expect.objectContaining({ revision: current?.revision, repeated: false }))
          expect(result.metadata.revision).toBe(first.metadata.revision + 1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("allows unchanged task-list reads in new real and synthetic user turns", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const seed = yield* seedTeam("tasks-poll-turns")
          yield* team.createTask({ teamID: seed.info.id, description: "Stable task" }).pipe(Effect.orDie)
          const listTool = yield* TeamTaskListTool
          const listDef = yield* listTool.init()

          const initialTurn = yield* startTurn({ session: seed.lead, text: "List tasks.", synthetic: false })
          const initial = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: initialTurn.assistant,
              callID: "task-list-initial-turn",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )
          yield* storeTaskListRead({
            assistant: initialTurn.assistant,
            callID: "task-list-initial-turn",
            result: initial,
          })

          const realTurn = yield* startTurn({ session: seed.lead, text: "List tasks again.", synthetic: false })
          const real = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: realTurn.assistant,
              callID: "task-list-real-turn",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )
          yield* storeTaskListRead({
            assistant: realTurn.assistant,
            callID: "task-list-real-turn",
            result: real,
          })

          const syntheticTurn = yield* startTurn({
            session: seed.lead,
            text: "<team-messages>New coordination input.</team-messages>",
            synthetic: true,
          })
          const synthetic = yield* listDef.execute(
            {},
            context(seed.lead.id, {
              assistant: syntheticTurn.assistant,
              callID: "task-list-synthetic-turn",
              messages: yield* sessions.messages({ sessionID: seed.lead.id }),
            }),
          )

          expect(real.title).toBe("Team Tasks")
          expect(real.output).toContain("Stable task")
          expect(real.metadata).toEqual(
            expect.objectContaining({ revision: initial.metadata.revision, repeated: false }),
          )
          expect(synthetic.title).toBe("Team Tasks")
          expect(synthetic.output).toContain("Stable task")
          expect(synthetic.metadata).toEqual(
            expect.objectContaining({ revision: initial.metadata.revision, repeated: false }),
          )
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

  it.live("rejects a stale task update when the team closes after the tool precheck", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-close-race")
          const baseTeam = yield* Team.Service
          const { db } = yield* Database.Service
          yield* insertTask({ id: "task_close_race", teamID: seed.info.id, description: "Must stay pending" })
          const racingTeam = Team.Service.of({
            ...baseTeam,
            getTask: (teamID, taskID) =>
              baseTeam
                .getTask(teamID, taskID)
                .pipe(
                  Effect.tap(() =>
                    db
                      .update(TeamTable)
                      .set({ status: "closed" })
                      .where(eq(TeamTable.id, seed.info.id))
                      .run()
                      .pipe(Effect.orDie),
                  ),
                ),
          })
          const updateTool = yield* TeamTaskUpdateTool.pipe(Effect.provideService(Team.Service, racingTeam))
          const updateDef = yield* updateTool.init()

          const result = yield* updateDef.execute(
            { task_id: "task_close_race", status: "completed" },
            context(seed.lead.id),
          )
          const row = yield* getTask("task_close_race")

          expect(result.title).toBe("Task Update Failed")
          expect(result.output).toContain("not active")
          expect(row?.status).toBe("pending")
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

  it.live("creates an owned task with active reservations and lists owned paths", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-create")
          const owned = path.join(directory, "owned.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const listTool = yield* TeamTaskListTool
          const listDef = yield* listTool.init()

          const created = yield* createDef.execute(
            { description: "Owned create", owned_paths: [owned] },
            context(seed.lead.id),
          )
          const { db } = yield* Database.Service
          const task = yield* getTasks(seed.info.id)
          const taskID = task.find((row) => row.description === "Owned create")?.id
          if (!taskID) throw new Error("owned task was not persisted")
          const reservations = yield* db
            .select()
            .from(TeamFileOwnershipTable)
            .where(eq(TeamFileOwnershipTable.task_id, taskID))
            .all()
            .pipe(Effect.orDie)
          const listed = yield* listDef.execute({}, context(seed.lead.id))

          expect(created.title).toBe("Task Created")
          expect(reservations).toHaveLength(1)
          expect(reservations[0]?.owner_session_id).toBeNull()
          expect(reservations[0]?.time_released).toBeNull()
          expect(reservations[0]?.display_path).toBe("owned.txt")
          expect(listed.output).toContain("owned.txt")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects an owned task reserving a path already active for another team and rolls back fully", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const owner = yield* seedTeam("tasks-owned-conflict-owner")
          const other = yield* seedTeam("tasks-owned-conflict-other")
          const shared = path.join(directory, "shared.txt")
          yield* Effect.promise(() => fs.writeFile(shared, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()

          const first = yield* createDef.execute(
            { description: "Reserves shared", owned_paths: [shared] },
            context(owner.lead.id),
          )
          expect(first.title).toBe("Task Created")

          const second = yield* createDef.execute(
            { description: "Conflicts with shared", owned_paths: [shared] },
            context(other.lead.id),
          )
          expect(second.title).toBe("Task Create Failed")
          expect(second.output.toLowerCase()).toContain("already reserved")
          expect(second.output).toContain("shared.txt")

          const ownerTasks = yield* getTasks(owner.info.id)
          const otherTasks = yield* getTasks(other.info.id)
          expect(ownerTasks).toHaveLength(1)
          expect(otherTasks).toHaveLength(0)
          const { db } = yield* Database.Service
          const rows = yield* db.select().from(TeamFileOwnershipTable).all().pipe(Effect.orDie)
          expect(rows).toHaveLength(1)
          expect(rows[0]?.display_path).toBe("shared.txt")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects a duplicate owned path alias within one create", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-dup")
          const a = path.join(directory, "Alias.txt")
          yield* Effect.promise(() => fs.writeFile(a, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()

          const result = yield* createDef.execute(
            { description: "Duplicate alias", owned_paths: [a, path.join(directory, "alias.txt")] },
            context(seed.lead.id),
          )
          expect(result.title).toBe("Task Create Failed")
          const tasks = yield* getTasks(seed.info.id)
          expect(tasks).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("claim binds all reservations to the claiming session", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-claim")
          const a = path.join(directory, "claim-a.txt")
          const b = path.join(directory, "claim-b.txt")
          yield* Effect.promise(() => fs.writeFile(a, "x"))
          yield* Effect.promise(() => fs.writeFile(b, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()

          yield* createDef.execute({ description: "Claim owned", owned_paths: [a, b] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Claim owned")
          if (!task) throw new Error("owned task was not persisted")

          const claimed = yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))
          const { db } = yield* Database.Service
          const rows = yield* db
            .select()
            .from(TeamFileOwnershipTable)
            .where(eq(TeamFileOwnershipTable.task_id, task.id))
            .all()
            .pipe(Effect.orDie)

          expect(claimed.title).toBe("Task Claimed")
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            expect(row.owner_session_id).toBe(seed.worker.session_id)
            expect(row.time_released).toBeNull()
          }
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects pending to completed for an owned task", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-pending-complete")
          const owned = path.join(directory, "pending-complete.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "No direct complete", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "No direct complete")
          if (!task) throw new Error("owned task was not persisted")

          const updated = yield* updateDef.execute({ task_id: task.id, status: "completed" }, context(seed.lead.id))
          const row = yield* getTask(task.id)

          expect(updated.title).toBe("Task Update Failed")
          expect(updated.output.toLowerCase()).toContain("pending")
          expect(row?.status).toBe("pending")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects in-progress reassignment of an owned task", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-reassign")
          const owned = path.join(directory, "reassign.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "No reassign", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "No reassign")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))

          const updated = yield* updateDef.execute(
            { task_id: task.id, assignee: seed.other.session_id },
            context(seed.lead.id),
          )
          const row = yield* getTask(task.id)

          expect(updated.title).toBe("Task Update Failed")
          expect(updated.output.toLowerCase()).toContain("reassign")
          expect(row?.assignee).toBe(seed.worker.session_id)
          expect(row?.status).toBe("in_progress")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("only the owner can complete an owned task; the lead cannot", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-complete")
          const owned = path.join(directory, "complete.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Owner complete", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Owner complete")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))

          const leadComplete = yield* updateDef.execute(
            { task_id: task.id, status: "completed" },
            context(seed.lead.id),
          )
          expect(leadComplete.title).toBe("Task Update Failed")
          expect(leadComplete.output.toLowerCase()).toContain("owner")

          const ownerComplete = yield* updateDef.execute(
            {
              task_id: task.id,
              status: "completed",
              assignee: seed.worker.session_id,
              handoff: {
                summary: "Completed the owned task",
                changed_paths: [owned],
                verification: [{ command: "bun test", status: "passed" }],
              },
            },
            context(seed.worker.session_id),
          )
          const row = yield* getTask(task.id)

          expect(ownerComplete.title).toBe("Task Updated")
          expect(row?.status).toBe("completed")
          expect(row?.metadata?.handoff).toEqual(expect.objectContaining({ summary: "Completed the owned task" }))
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("completion releases reservations atomically and keeps the rows", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-release")
          const owned = path.join(directory, "release.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Release on complete", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Release on complete")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))
          const { db } = yield* Database.Service

          yield* updateDef.execute(
            {
              task_id: task.id,
              status: "completed",
              handoff: {
                summary: "Released the reserved file",
                changed_paths: [owned],
                verification: [{ command: "bun test", status: "passed" }],
              },
            },
            context(seed.worker.session_id),
          )

          const rows = yield* db
            .select()
            .from(TeamFileOwnershipTable)
            .where(eq(TeamFileOwnershipTable.task_id, task.id))
            .all()
            .pipe(Effect.orDie)
          expect(rows).toHaveLength(1)
          expect(rows[0]?.time_released).not.toBeNull()
          expect(rows[0]?.owner_session_id).toBe(seed.worker.session_id)
          // The released path is available for a new reservation.
          const again = yield* createDef.execute(
            { description: "Reuses released path", owned_paths: [owned] },
            context(seed.lead.id),
          )
          expect(again.title).toBe("Task Created")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("the owner or the lead can cancel an owned task and release its reservations", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-cancel")
          const owned = path.join(directory, "cancel.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Cancel owned", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Cancel owned")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))

          const cancelled = yield* updateDef.execute({ task_id: task.id, status: "cancelled" }, context(seed.lead.id))
          const { db } = yield* Database.Service
          const rows = yield* db
            .select()
            .from(TeamFileOwnershipTable)
            .where(eq(TeamFileOwnershipTable.task_id, task.id))
            .all()
            .pipe(Effect.orDie)

          expect(cancelled.title).toBe("Task Updated")
          expect((yield* getTask(task.id))?.status).toBe("cancelled")
          expect(rows[0]?.time_released).not.toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("claim rejects an owned task whose reservation is owned by a different session", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-foreign-owner")
          const owned = path.join(directory, "foreign.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const { db } = yield* Database.Service

          yield* createDef.execute({ description: "Foreign owner claim", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Foreign owner claim")
          if (!task) throw new Error("owned task was not persisted")
          // Force the reservation to another owner while the task stays pending.
          yield* db
            .update(TeamFileOwnershipTable)
            .set({ owner_session_id: "ses_foreign_owner" })
            .where(eq(TeamFileOwnershipTable.task_id, task.id))
            .run()
            .pipe(Effect.orDie)

          const result = yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))
          const row = yield* getTask(task.id)

          expect(result.title).toBe("Task Claim Failed")
          expect(row?.status).toBe("pending")
          expect(row?.assignee).toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("lists tasks ordered by (time_created, id) with owned paths via the service", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-order")
          const owned = path.join(directory, "order.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          yield* createDef.execute({ description: "Owned order", owned_paths: [owned] }, context(seed.lead.id))
          yield* createDef.execute({ description: "Plain order" }, context(seed.lead.id))
          const team = yield* Team.Service

          const tasks = yield* team.getTasks(seed.info.id)
          expect(tasks).toHaveLength(2)
          expect(tasks[0]?.time_created).toBeLessThanOrEqual(tasks[1]?.time_created ?? 0)
          const ownedTask = tasks.find((task) => task.owned_paths.length > 0)
          expect(ownedTask?.owned_paths).toEqual(["order.txt"])
          expect(ownedTask?.reservations).toHaveLength(1)
          expect(ownedTask?.reservations[0]?.ownerSessionID).toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects completion of an owned task without a structured handoff", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-no-handoff")
          const owned = path.join(directory, "no-handoff.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Needs handoff", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Needs handoff")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))

          const result = yield* updateDef.execute(
            { task_id: task.id, status: "completed" },
            context(seed.worker.session_id),
          )
          const row = yield* getTask(task.id)

          expect(result.title).toBe("Task Update Failed")
          expect(result.output.toLowerCase()).toContain("handoff")
          expect(row?.status).toBe("in_progress")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("completes an owned task with a valid structured handoff and stores it with the release", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-handoff-ok")
          const owned = path.join(directory, "handoff-ok.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Handoff ok", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Handoff ok")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))
          const { db } = yield* Database.Service

          const result = yield* updateDef.execute(
            {
              task_id: task.id,
              status: "completed",
              handoff: {
                summary: "Finished the handoff task",
                changed_paths: [owned],
                verification: [{ command: "bun test", status: "passed", detail: "green" }],
                risks: ["none"],
              },
            },
            context(seed.worker.session_id),
          )
          const row = yield* getTask(task.id)
          const rows = yield* db
            .select()
            .from(TeamFileOwnershipTable)
            .where(eq(TeamFileOwnershipTable.task_id, task.id))
            .all()
            .pipe(Effect.orDie)

          expect(result.title).toBe("Task Updated")
          expect(row?.status).toBe("completed")
          expect(row?.metadata?.handoff).toEqual(
            expect.objectContaining({
              summary: "Finished the handoff task",
              changed_paths: ["handoff-ok.txt"],
              verification: [{ command: "bun test", status: "passed", detail: "green" }],
              risks: ["none"],
            }),
          )
          expect(rows[0]?.time_released).not.toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects a handoff whose changed paths are not a subset of the reserved paths", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-handoff-unreserved")
          const owned = path.join(directory, "handoff-subset.txt")
          const outside = path.join(directory, "unreserved.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Subset check", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Subset check")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))

          const result = yield* updateDef.execute(
            {
              task_id: task.id,
              status: "completed",
              handoff: {
                summary: "Changed an unreserved file",
                changed_paths: [outside],
                verification: [{ command: "bun test", status: "passed" }],
              },
            },
            context(seed.worker.session_id),
          )
          const row = yield* getTask(task.id)

          expect(result.title).toBe("Task Update Failed")
          expect(result.output.toLowerCase()).toContain("reserved")
          expect(row?.status).toBe("in_progress")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects completion with a blank handoff summary", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-owned-handoff-blank")
          const owned = path.join(directory, "handoff-blank.txt")
          yield* Effect.promise(() => fs.writeFile(owned, "x"))
          const createTool = yield* TeamTaskCreateTool
          const createDef = yield* createTool.init()
          const claimTool = yield* TeamTaskClaimTool
          const claimDef = yield* claimTool.init()
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          yield* createDef.execute({ description: "Blank summary", owned_paths: [owned] }, context(seed.lead.id))
          const task = (yield* getTasks(seed.info.id)).find((row) => row.description === "Blank summary")
          if (!task) throw new Error("owned task was not persisted")
          yield* claimDef.execute({ task_id: task.id }, context(seed.worker.session_id))

          const result = yield* updateDef.execute(
            {
              task_id: task.id,
              status: "completed",
              handoff: {
                summary: "   ",
                changed_paths: [owned],
                verification: [{ command: "bun test", status: "passed" }],
              },
            },
            context(seed.worker.session_id),
          )
          const row = yield* getTask(task.id)

          expect(result.title).toBe("Task Update Failed")
          expect(result.output.toLowerCase()).toContain("summary")
          expect(row?.status).toBe("in_progress")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("keeps legacy unowned behavior for assignee and direct transitions", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const seed = yield* seedTeam("tasks-unowned-legacy")
          yield* insertTask({
            id: "task_legacy_direct",
            teamID: seed.info.id,
            description: "Legacy direct complete",
            assignee: seed.worker.session_id,
          })
          const updateTool = yield* TeamTaskUpdateTool
          const updateDef = yield* updateTool.init()

          const updated = yield* updateDef.execute(
            { task_id: "task_legacy_direct", status: "completed" },
            context(seed.worker.session_id),
          )
          const row = yield* getTask("task_legacy_direct")

          expect(updated.title).toBe("Task Updated")
          expect(row?.status).toBe("completed")
          expect(row?.assignee).toBe(seed.worker.session_id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

function context(
  sessionID: string,
  input?: { assistant?: MessageV2.Assistant; callID?: string; messages?: MessageV2.WithParts[] },
): Context {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: input?.assistant?.id ?? MessageID.ascending(),
    callID: input?.callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: input?.messages ?? [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const turnRef = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const createAssistant = Effect.fn("TeamTasksTest.createAssistant")(function* (
  session: Session.Info,
  parentID: MessageV2.User["id"],
) {
  const sessions = yield* Session.Service
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID: session.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: turnRef.modelID,
    providerID: turnRef.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return assistant
})

const startTurn = Effect.fn("TeamTasksTest.startTurn")(function* (input: {
  session: Session.Info
  text: string
  synthetic: boolean
}) {
  const sessions = yield* Session.Service
  const user: MessageV2.User = {
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.session.id,
    agent: "build",
    model: turnRef,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(user)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: input.session.id,
    type: "text",
    text: input.text,
    synthetic: input.synthetic,
  } satisfies MessageV2.TextPart)
  const assistant = yield* createAssistant(input.session, user.id)
  return { user, assistant }
})

const storeTaskListRead = Effect.fn("TeamTasksTest.storeTaskListRead")(function* (input: {
  assistant: MessageV2.Assistant
  callID: string
  result: { title: string; output: string; metadata: { revision: number; repeated: boolean } }
}) {
  const sessions = yield* Session.Service
  const now = Date.now()
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.assistant.id,
    sessionID: input.assistant.sessionID,
    type: "tool",
    callID: input.callID,
    tool: "team_task_list",
    state: {
      status: "completed",
      input: {},
      output: input.result.output,
      title: input.result.title,
      metadata: input.result.metadata,
      time: { start: now, end: now },
    },
  } satisfies MessageV2.ToolPart)
})

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

const getTeamRow = Effect.fn("TeamTasksTest.getTeamRow")(function* (teamID: string) {
  const { db } = yield* Database.Service
  return yield* db.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get().pipe(Effect.orDie)
})
