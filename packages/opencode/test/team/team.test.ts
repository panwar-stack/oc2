import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Latch, Layer, Option } from "effect"
import { Team } from "@/team/team"
import {
  TeamMemberTable,
  TeamMessageRecipientTable,
  TeamMessageTable,
  TeamTable,
  TeamTaskTable,
  TeamUsageEventTable,
} from "@/team/team.sql"
import { TeamFileOwnershipTable } from "@oc2-ai/core/team/ownership.sql"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { Bus } from "@/bus"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Runner } from "@/effect/runner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { SessionPrompt } from "@/session/prompt"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { Permission } from "@/permission"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  } as SessionV1.WithParts
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
    LifecycleReconciler.defaultLayer,
    Session.defaultLayer,
    SessionControl.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
    Bus.layer,
  ),
)

function unwrap<T>(opt: Option.Option<T>): T {
  if (Option.isNone(opt)) throw new Error("Option is None")
  return opt.value
}

const setLegacyProtocol = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  yield* db.update(TeamTable).set({ protocol_version: 0 }).where(eq(TeamTable.id, teamID)).run().pipe(Effect.orDie)
})

describe("team", () => {
  it.live("create team and enforce one active team per lead", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_1"

        const created = yield* team.create({ name: "test-team", goal: "Test goal", leadSessionID })
        expect(created.name).toBe("test-team")
        expect(created.status).toBe("active")

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isSome(active)).toBe(true)
        expect(unwrap(active).id).toBe(created.id)

        const conflict = yield* team.create({ name: "dup", goal: "x", leadSessionID }).pipe(Effect.flip)
        expect(conflict).toBeInstanceOf(Team.ActiveTeamConflict)
        expect(conflict.leadSessionID).toBe(leadSessionID)
        expect(conflict.teamID).toBe(created.id)

        const { db } = yield* Database.Service
        const activeRows = yield* db
          .select({ id: TeamTable.id })
          .from(TeamTable)
          .where(and(eq(TeamTable.lead_session_id, leadSessionID), eq(TeamTable.status, "active")))
          .all()
          .pipe(Effect.orDie)
        expect(activeRows).toHaveLength(1)
        expect(activeRows[0]?.id).toBe(created.id)
      }),
    ),
  )

  it.live("concurrent creates for one lead yield one success and one typed conflict", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_concurrent_create"

        const results = yield* Effect.all(
          [
            team.create({ name: "concurrent-a", goal: "Goal", leadSessionID }).pipe(Effect.exit),
            team.create({ name: "concurrent-b", goal: "Goal", leadSessionID }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )

        const winners = results.filter((result) => Exit.isSuccess(result))
        const losers = results.filter((result) => {
          if (!Exit.isFailure(result)) return false
          return Cause.squash(result.cause) instanceof Team.ActiveTeamConflict
        })
        expect(winners).toHaveLength(1)
        expect(losers).toHaveLength(1)

        const winner = winners[0] as Exit.Success<Team.Info>
        expect(winner.value.status).toBe("active")
        const loser = losers[0] as Exit.Failure<never, Team.ActiveTeamConflict>
        const conflict = Cause.squash(loser.cause) as Team.ActiveTeamConflict
        expect(conflict.leadSessionID).toBe(leadSessionID)
        expect(conflict.teamID).toBe(winner.value.id)

        const { db } = yield* Database.Service
        const activeRows = yield* db
          .select({ id: TeamTable.id })
          .from(TeamTable)
          .where(and(eq(TeamTable.lead_session_id, leadSessionID), eq(TeamTable.status, "active")))
          .all()
          .pipe(Effect.orDie)
        expect(activeRows).toHaveLength(1)
        expect(activeRows[0]?.id).toBe(winner.value.id)
      }),
    ),
  )

  it.live("create team after shutdown with same lead session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_recreate"

        const first = yield* team.create({ name: "first-team", goal: "First goal", leadSessionID })
        yield* setLegacyProtocol(first.id)
        yield* team.shutdown({ teamID: first.id, sessionID: leadSessionID })

        const second = yield* team.create({ name: "second-team", goal: "Second goal", leadSessionID })
        expect(second.id).not.toBe(first.id)
        expect(second.status).toBe("active")

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isSome(active)).toBe(true)
        expect(unwrap(active).id).toBe(second.id)

        const closed = yield* team.get(first.id)
        expect(Option.isSome(closed)).toBe(true)
        expect(unwrap(closed).status).toBe("closed")

        const byLeadSession = yield* team.getByLeadSession(leadSessionID)
        expect(Option.isSome(byLeadSession)).toBe(true)
        expect(unwrap(byLeadSession).id).toBe(second.id)
      }),
    ),
  )

  it.live("prefers active team by lead session when creation times tie", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_recreate_tie"
        const originalNow = Date.now
        const originalRandomUUID = crypto.randomUUID

        Date.now = () => 123
        crypto.randomUUID = () => "ffffffff-ffff-4fff-8fff-ffffffffffff"

        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            Date.now = originalNow
            crypto.randomUUID = originalRandomUUID
          }),
        )

        const first = yield* team.create({ name: "first-team", goal: "First goal", leadSessionID })
        yield* setLegacyProtocol(first.id)
        yield* team.shutdown({ teamID: first.id, sessionID: leadSessionID })
        crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000"
        yield* team.create({ name: "second-team", goal: "Second goal", leadSessionID })

        const byLeadSession = yield* team.getByLeadSession(leadSessionID)
        expect(Option.isSome(byLeadSession)).toBe(true)
        expect(unwrap(byLeadSession).id).toBe("00000000-0000-4000-8000-000000000000")
        expect(unwrap(byLeadSession).status).toBe("active")
      }),
    ),
  )

  it.live("resolves closed team by lead session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_closed_lookup"

        const created = yield* team.create({ name: "closed-team", goal: "Goal", leadSessionID })
        yield* setLegacyProtocol(created.id)
        yield* team.shutdown({ teamID: created.id, sessionID: leadSessionID })

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isNone(active)).toBe(true)

        const byLeadSession = yield* team.getByLeadSession(leadSessionID)
        expect(Option.isSome(byLeadSession)).toBe(true)
        expect(unwrap(byLeadSession).id).toBe(created.id)
        expect(unwrap(byLeadSession).status).toBe("closed")
      }),
    ),
  )

  it.live("shutdown publishes final member statuses", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const bus = yield* Bus.Service
        const leadSessionID = "ses_test_lead_shutdown_status"
        const events: { sessionID: string; status: string }[] = []
        const receivedFinalStatuses = yield* Deferred.make<void>()
        let finalStatusesReceived = false

        const created = yield* team.create({ name: "shutdown-status", goal: "Goal", leadSessionID })
        const completed = yield* team.addMember({
          teamID: created.id,
          sessionID: "ses_shutdown_completed",
          name: "done",
          agentType: "build",
          rolePrompt: "Finish",
        })
        const active = yield* team.addMember({
          teamID: created.id,
          sessionID: "ses_shutdown_active",
          name: "active",
          agentType: "build",
          rolePrompt: "Keep working",
        })

        yield* team.updateMemberStatus(completed.id, "completed")
        yield* team.updateMemberStatus(active.id, "active")
        yield* setLegacyProtocol(created.id)

        const unsubscribe = yield* bus.subscribeAllCallback((event) => {
          if (event.type !== "team.member.updated") return
          const properties = event.properties as { sessionID: string; status: string }
          events.push({
            sessionID: properties.sessionID,
            status: properties.status,
          })
          if (
            !finalStatusesReceived &&
            events.some((event) => event.sessionID === completed.session_id && event.status === "completed") &&
            events.some((event) => event.sessionID === active.session_id && event.status === "cancelled")
          ) {
            finalStatusesReceived = true
            Deferred.doneUnsafe(receivedFinalStatuses, Effect.void)
          }
        })

        yield* team.shutdown({ teamID: created.id, sessionID: leadSessionID })
        yield* awaitWithTimeout(
          Deferred.await(receivedFinalStatuses),
          "shutdown member status events were not published",
        )
        yield* Effect.sync(unsubscribe)

        expect(events).toContainEqual({ sessionID: completed.session_id, status: "completed" })
        expect(events).toContainEqual({ sessionID: active.session_id, status: "cancelled" })
      }),
    ),
  )

  it.live("add member and get members", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_2"

        yield* team.create({ name: "test-team-2", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_test_child_1",
          name: "builder",
          agentType: "build",
          rolePrompt: "Build the feature",
        })

        expect(member.name).toBe("builder")
        expect(member.agent_type).toBe("build")
        expect(member.status).toBe("starting")
        expect(member.lifecycle).toBe("task")
        expect(member.daemon_state).toBeNull()
        expect(member.daemon_last_active).toBeNull()
        expect(member.daemon_error).toBeNull()

        const members = yield* team.getMembers(teamInfo.id)
        expect(members.length).toBe(1)
        expect(members[0].name).toBe("builder")
        expect(members[0].lifecycle).toBe("task")
        expect(members[0].daemon_state).toBeNull()
        expect(members[0].daemon_last_active).toBeNull()
        expect(members[0].daemon_error).toBeNull()

        const bySession = yield* team.getMemberBySession("ses_test_child_1")
        expect(Option.isSome(bySession)).toBe(true)
        expect(unwrap(bySession).id).toBe(member.id)

        const leadContext = yield* team.getContext(leadSessionID)
        expect(Option.isSome(leadContext)).toBe(true)
        expect(unwrap(leadContext).team.id).toBe(teamInfo.id)

        const memberContext = yield* team.getContext("ses_test_child_1")
        expect(Option.isSome(memberContext)).toBe(true)
        expect(unwrap(memberContext).member?.id).toBe(member.id)
      }),
    ),
  )

  it.live("rejects member and task inserts after the team is no longer active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const { db } = yield* Database.Service
        const info = yield* team.create({
          name: "closed-admission",
          goal: "Reject late writes",
          leadSessionID: "ses_closed_admission_lead",
        })
        yield* db.update(TeamTable).set({ status: "closed" }).where(eq(TeamTable.id, info.id)).run().pipe(Effect.orDie)

        const memberError = yield* team
          .addMember({
            teamID: info.id,
            sessionID: "ses_closed_admission_member",
            name: "late-member",
            agentType: "general",
            rolePrompt: "Too late",
          })
          .pipe(Effect.flip)
        const taskError = yield* team.createTask({ teamID: info.id, description: "Late plain task" }).pipe(Effect.flip)
        const ownedTaskError = yield* team
          .createTask({
            teamID: info.id,
            description: "Late owned task",
            owned: [{ rootKey: "/work", pathKey: "/work/late.txt", displayPath: "late.txt" }],
          })
          .pipe(Effect.flip)

        expect(memberError).toBeInstanceOf(Team.TeamNotActive)
        expect(taskError).toBeInstanceOf(Team.TeamNotActive)
        expect(ownedTaskError).toBeInstanceOf(Team.TeamNotActive)
        expect(
          yield* db.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, info.id)).all().pipe(Effect.orDie),
        ).toHaveLength(0)
        expect(
          yield* db.select().from(TeamTaskTable).where(eq(TeamTaskTable.team_id, info.id)).all().pipe(Effect.orDie),
        ).toHaveLength(0)
        expect(
          yield* db
            .select()
            .from(TeamFileOwnershipTable)
            .where(eq(TeamFileOwnershipTable.team_id, info.id))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(0)
      }),
    ),
  )

  it.live("persists daemon member lifecycle fields", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_daemon_persist"

        yield* team.create({ name: "daemon-team", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))
        const lastActive = Date.now()

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_daemon_child_1",
          name: "sentinel",
          agentType: "general",
          rolePrompt: "Monitor for risks",
          lifecycle: "daemon",
          daemonState: "initializing",
          daemonLastActive: lastActive,
        })

        expect(member.lifecycle).toBe("daemon")
        expect(member.daemon_state).toBe("initializing")
        expect(member.daemon_last_active).toBe(lastActive)
        expect(member.daemon_error).toBeNull()

        const updated = yield* team.updateMemberStatus(member.id, "idle", {
          daemonState: "idle",
          daemonLastActive: lastActive + 1,
          daemonError: "waiting for trigger",
        })
        expect(Option.isSome(updated)).toBe(true)
        expect(unwrap(updated).lifecycle).toBe("daemon")
        expect(unwrap(updated).daemon_state).toBe("idle")
        expect(unwrap(updated).daemon_last_active).toBe(lastActive + 1)
        expect(unwrap(updated).daemon_error).toBe("waiting for trigger")

        const members = yield* team.getMembers(teamInfo.id)
        expect(members[0].lifecycle).toBe("daemon")
        expect(members[0].daemon_state).toBe("idle")
        expect(members[0].daemon_last_active).toBe(lastActive + 1)
        expect(members[0].daemon_error).toBe("waiting for trigger")

        const bySession = yield* team.getMemberBySession("ses_daemon_child_1")
        expect(Option.isSome(bySession)).toBe(true)
        expect(unwrap(bySession).lifecycle).toBe("daemon")
        expect(unwrap(bySession).daemon_state).toBe("idle")
      }),
    ),
  )

  it.live("update member status", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_3"

        yield* team.create({ name: "test-team-3", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_test_child_2",
          name: "explorer",
          agentType: "explore",
          rolePrompt: "Explore codebase",
        })

        const updated = yield* team.updateMemberStatus(member.id, "active")
        expect(Option.isSome(updated)).toBe(true)
        expect(unwrap(updated).status).toBe("active")

        const completed = yield* team.updateMemberStatus(member.id, "completed")
        expect(Option.isSome(completed)).toBe(true)
        expect(unwrap(completed).status).toBe("completed")
      }),
    ),
  )

  it.live("create and list team tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_4"

        yield* team.create({ name: "test-team-4", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const task1 = yield* team.createTask({
          teamID: teamInfo.id,
          description: "Task 1",
        })
        const task2 = yield* team.createTask({
          teamID: teamInfo.id,
          description: "Task 2",
          assignee: "builder",
          dependencyIDs: [task1.id],
        })

        expect(task1.status).toBe("pending")
        expect(task2.dependency_ids).toContain(task1.id)

        const tasks = yield* team.getTasks(teamInfo.id)
        expect(tasks.length).toBe(2)

        const claimResult = yield* team.claimTask(teamInfo.id, task2.id, "ses_child")
        expect(Option.isNone(claimResult)).toBe(true)

        yield* team.updateTask(teamInfo.id, task1.id, { status: "completed" })

        const claim2 = yield* team.claimTask(teamInfo.id, task2.id, "ses_child")
        expect(Option.isSome(claim2)).toBe(true)
        expect(unwrap(claim2).status).toBe("in_progress")
        expect(unwrap(claim2).assignee).toBe("ses_child")
      }),
    ),
  )

  it.live("create and list usage events", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_usage_events"
        const info = yield* team.create({ name: "usage-events", goal: "Track events", leadSessionID })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_usage_member",
          name: "usage-member",
          agentType: "general",
          rolePrompt: "Do usage work",
        })

        const first = yield* team.createUsageEvent({ teamID: info.id, type: "broadcast_sent" })
        const second = yield* team.createUsageEvent({
          teamID: info.id,
          sessionID: leadSessionID,
          memberID: member.id,
          type: "plan_approved",
          metadata: { member_name: member.name },
        })
        const events = yield* team.getUsageEvents(info.id)
        const readableTeam = yield* team.get(info.id)

        expect(events).toHaveLength(2)
        expect(events.find((event) => event.id === first.id)).toEqual(
          expect.objectContaining({ id: first.id, metadata: {} }),
        )
        expect(events.find((event) => event.id === second.id)).toEqual(
          expect.objectContaining({
            id: second.id,
            team_id: info.id,
            session_id: leadSessionID,
            member_id: member.id,
            type: "plan_approved",
            metadata: { member_name: member.name },
          }),
        )
        expect(Option.isSome(readableTeam)).toBe(true)
      }),
    ),
  )

  it.live("owned task create, claim bind, and owner completion via the service", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "owned-service", goal: "Owned tasks", leadSessionID: "ses_owned_lead" })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_owned_worker",
          name: "owned-worker",
          agentType: "general",
          rolePrompt: "Do owned work",
        })

        const task = yield* team.createTask({
          teamID: info.id,
          description: "Owned service task",
          owned: [
            { rootKey: "/work", pathKey: "/work/a.txt", displayPath: "a.txt" },
            { rootKey: "/work", pathKey: "/work/b.txt", displayPath: "b.txt" },
          ],
        })
        expect(task.status).toBe("pending")
        expect(task.assignee).toBeUndefined()
        expect(task.owned_paths).toEqual(["a.txt", "b.txt"])
        expect(task.reservations).toHaveLength(2)

        const claimed = yield* team.claimTask(info.id, task.id, "ses_owned_worker")
        expect(Option.isSome(claimed)).toBe(true)
        expect(unwrap(claimed).status).toBe("in_progress")
        expect(
          unwrap(claimed).reservations.every((reservation) => reservation.ownerSessionID === "ses_owned_worker"),
        ).toBe(true)

        // A foreign session cannot complete.
        const foreign = yield* team
          .updateTask(info.id, task.id, { status: "completed" }, { sessionID: "ses_stranger", isLead: false })
          .pipe(Effect.flip)
        expect(foreign.message).toContain("owner")

        // A lead cannot complete either.
        const leadComplete = yield* team
          .updateTask(info.id, task.id, { status: "completed" }, { sessionID: "ses_owned_lead", isLead: true })
          .pipe(Effect.flip)
        expect(leadComplete.message).toContain("owner")

        // The owner can complete with a structured handoff; reservations release atomically.
        const completed = yield* team.updateTask(
          info.id,
          task.id,
          {
            status: "completed",
            handoff: {
              summary: "Implemented the owned task",
              changed_paths: ["a.txt", "b.txt"],
              verification: [{ command: "bun run typecheck", status: "passed" }],
            },
            handoffPathKeys: ["/work/a.txt", "/work/b.txt"],
          },
          { sessionID: "ses_owned_worker", isLead: false },
        )
        const completedTask = unwrap(completed)
        expect(completedTask.status).toBe("completed")
        expect(completedTask.handoff?.summary).toBe("Implemented the owned task")
        expect(completedTask.metadata?.handoff).toEqual(
          expect.objectContaining({ summary: "Implemented the owned task" }),
        )
        expect(completedTask.reservations.every((reservation) => reservation.timeReleased !== null)).toBe(true)
      }),
    ),
  )

  it.live("owned task rejections: pending-to-completed and reassignment", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "owned-reject", goal: "Rejections", leadSessionID: "ses_reject_lead" })

        const task = yield* team.createTask({
          teamID: info.id,
          description: "Reject owned",
          owned: [{ rootKey: "/work", pathKey: "/work/reject.txt", displayPath: "reject.txt" }],
        })

        const directComplete = yield* team
          .updateTask(info.id, task.id, { status: "completed" }, { sessionID: "ses_reject_lead", isLead: true })
          .pipe(Effect.flip)
        expect(directComplete.message).toContain("pending")

        yield* team.claimTask(info.id, task.id, "ses_reject_worker")
        const reassign = yield* team
          .updateTask(
            info.id,
            task.id,
            { assignee: "ses_reject_other" },
            { sessionID: "ses_reject_lead", isLead: true },
          )
          .pipe(Effect.flip)
        expect(reassign.message).toContain("reassign")

        const leadCancels = yield* team.updateTask(
          info.id,
          task.id,
          { status: "cancelled" },
          { sessionID: "ses_reject_lead", isLead: true },
        )
        expect(unwrap(leadCancels).status).toBe("cancelled")
        expect(unwrap(leadCancels).reservations[0]?.timeReleased).not.toBeNull()
      }),
    ),
  )

  it.live("owned task conflicts globally reject the same active path across teams", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const first = yield* team.create({ name: "owned-conflict-a", goal: "A", leadSessionID: "ses_conf_a" })
        const second = yield* team.create({ name: "owned-conflict-b", goal: "B", leadSessionID: "ses_conf_b" })

        yield* team.createTask({
          teamID: first.id,
          description: "First reserves",
          owned: [{ rootKey: "/work", pathKey: "/work/shared.txt", displayPath: "shared.txt" }],
        })
        const conflict = yield* team
          .createTask({
            teamID: second.id,
            description: "Second conflicts",
            owned: [{ rootKey: "/work", pathKey: "/work/shared.txt", displayPath: "shared.txt" }],
          })
          .pipe(Effect.flip)
        expect(conflict.message).toContain("already reserved")
        expect(conflict.message).toContain("shared.txt")

        // Different path keys are isolated even in the same worktree.
        yield* team.createTask({
          teamID: second.id,
          description: "Second own file",
          owned: [{ rootKey: "/work", pathKey: "/work/other.txt", displayPath: "other.txt" }],
        })
        expect(yield* team.getTasks(second.id)).toHaveLength(1)
      }),
    ),
  )

  it.live("a released reservation frees its path for a new owned task", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "owned-reuse", goal: "Reuse", leadSessionID: "ses_reuse_lead" })
        const first = yield* team.createTask({
          teamID: info.id,
          description: "First",
          owned: [{ rootKey: "/work", pathKey: "/work/reuse.txt", displayPath: "reuse.txt" }],
        })
        yield* team.claimTask(info.id, first.id, "ses_reuse_worker")
        yield* team.updateTask(
          info.id,
          first.id,
          { status: "cancelled" },
          { sessionID: "ses_reuse_lead", isLead: true },
        )
        const second = yield* team.createTask({
          teamID: info.id,
          description: "Second",
          owned: [{ rootKey: "/work", pathKey: "/work/reuse.txt", displayPath: "reuse.txt" }],
        })
        expect(second.status).toBe("pending")
      }),
    ),
  )

  it.live("send and receive team messages", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_5"

        yield* team.create({ name: "test-team-5", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_a",
          name: "memberA",
          agentType: "general",
          rolePrompt: "Do A",
        })
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_b",
          name: "memberB",
          agentType: "general",
          rolePrompt: "Do B",
        })

        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: ["ses_child_a"],
          body: "Hello from lead",
        })

        const pendingA = yield* team.getPendingMessages("ses_child_a", teamInfo.id)
        expect(pendingA.length).toBe(1)
        expect(pendingA[0].sender).toBe(leadSessionID)
        expect(pendingA[0].body).toBe("Hello from lead")

        const pendingB = yield* team.getPendingMessages("ses_child_b", teamInfo.id)
        expect(pendingB.length).toBe(0)

        yield* team.markMessageDelivered(pendingA[0].id)

        const afterDelivery = yield* team.getPendingMessages("ses_child_a", teamInfo.id)
        expect(afterDelivery.length).toBe(0)

        const allMsgs = yield* team.getMessages(teamInfo.id)
        expect(allMsgs.length).toBe(1)
      }),
    ),
  )

  it.live("sendMessage atomically rejects terminal finite recipients", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "terminal-message-admission",
          goal: "Reject terminal delivery",
          leadSessionID: "ses_terminal_message_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_terminal_message_member",
          name: "done",
          agentType: "general",
          rolePrompt: "Finish",
        })
        yield* team.updateMemberStatus(member.id, "completed", "done")
        const before = yield* team.getMessages(info.id)

        const error = yield* team
          .sendMessage({
            teamID: info.id,
            sender: info.lead_session_id,
            recipients: [member.session_id],
            body: "Do more work",
          })
          .pipe(Effect.flip)

        expect(error).toBeInstanceOf(Team.MessageToTerminalMember)
        expect(error.message).toContain("completed")
        expect(yield* team.getMessages(info.id)).toHaveLength(before.length)
        expect(yield* team.getPendingMessages(member.session_id, info.id)).toHaveLength(0)
      }),
    ),
  )

  it.live("hasPendingMailboxMessages reports pending rows without claiming them", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_pending_probe"

        yield* team.create({ name: "pending-probe", goal: "Probe", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_probe_member",
          name: "probe",
          agentType: "general",
          rolePrompt: "Probe",
        })

        expect(yield* team.hasPendingMailboxMessages(leadSessionID)).toBe(false)
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: "ses_probe_member",
          recipients: [leadSessionID],
          body: "Pending probe",
        })
        expect(yield* team.hasPendingMailboxMessages(leadSessionID)).toBe(true)
        // The probe must not claim the row.
        expect((yield* team.getPendingMessages(leadSessionID, teamInfo.id)).length).toBe(1)

        yield* team.claimPendingMessages(leadSessionID, teamInfo.id)
        expect(yield* team.hasPendingMailboxMessages(leadSessionID)).toBe(false)
      }),
    ),
  )

  it.live("shutdown team", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_6"

        yield* team.create({ name: "test-team-6", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_c",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })

        yield* setLegacyProtocol(teamInfo.id)
        yield* team.shutdown({ teamID: teamInfo.id, sessionID: leadSessionID })

        const active = yield* team.getActive(leadSessionID)
        expect(Option.isNone(active)).toBe(true)

        const info = yield* team.get(teamInfo.id)
        expect(Option.isSome(info)).toBe(true)
        expect(unwrap(info).status).toBe("closed")

        const members = yield* team.getMembers(teamInfo.id)
        expect(members[0].status).toBe("cancelled")
      }),
    ),
  )

  it.live("member-to-lead and member-to-member messaging", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_8"

        yield* team.create({ name: "test-team-8", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_c1",
          name: "memberC",
          agentType: "general",
          rolePrompt: "Do C",
        })
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_d1",
          name: "memberD",
          agentType: "general",
          rolePrompt: "Do D",
        })

        // member-to-lead
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: "ses_child_c1",
          recipients: [leadSessionID],
          body: "Status update from C",
        })
        const leadPending = yield* team.getPendingMessages(leadSessionID, teamInfo.id)
        expect(leadPending.length).toBe(1)
        expect(leadPending[0].sender).toBe("ses_child_c1")

        // member-to-member
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: "ses_child_c1",
          recipients: ["ses_child_d1"],
          body: "Hey D, need help",
        })
        const dPending = yield* team.getPendingMessages("ses_child_d1", teamInfo.id)
        expect(dPending.length).toBe(1)
        expect(dPending[0].sender).toBe("ses_child_c1")

        // Verify all messages in the team
        const allMsgs = yield* team.getMessages(teamInfo.id)
        expect(allMsgs.length).toBe(2)
      }),
    ),
  )

  it.live("multi-recipient messages are delivered per recipient", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_multi_delivery"

        yield* team.create({ name: "test-team-multi-delivery", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_multi_a",
          name: "multiA",
          agentType: "general",
          rolePrompt: "Do A",
        })
        yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_multi_b",
          name: "multiB",
          agentType: "general",
          rolePrompt: "Do B",
        })

        const message = yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: ["ses_multi_a", "ses_multi_b", "ses_multi_a"],
          body: "Hello both",
        })

        expect(message.recipients).toEqual(["ses_multi_a", "ses_multi_b"])
        expect((yield* team.getPendingMessages("ses_multi_a", teamInfo.id)).length).toBe(1)
        expect((yield* team.getPendingMessages("ses_multi_b", teamInfo.id)).length).toBe(1)

        yield* team.markMessageDelivered(message.id, "ses_multi_a")

        expect((yield* team.getPendingMessages("ses_multi_a", teamInfo.id)).length).toBe(0)
        const stillPending = yield* team.getPendingMessages("ses_multi_b", teamInfo.id)
        expect(stillPending.length).toBe(1)
        expect(stillPending[0].body).toBe("Hello both")
      }),
    ),
  )

  it.live("concurrent claims return multiple messages exactly once", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_concurrent_claims"
        const recipientSessionID = "ses_test_concurrent_claim_recipient"
        const teamInfo = yield* team.create({ name: "concurrent-claims", goal: "Claim once", leadSessionID })

        const messages = yield* Effect.all(
          ["First", "Second", "Third"].map((body) =>
            team.sendMessage({
              teamID: teamInfo.id,
              sender: leadSessionID,
              recipients: [recipientSessionID],
              body,
            }),
          ),
          { concurrency: "unbounded" },
        )
        const claims = yield* Effect.all(
          [
            team.claimPendingMessages(recipientSessionID, teamInfo.id),
            team.claimPendingMessages(recipientSessionID, teamInfo.id),
          ],
          { concurrency: "unbounded" },
        )

        expect(claims.map((claim) => claim.length).sort()).toEqual([0, 3])
        expect(new Set(claims.flat().map((message) => message.id))).toEqual(
          new Set(messages.map((message) => message.id)),
        )
        expect(yield* team.getPendingMessages(recipientSessionID, teamInfo.id)).toHaveLength(0)
      }),
    ),
  )

  it.live("auto-notification on member status creates pending mailbox delivery for lead", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_9"

        yield* team.create({ name: "test-team-9", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_e",
          name: "workerE",
          agentType: "build",
          rolePrompt: "Build stuff",
        })

        yield* team.updateMemberStatus(member.id, "completed")

        const pending = yield* team.getPendingMessages(leadSessionID, teamInfo.id)
        expect(pending.length).toBe(1)
        expect(pending[0].sender).toBe(member.session_id)
        expect(pending[0].recipients).toContain(leadSessionID)
        expect(pending[0].body).toContain("completed their work")

        yield* team.markMessageDelivered(pending[0].id, leadSessionID)

        const delivered = yield* team.getPendingMessages(leadSessionID, teamInfo.id)
        expect(delivered.length).toBe(0)
      }),
    ),
  )

  it.live("pending messages stay pending until consumed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_10"

        yield* team.create({ name: "test-team-10", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_f",
          name: "workerF",
          agentType: "general",
          rolePrompt: "General work",
        })

        // Send a message to the member
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: [member.session_id],
          body: "Update your status",
        })

        // Message should be pending
        const pending = yield* team.getPendingMessages(member.session_id, teamInfo.id)
        expect(pending.length).toBe(1)

        yield* team.updateMemberStatus(member.id, "idle")

        const stillPending = yield* team.getPendingMessages(member.session_id, teamInfo.id)
        expect(stillPending.length).toBe(1)

        yield* team.markMessageDelivered(pending[0].id)

        const consumed = yield* team.getPendingMessages(member.session_id, teamInfo.id)
        expect(consumed.length).toBe(0)
      }),
    ),
  )

  it.live("member added with plan_mode", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_11"

        yield* team.create({ name: "test-team-11", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_g",
          name: "planner",
          agentType: "build",
          rolePrompt: "Plan first",
          planMode: true,
          workMode: "plan",
        })

        expect(member.plan_mode).toBe(true)
        expect(member.work_mode).toBe("plan")
        expect(member.status).toBe("starting")
      }),
    ),
  )

  it.live("plan approval transitions member from plan_mode to active", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_12"

        yield* team.create({ name: "test-team-12", goal: "Goal", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_child_h",
          name: "planner2",
          agentType: "build",
          rolePrompt: "Plan first",
          planMode: true,
          workMode: "plan",
        })

        const updated = yield* team.updateMemberStatus(member.id, "active")
        expect(Option.isSome(updated)).toBe(true)
        expect(unwrap(updated).status).toBe("active")
        expect(unwrap(updated).plan_mode).toBe(true)
        expect(unwrap(updated).work_mode).toBe("plan")
      }),
    ),
  )

  it.live("plan approval rejects terminal members without changing their plan state", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "terminal-plan",
          goal: "Reject terminal approval",
          leadSessionID: "ses_terminal_plan_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_terminal_plan_member",
          name: "planner",
          agentType: "general",
          rolePrompt: "Plan",
          planMode: true,
          workMode: "plan",
        })
        yield* team.updateMemberStatus(member.id, "completed", "already done")

        const approved = yield* team.approveMemberPlan(member.id)
        const current = unwrap(yield* team.getMemberBySession(member.session_id))

        expect(Option.isNone(approved)).toBe(true)
        expect(current.status).toBe("completed")
        expect(current.plan_mode).toBe(true)
        expect(current.work_mode).toBe("plan")
      }),
    ),
  )

  it.live("plan approval rejects a nonterminal member after team closure", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const { db } = yield* Database.Service
        const info = yield* team.create({
          name: "closed-plan",
          goal: "Reject closed approval",
          leadSessionID: "ses_closed_plan_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_closed_plan_member",
          name: "planner",
          agentType: "general",
          rolePrompt: "Plan",
          planMode: true,
          workMode: "plan",
        })
        yield* db.update(TeamTable).set({ status: "closed" }).where(eq(TeamTable.id, info.id)).run().pipe(Effect.orDie)

        const approved = yield* team.approveMemberPlan(member.id)
        const current = unwrap(yield* team.getMemberBySession(member.session_id))

        expect(Option.isNone(approved)).toBe(true)
        expect(current.status).toBe("starting")
        expect(current.plan_mode).toBe(true)
        expect(current.work_mode).toBe("plan")
      }),
    ),
  )

  it.live("broadcast sends message to all active members", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_broadcast"

        yield* team.create({ name: "test-broadcast", goal: "Test broadcast", leadSessionID })
        const teamInfo = unwrap(yield* team.getActive(leadSessionID))

        const member1 = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_broad_1",
          name: "broad1",
          agentType: "explore",
          rolePrompt: "Explore",
        })
        const member2 = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_broad_2",
          name: "broad2",
          agentType: "build",
          rolePrompt: "Build",
        })
        const member3 = yield* team.addMember({
          teamID: teamInfo.id,
          sessionID: "ses_broad_3",
          name: "broad3",
          agentType: "general",
          rolePrompt: "General",
        })

        yield* team.updateMemberStatus(member1.id, "active")
        yield* team.updateMemberStatus(member2.id, "active")
        // member3 stays "starting"

        // Simulate broadcast: send to all active + starting members
        yield* team.sendMessage({
          teamID: teamInfo.id,
          sender: leadSessionID,
          recipients: [member1.session_id, member2.session_id, member3.session_id],
          body: "Broadcast: new priority task",
        })

        const pending1 = yield* team.getPendingMessages(member1.session_id, teamInfo.id)
        const pending2 = yield* team.getPendingMessages(member2.session_id, teamInfo.id)
        const pending3 = yield* team.getPendingMessages(member3.session_id, teamInfo.id)

        expect(pending1.length).toBe(1)
        expect(pending1[0].body).toBe("Broadcast: new priority task")
        expect(pending2.length).toBe(1)
        expect(pending2[0].body).toBe("Broadcast: new priority task")
        expect(pending3.length).toBe(1)
        expect(pending3[0].body).toBe("Broadcast: new priority task")

        // Non-existent session gets nothing
        const noop = yield* team.getPendingMessages("ses_nonexistent", teamInfo.id)
        expect(noop.length).toBe(0)
      }),
    ),
  )

  it.live("new teams persist protocol 1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const { db } = yield* Database.Service
        const created = yield* team.create({
          name: "protocol-one",
          goal: "Use protocol 1",
          leadSessionID: "ses_test_lead_protocol_1",
        })
        const stored = yield* db
          .select({ protocolVersion: TeamTable.protocol_version })
          .from(TeamTable)
          .where(eq(TeamTable.id, created.id))
          .get()
          .pipe(Effect.orDie)

        expect(created.protocol_version).toBe(1)
        expect(stored?.protocolVersion).toBe(1)
      }),
    ),
  )

  it.live("shutdown leaves failed members failed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_failed_shutdown"
        const info = yield* team.create({ name: "failed-shutdown", goal: "Keep failed terminal", leadSessionID })
        const failed = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_test_failed_member",
          name: "failed",
          agentType: "general",
          rolePrompt: "Fail",
        })
        yield* team.updateMemberStatus(failed.id, "failed", { failureCode: "provider_error" })

        yield* setLegacyProtocol(info.id)
        yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })

        const members = yield* team.getMembers(info.id)
        expect(members[0]?.status).toBe("failed")
        expect(members[0]?.failure_code).toBe("provider_error")
      }),
    ),
  )

  it.live("a failed member is not cancelled again by shutdown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leadSessionID = "ses_test_lead_failed_not_cancelled"
        const info = yield* team.create({ name: "failed-not-cancelled", goal: "Keep failed terminal", leadSessionID })
        const failed = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_test_failed_not_cancelled",
          name: "failed",
          agentType: "general",
          rolePrompt: "Fail",
        })
        const active = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_test_active_cancelled",
          name: "active",
          agentType: "general",
          rolePrompt: "Keep working",
        })
        yield* team.updateMemberStatus(failed.id, "failed", { failureCode: "provider_error" })
        yield* team.updateMemberStatus(active.id, "active")

        yield* setLegacyProtocol(info.id)
        yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })

        const members = yield* team.getMembers(info.id)
        expect(members.find((member) => member.id === failed.id)?.status).toBe("failed")
        expect(members.find((member) => member.id === active.id)?.status).toBe("cancelled")
      }),
    ),
  )

  it.live("a failed finite member cancels blocked descendants and leaves independent members untouched", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const upstreamSession = yield* sessions.create({ parentID: lead.id, title: "Upstream" })
          const dependentSession = yield* sessions.create({ parentID: lead.id, title: "Dependent" })
          const independentSession = yield* sessions.create({ parentID: lead.id, title: "Independent" })
          const info = yield* team.create({
            name: "failed-descendants",
            goal: "Cancel blocked descendants",
            leadSessionID: lead.id,
          })
          const upstream = yield* team.addMember({
            teamID: info.id,
            sessionID: upstreamSession.id,
            name: "upstream",
            agentType: "general",
            rolePrompt: "Fail",
            model: ref,
          })
          yield* team.addMember({
            teamID: info.id,
            sessionID: dependentSession.id,
            name: "dependent",
            agentType: "general",
            rolePrompt: "Wait for upstream",
            dependencyIDs: [upstreamSession.id],
          })
          const independent = yield* team.addMember({
            teamID: info.id,
            sessionID: independentSession.id,
            name: "independent",
            agentType: "general",
            rolePrompt: "Independent",
            model: ref,
          })
          const dependent = (yield* team.getMembers(info.id)).find((member) => member.name === "dependent")
          yield* team.updateMemberStatus(dependent!.id, "blocked")
          yield* team.updateMemberStatus(independent.id, "active")

          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: () =>
              Effect.sync(() => {
                throw new Error("boom")
              }),
            wake: () => Effect.void,
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const outcome = yield* lifecycle.startMember({ memberID: upstream.id, ops: promptOps })
          expect(outcome).toBe("boom")

          const members = yield* team.getMembers(info.id)
          const upstreamNow = members.find((member) => member.id === upstream.id)
          const dependentNow = members.find((member) => member.name === "dependent")
          const independentNow = members.find((member) => member.name === "independent")
          expect(upstreamNow?.status).toBe("cancelled")
          expect(upstreamNow?.failure_code).toBe("provider_error")
          expect(dependentNow?.status).toBe("cancelled")
          expect(dependentNow?.failure_code).toBe("dependency_failed")
          expect(independentNow?.status).toBe("active")

          const messages = yield* team.getMessages(info.id)
          const dependentCancelled = messages.find(
            (message) => message.id === `lifecycle:member:${dependentNow?.id}:cancelled:0`,
          )
          expect(dependentCancelled?.body).toContain("upstream")
          const upstreamCancelled = messages.find(
            (message) => message.id === `lifecycle:member:${upstream.id}:cancelled:1`,
          )
          expect(upstreamCancelled?.body).toContain("boom")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.effect("plan approval permission filter removes write deny rules", () =>
    Effect.sync(() => {
      const rules: Permission.Rule[] = [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "apply_patch", pattern: "*", action: "deny" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "**", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "deny" },
      ]

      const filtered = rules.filter(
        (rule) =>
          !(
            rule.action === "deny" &&
            rule.pattern === "*" &&
            (rule.permission === "edit" ||
              rule.permission === "write" ||
              rule.permission === "bash" ||
              rule.permission === "apply_patch")
          ),
      )

      expect(filtered.length).toBe(3)
      expect(filtered.find((r) => r.permission === "read")).toBeTruthy()
      expect(filtered.find((r) => r.permission === "external_directory")).toBeTruthy()
      expect(filtered.find((r) => r.permission === "todowrite")).toBeTruthy()
      expect(filtered.find((r) => r.permission === "bash")).toBeUndefined()
      expect(filtered.find((r) => r.permission === "write")).toBeUndefined()
      expect(filtered.find((r) => r.permission === "edit")).toBeUndefined()
      expect(filtered.find((r) => r.permission === "apply_patch")).toBeUndefined()
    }),
  )

  it.live("maps an updateTask database query failure to a defect", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const database = yield* Database.Service
        const events = yield* EventV2Bridge.Service
        const runState = yield* SessionRunState.Service
        const info = yield* team.create({ name: "db-failure", goal: "Fail update", leadSessionID: "ses_db_lead" })
        const task = yield* team.createTask({ teamID: info.id, description: "Stay pending" })
        const failure = new EffectDrizzleQueryError({
          query: "UPDATE team_task",
          params: [],
          cause: Cause.fail(new Error("injected database failure")),
        })
        const failingDb = new Proxy(database.db, {
          get(target, property, receiver) {
            if (property === "transaction") return () => Effect.fail(failure)
            return Reflect.get(target, property, receiver)
          },
        })
        const failingLayer = Team.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Database.Service, Database.Service.of({ db: failingDb })),
              Layer.succeed(EventV2Bridge.Service, events),
              Layer.succeed(SessionRunState.Service, runState),
            ),
          ),
        )
        const failingTeam = yield* Team.Service.pipe(Effect.provide(Layer.fresh(failingLayer)))

        const exit = yield* failingTeam.updateTask(info.id, task.id, { status: "completed" }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error("Expected updateTask to fail")
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Cause.hasFails(exit.cause)).toBe(false)
        expect((yield* team.getTask(info.id, task.id)).pipe(Option.getOrThrow).status).toBe("pending")
      }),
    ),
  )
})

describe("team revision", () => {
  it.live("team creation starts at revision 0 and each material mutation bumps exactly once", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const { db } = yield* Database.Service
        const revisionOf = (teamID: string) =>
          db
            .select({ revision: TeamTable.revision })
            .from(TeamTable)
            .where(eq(TeamTable.id, teamID))
            .get()
            .pipe(Effect.orDie)

        const info = yield* team.create({
          name: "revision-team",
          goal: "Track revisions",
          leadSessionID: "ses_rev_lead",
        })
        expect((yield* revisionOf(info.id))?.revision).toBe(0)

        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_rev_member",
          name: "builder",
          agentType: "general",
          rolePrompt: "Build",
        })
        expect((yield* revisionOf(info.id))?.revision).toBe(1)

        yield* team.updateMemberStatus(member.id, "active")
        expect((yield* revisionOf(info.id))?.revision).toBe(2)

        const task = yield* team.createTask({ teamID: info.id, description: "Rev task" })
        expect((yield* revisionOf(info.id))?.revision).toBe(3)

        yield* team.claimTask(info.id, task.id, member.session_id)
        expect((yield* revisionOf(info.id))?.revision).toBe(4)

        yield* team.updateTask(info.id, task.id, { status: "completed" })
        expect((yield* revisionOf(info.id))?.revision).toBe(5)
      }),
    ),
  )

  it.live("a terminal status change and its canonical notification commit with one atomic revision bump", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const { db } = yield* Database.Service
        const revisionOf = (teamID: string) =>
          db
            .select({ revision: TeamTable.revision })
            .from(TeamTable)
            .where(eq(TeamTable.id, teamID))
            .get()
            .pipe(Effect.orDie)

        const info = yield* team.create({ name: "revision-fail", goal: "Track", leadSessionID: "ses_rev_fail_lead" })
        const failed = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_rev_failed",
          name: "failed",
          agentType: "general",
          rolePrompt: "Fail",
        })
        const before = (yield* revisionOf(info.id))?.revision ?? -1

        // A terminal status and its canonical lead notification persist in one atomic
        // transaction, so the whole terminal handoff bumps the revision exactly once.
        yield* team.updateMemberStatus(failed.id, "failed", { failureCode: "provider_error" })
        expect((yield* revisionOf(info.id))?.revision).toBe(before + 1)
      }),
    ),
  )
})

describe("team terminal handoff atomicity", () => {
  const revisionOf = (teamID: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db
        .select({ revision: TeamTable.revision })
        .from(TeamTable)
        .where(eq(TeamTable.id, teamID))
        .get()
        .pipe(Effect.orDie))?.revision
    })

  it.live("a terminal update persists status and one canonical notification atomically", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "handoff-atomic",
          goal: "Atomic",
          leadSessionID: "ses_handoff_atomic_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_handoff_atomic_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        const before = (yield* revisionOf(info.id)) ?? -1

        yield* team.updateMemberStatus(member.id, "completed", "done result")

        const current = unwrap(yield* team.getMemberBySession(member.session_id))
        expect(current.status).toBe("completed")
        expect(current.result).toBe("done result")
        const messages = yield* team.getMessages(info.id)
        expect(messages).toHaveLength(1)
        expect(messages[0]?.id).toBe(`team:member:${member.id}:terminal:completed`)
        expect(messages[0]?.body).toContain("completed their work")
        expect(messages[0]?.body).toContain("done result")
        expect(yield* revisionOf(info.id)).toBe(before + 1)
      }),
    ),
  )

  it.live("repeated terminal updates are idempotent: one notification and one revision bump total", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "handoff-idempotent",
          goal: "Idempotent",
          leadSessionID: "ses_handoff_idem_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_handoff_idem_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        const before = (yield* revisionOf(info.id)) ?? -1

        yield* team.updateMemberStatus(member.id, "completed", "first")
        yield* team.updateMemberStatus(member.id, "completed", "second")

        const messages = (yield* team.getMessages(info.id)).filter(
          (message) => message.id === `team:member:${member.id}:terminal:completed`,
        )
        expect(messages).toHaveLength(1)
        expect(messages[0]?.body).toContain("first")
        expect(yield* revisionOf(info.id)).toBe(before + 1)
      }),
    ),
  )

  it.live("a cancelled terminal update notifies the lead with the failure reason", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({
          name: "handoff-cancelled",
          goal: "Cancelled",
          leadSessionID: "ses_handoff_cancel_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_handoff_cancel_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })

        yield* team.updateMemberStatus(member.id, "cancelled", { failureCode: "provider_error", result: "boom" })

        const messages = yield* team.getMessages(info.id)
        expect(messages).toHaveLength(1)
        expect(messages[0]?.id).toBe(`team:member:${member.id}:terminal:cancelled`)
        expect(messages[0]?.body).toContain("been cancelled")
        expect(messages[0]?.body).toContain("boom")
        const current = unwrap(yield* team.getMemberBySession(member.session_id))
        expect(current.failure_code).toBe("provider_error")
        expect(current.result).toBe("boom")
      }),
    ),
  )

  it.live("a notification insert failure rolls back the terminal status update", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const { db } = yield* Database.Service
        const info = yield* team.create({
          name: "handoff-rollback",
          goal: "Rollback",
          leadSessionID: "ses_handoff_rb_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_handoff_rb_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        // Force the in-transaction notification insert to conflict on the deterministic message
        // primary key: the status write must roll back with it.
        yield* db
          .insert(TeamMessageTable)
          .values({
            id: `team:member:${member.id}:terminal:completed`,
            team_id: info.id,
            sender: member.session_id,
            recipients: [info.lead_session_id],
            body: "conflicting pre-inserted message",
            delivery_status: "pending",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        const exit = yield* team.updateMemberStatus(member.id, "completed", "never persisted").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)

        const current = unwrap(yield* team.getMemberBySession(member.session_id))
        expect(current.status).toBe("starting")
        expect(current.result).toBeNull()
      }),
    ),
  )

  it.live("a terminal transition publishes exactly one member and one message event after commit", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const bus = yield* Bus.Service
        const info = yield* team.create({
          name: "handoff-events",
          goal: "Events",
          leadSessionID: "ses_handoff_evt_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_handoff_evt_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })

        const seen: string[] = []
        const bothReceived = yield* Deferred.make<void>()
        const unsubscribe = yield* bus.subscribeAllCallback((event) => {
          if (event.type !== "team.member.updated" && event.type !== "team.message.received") return
          seen.push(event.type)
          if (
            seen.filter((type) => type === "team.member.updated").length === 1 &&
            seen.filter((type) => type === "team.message.received").length === 1
          ) {
            Deferred.doneUnsafe(bothReceived, Effect.void)
          }
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()))

        yield* team.updateMemberStatus(member.id, "completed", "done")
        yield* awaitWithTimeout(Deferred.await(bothReceived), "terminal events were not published")

        // A repeated terminal update is a no-op and publishes nothing new.
        yield* team.updateMemberStatus(member.id, "completed", "again")
        expect(seen.filter((type) => type === "team.member.updated")).toHaveLength(1)
        expect(seen.filter((type) => type === "team.message.received")).toHaveLength(1)
      }),
    ),
  )

  it.live("terminal settlement and shutdown directly signal the parked lead after commit", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const runState = yield* SessionRunState.Service
        const info = yield* team.create({
          name: "handoff-direct-signal",
          goal: "Signal after commit",
          leadSessionID: "ses_handoff_signal_lead",
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_handoff_signal_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        const settlementSignal = yield* Deferred.make<void>()
        const settlementPark = yield* runState.registerPark(
          SessionID.make(info.lead_session_id),
          settlementSignal,
          Effect.die("unexpected park continuation"),
        )

        yield* team.updateMemberStatus(member.id, "completed", "done")

        expect(yield* Deferred.isDone(settlementSignal)).toBe(true)
        expect((yield* team.getPendingMessages(info.lead_session_id, info.id)).length).toBe(1)
        yield* settlementPark.unregister

        const closureSignal = yield* Deferred.make<void>()
        const closurePark = yield* runState.registerPark(
          SessionID.make(info.lead_session_id),
          closureSignal,
          Effect.die("unexpected park continuation"),
        )
        yield* Effect.addFinalizer(() => closurePark.unregister)
        yield* setLegacyProtocol(info.id)
        yield* team.shutdown({ teamID: info.id, sessionID: info.lead_session_id })

        expect(yield* Deferred.isDone(closureSignal)).toBe(true)
        expect(unwrap(yield* team.get(info.id)).status).toBe("closed")
      }),
    ),
  )

  it.live("a current lead stays wakeable over historical membership when event publication fails", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const database = yield* Database.Service
        const events = yield* EventV2Bridge.Service
        const runState = yield* SessionRunState.Service
        const leadSessionID = "ses_mail_publish_failure_lead"
        const historical = yield* team.create({
          name: "historical-member-team",
          goal: "Retain old membership",
          leadSessionID: "ses_historical_member_team_lead",
        })
        yield* team.addMember({
          teamID: historical.id,
          sessionID: leadSessionID,
          name: "historical-member",
          agentType: "general",
          model: ref,
          rolePrompt: "Historical membership only",
        })
        yield* database.db
          .update(TeamTable)
          .set({ status: "closed" })
          .where(eq(TeamTable.id, historical.id))
          .run()
          .pipe(Effect.orDie)
        const info = yield* team.create({
          name: "mail-publish-failure",
          goal: "Wake after failed publication",
          leadSessionID,
        })
        const signal = yield* Deferred.make<void>()
        const park = yield* runState.registerPark(
          SessionID.make(info.lead_session_id),
          signal,
          Effect.die("unexpected park continuation"),
        )
        yield* Effect.addFinalizer(() => park.unregister)
        const failingEvents: EventV2Bridge.Interface = {
          ...events,
          publish: (() =>
            Effect.die(new Error("simulated event publication failure"))) as EventV2Bridge.Interface["publish"],
        }
        const failingLayer = Team.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Database.Service, database),
              Layer.succeed(EventV2Bridge.Service, failingEvents),
              Layer.succeed(SessionRunState.Service, runState),
            ),
          ),
        )
        const failingTeam = yield* Team.Service.pipe(Effect.provide(Layer.fresh(failingLayer)))

        expect(yield* failingTeam.canWakeSession(leadSessionID)).toBe(true)
        let genericWakeAdmitted = false
        expect(
          yield* failingTeam.admitWake(
            leadSessionID,
            Effect.sync(() => {
              genericWakeAdmitted = true
            }),
          ),
        ).toBe(true)
        expect(genericWakeAdmitted).toBe(true)

        const message = yield* failingTeam.sendMessage({
          teamID: info.id,
          sender: "ses_mail_publish_failure_sender",
          recipients: [info.lead_session_id],
          body: "durable before signal",
        })

        expect(yield* Deferred.isDone(signal)).toBe(true)
        const pending = yield* team.getPendingMessages(info.lead_session_id, info.id)
        expect(pending.map((item) => item.id)).toEqual([message.id])
      }),
    ),
  )
})

describe("team shutdown admission", () => {
  const leadSessionID = "ses_shutdown_admission_lead"

  const setProtocol = (teamID: string, protocol: number, finalReportRevision?: number) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(TeamTable)
        .set({
          protocol_version: protocol,
          ...(finalReportRevision === undefined ? {} : { final_report_revision: finalReportRevision }),
        })
        .where(eq(TeamTable.id, teamID))
        .run()
        .pipe(Effect.orDie)
    })

  const revisionOf = (teamID: string) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db
        .select({ revision: TeamTable.revision, final_report_revision: TeamTable.final_report_revision })
        .from(TeamTable)
        .where(eq(TeamTable.id, teamID))
        .get()
        .pipe(Effect.orDie))?.revision
    })

  it.live("shutdown is lead-only and rejects a member caller", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "lead-only", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_shutdown_member_caller",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })

        const error = yield* team
          .shutdown({ teamID: info.id, sessionID: "ses_shutdown_member_caller" })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.ShutdownNotAuthorized)

        const after = yield* team.get(info.id)
        expect(unwrap(after).status).toBe("active")
      }),
    ),
  )

  it.live("shutdown rejects an unknown team as already closed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const error = yield* team.shutdown({ teamID: "ses_does_not_exist", sessionID: leadSessionID }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.ShutdownAlreadyClosed)
      }),
    ),
  )

  it.live(
    "protocol-0 normal shutdown closes atomically, releases tasks, preserves mail, and does not bump revision",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const info = yield* team.create({ name: "protocol-0-close", goal: "Close", leadSessionID })
          yield* setLegacyProtocol(info.id)
          const active = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_p0_active",
            name: "active",
            agentType: "general",
            rolePrompt: "Work",
          })
          const completed = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_p0_completed",
            name: "done",
            agentType: "general",
            rolePrompt: "Finish",
          })
          yield* team.updateMemberStatus(active.id, "active")
          yield* team.updateMemberStatus(completed.id, "completed")
          const pendingTask = yield* team.createTask({ teamID: info.id, description: "Pending task" })
          const ownedTask = yield* team.createTask({
            teamID: info.id,
            description: "Owned task",
            owned: [
              { rootKey: "/work", pathKey: "/work/p0-a.txt", displayPath: "p0-a.txt" },
              { rootKey: "/work", pathKey: "/work/p0-b.txt", displayPath: "p0-b.txt" },
            ],
          })
          yield* team.claimTask(info.id, ownedTask.id, "ses_p0_active")
          // Unread mailbox row: must survive shutdown untouched.
          yield* team.sendMessage({
            teamID: info.id,
            sender: leadSessionID,
            recipients: [active.session_id],
            body: "Read this later",
          })
          const before = (yield* revisionOf(info.id)) ?? -1
          const { db } = yield* Database.Service
          const recipientBefore = yield* db
            .select()
            .from(TeamMessageRecipientTable)
            .where(
              and(
                eq(TeamMessageRecipientTable.team_id, info.id),
                eq(TeamMessageRecipientTable.recipient, active.session_id),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          // One unread recipient row for the explicit message (the completed-member auto-notification
          // targets the lead and is separate). It must survive shutdown untouched.
          expect(recipientBefore).toHaveLength(1)
          expect(recipientBefore[0]?.delivery_status).toBe("pending")
          const totalRecipientsBefore = (yield* db
            .select()
            .from(TeamMessageRecipientTable)
            .where(eq(TeamMessageRecipientTable.team_id, info.id))
            .all()
            .pipe(Effect.orDie)).length

          const result = yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })

          expect(result.cancelledMembers).toBe(1)
          expect(result.cancelledTasks).toBe(2)
          expect(result.releasedReservations).toBe(2)
          expect(result.sessionCancellationFailures).toBe(0)

          const after = unwrap(yield* team.get(info.id))
          expect(after.status).toBe("closed")
          expect(yield* revisionOf(info.id)).toBe(before)

          const members = yield* team.getMembers(info.id)
          expect(members.find((member) => member.id === active.id)?.status).toBe("cancelled")
          expect(members.find((member) => member.id === completed.id)?.status).toBe("completed")

          const tasks = yield* team.getTasks(info.id)
          expect(tasks.find((task) => task.id === pendingTask.id)?.status).toBe("cancelled")
          const cancelledOwned = tasks.find((task) => task.id === ownedTask.id)
          expect(cancelledOwned?.status).toBe("cancelled")
          expect(cancelledOwned?.reservations.every((reservation) => reservation.timeReleased !== null)).toBe(true)

          const recipientAfter = yield* db
            .select()
            .from(TeamMessageRecipientTable)
            .where(eq(TeamMessageRecipientTable.team_id, info.id))
            .all()
            .pipe(Effect.orDie)
          // Unread mailbox rows are preserved: the same recipient rows exist with the same state.
          expect(recipientAfter).toHaveLength(totalRecipientsBefore)
          const explicitAfter = recipientAfter.find((row) => row.recipient === active.session_id)
          expect(explicitAfter?.delivery_status).toBe("pending")
          expect(yield* team.getMessages(info.id)).toHaveLength(2)
        }),
      ),
  )

  it.live("protocol-1 normal shutdown without a current final report is rejected", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "protocol-1-gate", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_p1_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        yield* setProtocol(info.id, 1)
        const revision = (yield* revisionOf(info.id)) ?? -1

        const error = yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.ShutdownFinalReportRequired)
        if (error instanceof Team.ShutdownFinalReportRequired) {
          expect(error.revision).toBe(revision)
          expect(error.finalReportRevision).toBeNull()
        }

        const after = yield* team.get(info.id)
        expect(unwrap(after).status).toBe("active")
      }),
    ),
  )

  it.live("protocol-1 normal shutdown closes when the final report covers the current revision", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "protocol-1-clear", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_p1_clear_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        const revision = (yield* revisionOf(info.id)) ?? -1
        yield* setProtocol(info.id, 1, revision)

        const result = yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })
        expect(result.cancelledMembers).toBe(1)
        expect(unwrap(yield* team.get(info.id)).status).toBe("closed")
      }),
    ),
  )

  it.live("protocol-1 normal shutdown rejects a stale final report after a later mutation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "protocol-1-stale", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_p1_stale_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        const revision = (yield* revisionOf(info.id)) ?? -1
        yield* setProtocol(info.id, 1, revision)
        // A later material mutation bumps the revision and invalidates the checkpoint.
        yield* team.createTask({ teamID: info.id, description: "Late task" })

        const error = yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.ShutdownFinalReportRequired)
        expect(unwrap(yield* team.get(info.id)).status).toBe("active")
      }),
    ),
  )

  it.live("forced shutdown with a reason bypasses the protocol-1 gate and records the event", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "forced-close", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_forced_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        yield* setProtocol(info.id, 1)

        const result = yield* team.shutdown({
          teamID: info.id,
          sessionID: leadSessionID,
          force: true,
          reason: "lead abandoned the team",
        })
        expect(result.cancelledMembers).toBe(1)
        expect(unwrap(yield* team.get(info.id)).status).toBe("closed")

        const { db } = yield* Database.Service
        const events = yield* db
          .select()
          .from(TeamUsageEventTable)
          .where(and(eq(TeamUsageEventTable.team_id, info.id), eq(TeamUsageEventTable.type, "forced_shutdown")))
          .all()
          .pipe(Effect.orDie)
        expect(events).toHaveLength(1)
        expect(events[0]?.metadata).toEqual(expect.objectContaining({ reason: "lead abandoned the team", force: true }))
      }),
    ),
  )

  it.live("forced shutdown without a nonblank reason is rejected", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "forced-no-reason", goal: "Close", leadSessionID })

        const missing = yield* team
          .shutdown({ teamID: info.id, sessionID: leadSessionID, force: true })
          .pipe(Effect.flip)
        expect(missing).toBeInstanceOf(Team.ShutdownReasonRequired)

        const blank = yield* team
          .shutdown({ teamID: info.id, sessionID: leadSessionID, force: true, reason: "   " })
          .pipe(Effect.flip)
        expect(blank).toBeInstanceOf(Team.ShutdownReasonRequired)

        expect(unwrap(yield* team.get(info.id)).status).toBe("active")
      }),
    ),
  )

  it.live("force:false keeps normal shutdown behavior and does not record a forced event", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "force-false", goal: "Close", leadSessionID })
        yield* setProtocol(info.id, 1)

        const error = yield* team
          .shutdown({ teamID: info.id, sessionID: leadSessionID, force: false, reason: "irrelevant" })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.ShutdownFinalReportRequired)

        yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID, force: true, reason: "wedged" })
        const { db } = yield* Database.Service
        const events = yield* db
          .select()
          .from(TeamUsageEventTable)
          .where(eq(TeamUsageEventTable.team_id, info.id))
          .all()
          .pipe(Effect.orDie)
        expect(events.filter((event) => event.type === "forced_shutdown")).toHaveLength(1)
      }),
    ),
  )

  it.live("a second shutdown after close is a stable error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "double-close", goal: "Close", leadSessionID })
        yield* setLegacyProtocol(info.id)
        yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })

        const error = yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.ShutdownAlreadyClosed)
        expect(unwrap(yield* team.get(info.id)).status).toBe("closed")
      }),
    ),
  )

  it.live("sendMessage after close is rejected and creates no rows", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "post-close-message", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_post_close_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        yield* setLegacyProtocol(info.id)
        yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })

        const error = yield* team
          .sendMessage({ teamID: info.id, sender: leadSessionID, recipients: ["ses_post_close_member"], body: "late" })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(Team.MessageToClosedTeam)

        const { db } = yield* Database.Service
        const messages = yield* db
          .select()
          .from(TeamMessageTable)
          .where(eq(TeamMessageTable.team_id, info.id))
          .all()
          .pipe(Effect.orDie)
        const recipients = yield* db
          .select()
          .from(TeamMessageRecipientTable)
          .where(eq(TeamMessageRecipientTable.team_id, info.id))
          .all()
          .pipe(Effect.orDie)
        expect(messages).toHaveLength(0)
        expect(recipients).toHaveLength(0)
      }),
    ),
  )
})

describe("team shutdown session cancellation", () => {
  const leadSessionID = "ses_shutdown_cancel_lead"
  const failSessionID = "ses_shutdown_cancel_fail"

  // A stub SessionRunState whose cancel fails for one member session, so the shutdown
  // service must surface the failure as a stable count without reopening the team.
  const runStateStub = (): SessionRunState.Interface => ({
    assertNotBusy: () => Effect.void,
    assertNotSuspended: () => Effect.void,
    cancel: (sessionID) =>
      sessionID === SessionID.make(failSessionID) ? Effect.die(new Error("simulated cancel failure")) : Effect.void,
    suspend: () => Effect.succeed(false),
    registerPark: () => Effect.succeed({ notify: () => false, unregister: Effect.void }),
    handoffPark: () => Effect.succeed(true),
    signalPark: () => Effect.succeed(false),
    registerWakeTarget: () => Effect.succeed(Effect.void),
    wakeRegistered: () => Effect.succeed(false),
    ensureRunning: () => Effect.void as unknown as Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
    wake: () => Effect.succeed(false),
    startShell: () =>
      Effect.void as unknown as Effect.Effect<SessionV1.WithParts, Session.BusyError | Runner.Suspended>,
    startSubstitution: () => Effect.succeed([]),
  })

  const itStubbed = testEffect(
    Layer.mergeAll(
      Agent.defaultLayer,
      BackgroundJob.defaultLayer,
      Config.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      Database.defaultLayer,
      EventV2Bridge.defaultLayer,
      LifecycleReconciler.defaultLayer,
      Session.defaultLayer,
      SessionControl.defaultLayer,
      SessionRunState.defaultLayer,
      SessionStatus.defaultLayer,
      Truncate.defaultLayer,
      RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
      Bus.layer,
      Team.layer.pipe(
        Layer.provide(Layer.succeed(SessionRunState.Service, runStateStub())),
        Layer.provide(EventV2Bridge.defaultLayer),
        Layer.provide(Database.defaultLayer),
        Layer.provide(CrossSpawnSpawner.defaultLayer),
      ),
    ),
  )

  itStubbed.live("shutdown reports per-session cancellation failures as a stable count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const info = yield* team.create({ name: "cancel-failure", goal: "Close", leadSessionID })
        yield* team.addMember({
          teamID: info.id,
          sessionID: failSessionID,
          name: "failing",
          agentType: "general",
          rolePrompt: "Work",
        })
        const ok = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_shutdown_cancel_ok",
          name: "ok",
          agentType: "general",
          rolePrompt: "Work",
        })
        yield* team.updateMemberStatus(ok.id, "active")

        yield* setLegacyProtocol(info.id)
        const result = yield* team.shutdown({ teamID: info.id, sessionID: leadSessionID })

        expect(result.cancelledMembers).toBe(2)
        expect(result.sessionCancellationFailures).toBe(1)
        // Durable state stays closed despite the cancellation failure.
        expect(unwrap(yield* team.get(info.id)).status).toBe("closed")
      }),
    ),
  )
})
