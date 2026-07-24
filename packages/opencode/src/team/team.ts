import { Database } from "@oc2-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { EventV2 } from "@oc2-ai/core/event"
import { Context, Effect, Layer, Schema, Option } from "effect"
import { eq, and, asc, desc, sql } from "drizzle-orm"
import {
  TeamTable,
  TeamMemberTable,
  TeamTaskTable,
  TeamMessageTable,
  TeamMessageRecipientTable,
  TeamUsageEventTable,
} from "./team.sql"

const toOption = <T>(v: T | null | undefined): Option.Option<T> => (v != null ? Option.some(v) : Option.none())

type TeamRow = typeof TeamTable.$inferSelect
type TeamMemberRow = typeof TeamMemberTable.$inferSelect
type TeamMemberInsert = typeof TeamMemberTable.$inferInsert
type TeamTaskRow = typeof TeamTaskTable.$inferSelect
type TeamTaskInsert = typeof TeamTaskTable.$inferInsert
type TeamMessageRow = typeof TeamMessageTable.$inferSelect
type TeamUsageEventRow = typeof TeamUsageEventTable.$inferSelect

export type Info = TeamRow
export type Member = Omit<TeamMemberRow, "model" | "dependency_ids" | "result"> & {
  model: TeamMemberInsert["model"]
  dependency_ids: TeamMemberInsert["dependency_ids"]
  result: TeamMemberInsert["result"]
}
export type Task = Omit<TeamTaskRow, "assignee" | "dependency_ids" | "metadata"> & {
  assignee: TeamTaskInsert["assignee"]
  dependency_ids: TeamTaskInsert["dependency_ids"]
  metadata: TeamTaskInsert["metadata"]
}
export type Message = TeamMessageRow
export type MemberStatus = TeamMemberRow["status"]
export type MemberLifecycle = TeamMemberRow["lifecycle"]
export type MemberDaemonState = NonNullable<TeamMemberRow["daemon_state"]>
export type TaskStatus = TeamTaskRow["status"]

type TeamMemberStatusUpdate = {
  result?: string
  daemonState?: MemberDaemonState | null
  daemonLastActive?: number | null
  daemonError?: string | null
}

export type UsageEventType = TeamUsageEventRow["type"]

export type UsageEvent = {
  id: string
  team_id: string
  session_id?: string
  member_id?: string
  type: UsageEventType
  metadata: Record<string, unknown>
  time_created: number
}

export interface Interface {
  create: (input: { name: string; goal: string; leadSessionID: string }) => Effect.Effect<Info>
  getActive: (leadSessionID: string) => Effect.Effect<Option.Option<Info>>
  getByLeadSession: (leadSessionID: string) => Effect.Effect<Option.Option<Info>>
  get: (teamID: string) => Effect.Effect<Option.Option<Info>>
  shutdown: (teamID: string) => Effect.Effect<void>
  addMember: (input: {
    teamID: string
    sessionID: string
    name: string
    agentType: string
    model?: { providerID: string; modelID: string; variant?: string }
    rolePrompt: string
    planMode?: boolean
    workMode?: "plan" | "implement"
    dependencyIDs?: string[]
    lifecycle?: MemberLifecycle
    daemonState?: MemberDaemonState | null
    daemonLastActive?: number | null
    daemonError?: string | null
  }) => Effect.Effect<Member>
  updateMemberStatus: (
    memberID: string,
    status: MemberStatus,
    resultOrUpdate?: string | TeamMemberStatusUpdate,
  ) => Effect.Effect<Option.Option<Member>>
  approveMemberPlan: (memberID: string) => Effect.Effect<Option.Option<Member>>
  getMembers: (teamID: string) => Effect.Effect<Member[]>
  getMemberBySession: (sessionID: string) => Effect.Effect<Option.Option<Member>>
  getContext: (sessionID: string) => Effect.Effect<Option.Option<{ team: Info; member?: Member }>>
  createTask: (input: {
    teamID: string
    description: string
    assignee?: string
    dependencyIDs?: string[]
    metadata?: Record<string, unknown>
  }) => Effect.Effect<Task, Error>
  getTask: (teamID: string, taskID: string) => Effect.Effect<Option.Option<Task>, Error>
  updateTask: (
    teamID: string,
    taskID: string,
    update: Partial<{ status: TaskStatus; assignee: string }>,
  ) => Effect.Effect<Option.Option<Task>, Error>
  claimTask: (teamID: string, taskID: string, assignee: string) => Effect.Effect<Option.Option<Task>, Error>
  getTasks: (teamID: string) => Effect.Effect<Task[]>
  sendMessage: (input: { teamID: string; sender: string; recipients: string[]; body: string }) => Effect.Effect<Message>
  getMessages: (teamID: string) => Effect.Effect<Message[]>
  getPendingMessages: (recipientSession: string, teamID: string) => Effect.Effect<Message[]>
  claimPendingMessages: (recipientSession: string, teamID: string) => Effect.Effect<Message[]>
  markMessageDelivered: (messageID: string, recipientSession?: string) => Effect.Effect<void>
  createUsageEvent: (input: {
    teamID: string
    sessionID?: string
    memberID?: string
    type: UsageEventType
    metadata?: Record<string, unknown>
  }) => Effect.Effect<UsageEvent>
  getUsageEvents: (teamID: string) => Effect.Effect<UsageEvent[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Team") {}

const TeamCreated = EventV2.define({ type: "team.created", schema: { teamID: Schema.String } })
const TeamClosed = EventV2.define({ type: "team.closed", schema: { teamID: Schema.String } })
const MemberUpdated = EventV2.define({
  type: "team.member.updated",
  schema: {
    memberID: Schema.String,
    sessionID: Schema.String,
    status: Schema.String,
    lifecycle: Schema.optional(Schema.String),
    daemonState: Schema.optional(Schema.String),
  },
})
const MessageReceived = EventV2.define({
  type: "team.message.received",
  schema: { messageID: Schema.String, teamID: Schema.String, sender: Schema.String },
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const runState = yield* SessionRunState.Service
    const { db } = yield* Database.Service

    const create = Effect.fn("Team.create")(function* (input: { name: string; goal: string; leadSessionID: string }) {
      const existing = yield* db
        .select()
        .from(TeamTable)
        .where(and(eq(TeamTable.lead_session_id, input.leadSessionID), eq(TeamTable.status, "active")))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        return yield* Effect.die(new Error("Lead session already has an active team"))
      }

      const id = crypto.randomUUID()
      const now = Date.now()
      yield* db
        .insert(TeamTable)
        .values({
          id,
          name: input.name,
          goal: input.goal,
          lead_session_id: input.leadSessionID,
          status: "active",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(TeamCreated, { teamID: id })
      yield* events.publish(TuiEvent.ToastShow, {
        title: "Team Created",
        message: `Team "${input.name}" is ready. Add members with team_spawn.`,
        variant: "success",
        duration: 5000,
      })
      return {
        id,
        name: input.name,
        goal: input.goal,
        lead_session_id: input.leadSessionID,
        status: "active",
        time_created: now,
        time_updated: now,
      } satisfies Info
    })

    const getActive = Effect.fn("Team.getActive")(function* (leadSessionID: string) {
      const row = yield* db
        .select()
        .from(TeamTable)
        .where(and(eq(TeamTable.lead_session_id, leadSessionID), eq(TeamTable.status, "active")))
        .get()
        .pipe(Effect.orDie)
      return toOption(row)
    })

    const getByLeadSession = Effect.fn("Team.getByLeadSession")(function* (leadSessionID: string) {
      const row = yield* db
        .select()
        .from(TeamTable)
        .where(eq(TeamTable.lead_session_id, leadSessionID))
        .orderBy(asc(sql`case when ${TeamTable.status} = 'active' then 0 else 1 end`), desc(TeamTable.time_created), desc(TeamTable.id))
        .get()
        .pipe(Effect.orDie)
      return toOption(row)
    })

    const get = Effect.fn("Team.get")(function* (teamID: string) {
      const row = yield* db.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get().pipe(Effect.orDie)
      return toOption(row)
    })

    const shutdown = Effect.fn("Team.shutdown")(function* (teamID: string) {
      const now = Date.now()
      yield* db
        .update(TeamTable)
        .set({ status: "closed", time_updated: now })
        .where(eq(TeamTable.id, teamID))
        .run()
        .pipe(Effect.orDie)
      const allMembers = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        allMembers.filter((member) => member.status !== "completed" && member.status !== "cancelled"),
        (member) =>
          db
            .update(TeamMemberTable)
            .set({
              status: "cancelled",
              time_updated: now,
              ...(member.lifecycle === "daemon" ? { daemon_state: "cancelled" as const, daemon_last_active: now } : {}),
            })
            .where(eq(TeamMemberTable.id, member.id))
            .run()
            .pipe(Effect.orDie),
        { concurrency: "unbounded", discard: true },
      )
      yield* Effect.forEach(
        allMembers,
        (member) => runState.cancel(SessionID.make(member.session_id)).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      )
      yield* Effect.forEach(
        allMembers,
        (member) =>
          events.publish(MemberUpdated, {
            memberID: member.id,
            sessionID: member.session_id,
            status: member.status === "completed" || member.status === "cancelled" ? member.status : "cancelled",
            lifecycle: member.lifecycle,
            daemonState: member.lifecycle === "daemon" ? "cancelled" : (member.daemon_state ?? undefined),
          }),
        { concurrency: "unbounded", discard: true },
      )
      yield* events.publish(TeamClosed, { teamID })
      yield* events.publish(TuiEvent.ToastShow, {
        title: "Team Shut Down",
        message: "The team has been closed and all active members cancelled.",
        variant: "info",
        duration: 5000,
      })
    })

    const addMember = Effect.fn("Team.addMember")(function* (input: {
      teamID: string
      sessionID: string
      name: string
      agentType: string
      model?: { providerID: string; modelID: string; variant?: string }
      rolePrompt: string
      planMode?: boolean
      workMode?: "plan" | "implement"
      dependencyIDs?: string[]
      lifecycle?: MemberLifecycle
      daemonState?: MemberDaemonState | null
      daemonLastActive?: number | null
      daemonError?: string | null
    }) {
      const id = crypto.randomUUID()
      const now = Date.now()
      yield* db
        .insert(TeamMemberTable)
        .values({
          id,
          team_id: input.teamID,
          session_id: input.sessionID,
          name: input.name,
          agent_type: input.agentType,
          model: input.model ?? null,
          role_prompt: input.rolePrompt,
          status: "starting",
          lifecycle: input.lifecycle ?? "task",
          daemon_state: input.daemonState ?? null,
          daemon_last_active: input.daemonLastActive ?? null,
          daemon_error: input.daemonError ?? null,
          plan_mode: input.planMode ?? false,
          work_mode: input.workMode ?? "implement",
          dependency_ids: input.dependencyIDs ?? null,
          result: null,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return {
        id,
        team_id: input.teamID,
        session_id: input.sessionID,
        name: input.name,
        agent_type: input.agentType,
        model: input.model,
        role_prompt: input.rolePrompt,
        status: "starting",
        lifecycle: input.lifecycle ?? "task",
        daemon_state: input.daemonState ?? null,
        daemon_last_active: input.daemonLastActive ?? null,
        daemon_error: input.daemonError ?? null,
        plan_mode: input.planMode ?? false,
        work_mode: input.workMode ?? "implement",
        dependency_ids: input.dependencyIDs,
        result: undefined,
        time_created: now,
        time_updated: now,
      } satisfies Member
    })

    const updateMemberStatus = Effect.fn("Team.updateMemberStatus")(function* (
      memberID: string,
      status: MemberStatus,
      resultOrUpdate?: string | TeamMemberStatusUpdate,
    ) {
      const now = Date.now()
      const update = typeof resultOrUpdate === "string" ? { result: resultOrUpdate } : resultOrUpdate
      const setData: Partial<TeamMemberInsert> = { status, time_updated: now }
      if (update?.result !== undefined) setData.result = update.result
      if (update?.daemonState !== undefined) setData.daemon_state = update.daemonState
      if (update?.daemonLastActive !== undefined) setData.daemon_last_active = update.daemonLastActive
      if (update?.daemonError !== undefined) setData.daemon_error = update.daemonError
      yield* db.update(TeamMemberTable).set(setData).where(eq(TeamMemberTable.id, memberID)).run().pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.id, memberID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      yield* events.publish(MemberUpdated, {
        memberID: row.id,
        sessionID: row.session_id,
        status: row.status,
        lifecycle: row.lifecycle,
        daemonState: row.daemon_state ?? undefined,
      })

      if (row.status === "completed" || row.status === "idle") {
        const statusText = row.status === "completed" ? "completed their work" : "became idle"
        const team = yield* db.select().from(TeamTable).where(eq(TeamTable.id, row.team_id)).get().pipe(Effect.orDie)
        if (team) {
          yield* sendMessage({
            teamID: row.team_id,
            sender: row.session_id,
            recipients: [team.lead_session_id],
            body: `Teammate ${row.name} (${row.agent_type}) has ${statusText}.`,
          })
          yield* events.publish(TuiEvent.ToastShow, {
            title: "Teammate Update",
            message: `${row.name} (${row.agent_type}) has ${statusText}.`,
            variant: "info",
            duration: 5000,
          })
        }
      }

      return Option.some({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id,
        name: row.name,
        agent_type: row.agent_type,
        model: row.model,
        role_prompt: row.role_prompt,
        status: row.status,
        lifecycle: row.lifecycle,
        daemon_state: row.daemon_state,
        daemon_last_active: row.daemon_last_active,
        daemon_error: row.daemon_error,
        plan_mode: row.plan_mode,
        work_mode: row.work_mode,
        dependency_ids: row.dependency_ids,
        result: row.result,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const approveMemberPlan = Effect.fn("Team.approveMemberPlan")(function* (memberID: string) {
      const now = Date.now()
      yield* db
        .update(TeamMemberTable)
        .set({ status: "active", plan_mode: false, work_mode: "implement", time_updated: now })
        .where(eq(TeamMemberTable.id, memberID))
        .run()
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.id, memberID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      yield* events.publish(MemberUpdated, {
        memberID: row.id,
        sessionID: row.session_id,
        status: row.status,
        lifecycle: row.lifecycle,
        daemonState: row.daemon_state ?? undefined,
      })
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id,
        name: row.name,
        agent_type: row.agent_type,
        model: row.model,
        role_prompt: row.role_prompt,
        status: row.status,
        lifecycle: row.lifecycle,
        daemon_state: row.daemon_state,
        daemon_last_active: row.daemon_last_active,
        daemon_error: row.daemon_error,
        plan_mode: row.plan_mode,
        work_mode: row.work_mode,
        dependency_ids: row.dependency_ids,
        result: row.result,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const getMembers = Effect.fn("Team.getMembers")(function* (teamID: string) {
      return (yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)).map((row) => ({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id,
        name: row.name,
        agent_type: row.agent_type,
        model: row.model,
        role_prompt: row.role_prompt,
        status: row.status,
        lifecycle: row.lifecycle,
        daemon_state: row.daemon_state,
        daemon_last_active: row.daemon_last_active,
        daemon_error: row.daemon_error,
        plan_mode: row.plan_mode,
        work_mode: row.work_mode,
        dependency_ids: row.dependency_ids,
        result: row.result,
        time_created: row.time_created,
        time_updated: row.time_updated,
      }))
    })

    const getMemberBySession = Effect.fn("Team.getMemberBySession")(function* (sessionID: string) {
      const row = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id,
        name: row.name,
        agent_type: row.agent_type,
        model: row.model,
        role_prompt: row.role_prompt,
        status: row.status,
        lifecycle: row.lifecycle,
        daemon_state: row.daemon_state,
        daemon_last_active: row.daemon_last_active,
        daemon_error: row.daemon_error,
        plan_mode: row.plan_mode,
        work_mode: row.work_mode,
        dependency_ids: row.dependency_ids,
        result: row.result,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const getContext = Effect.fn("Team.getContext")(function* (sessionID: string) {
      const active = yield* getActive(sessionID)
      if (Option.isSome(active)) return Option.some({ team: active.value })
      const member = yield* getMemberBySession(sessionID)
      if (Option.isNone(member)) return Option.none()
      const info = yield* get(member.value.team_id)
      if (Option.isNone(info) || info.value.status !== "active") return Option.none()
      return Option.some({ team: info.value, member: member.value })
    })

    const createTask = Effect.fn("Team.createTask")(function* (input: {
      teamID: string
      description: string
      assignee?: string
      dependencyIDs?: string[]
      metadata?: Record<string, unknown>
    }) {
      const dependencyIDs = yield* Effect.forEach(input.dependencyIDs ?? [], (dependencyID) =>
        Effect.gen(function* () {
          const resolved = yield* resolveTaskID(input.teamID, dependencyID)
          if (Option.isNone(resolved))
            return yield* Effect.fail(new Error(`Task dependency not found: ${dependencyID}`))
          return resolved.value
        }),
      )
      const id = crypto.randomUUID()
      const now = Date.now()
      yield* db
        .insert(TeamTaskTable)
        .values({
          id,
          team_id: input.teamID,
          description: input.description,
          status: "pending",
          assignee: input.assignee ?? null,
          dependency_ids: dependencyIDs.length > 0 ? dependencyIDs : null,
          metadata: input.metadata ?? null,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      return {
        id,
        team_id: input.teamID,
        description: input.description,
        status: "pending",
        assignee: input.assignee,
        dependency_ids: dependencyIDs.length > 0 ? dependencyIDs : undefined,
        metadata: input.metadata,
        time_created: now,
        time_updated: now,
      } satisfies Task
    })

    const getTask = Effect.fn("Team.getTask")(function* (teamID: string, taskID: string) {
      const resolved = yield* resolveTaskID(teamID, taskID)
      if (Option.isNone(resolved)) return Option.none()
      const row = yield* db
        .select()
        .from(TeamTaskTable)
        .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        description: row.description,
        status: row.status,
        assignee: row.assignee,
        dependency_ids: row.dependency_ids,
        metadata: row.metadata,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const updateTask = Effect.fn("Team.updateTask")(function* (
      teamID: string,
      taskID: string,
      update: Partial<{ status: TaskStatus; assignee: string }>,
    ) {
      const resolved = yield* resolveTaskID(teamID, taskID)
      if (Option.isNone(resolved)) return Option.none()
      const now = Date.now()
      const setData: Partial<TeamTaskInsert> = { time_updated: now }
      if (update.status !== undefined) setData.status = update.status
      if (update.assignee !== undefined) setData.assignee = update.assignee
      yield* db
        .update(TeamTaskTable)
        .set(setData)
        .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
        .run()
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(TeamTaskTable)
        .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        description: row.description,
        status: row.status,
        assignee: row.assignee,
        dependency_ids: row.dependency_ids,
        metadata: row.metadata,
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const claimTask = Effect.fn("Team.claimTask")(function* (teamID: string, taskID: string, assignee: string) {
      const resolved = yield* resolveTaskID(teamID, taskID)
      if (Option.isNone(resolved)) return Option.none()
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
              if (!current || current.status !== "pending") return null
              if (current.dependency_ids) {
                const deps = current.dependency_ids
                const completed = (yield* tx
                  .select()
                  .from(TeamTaskTable)
                  .where(eq(TeamTaskTable.team_id, current.team_id))
                  .all()).filter((t) => deps.includes(t.id) && t.status === "completed")
                if (!deps.every((id) => completed.some((t) => t.id === id))) return null
              }
              yield* tx
                .update(TeamTaskTable)
                .set({ status: "in_progress", assignee, time_updated: now })
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .run()
              return yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!result) return Option.none()
      return Option.some({
        id: result.id,
        team_id: result.team_id,
        description: result.description,
        status: result.status,
        assignee: result.assignee,
        dependency_ids: result.dependency_ids,
        metadata: result.metadata,
        time_created: result.time_created,
        time_updated: result.time_updated,
      })
    })

    const getTasks = Effect.fn("Team.getTasks")(function* (teamID: string) {
      return (yield* db
        .select()
        .from(TeamTaskTable)
        .where(eq(TeamTaskTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)).map((row) => ({
        id: row.id,
        team_id: row.team_id,
        description: row.description,
        status: row.status,
        assignee: row.assignee,
        dependency_ids: row.dependency_ids,
        metadata: row.metadata,
        time_created: row.time_created,
        time_updated: row.time_updated,
      }))
    })

    const resolveTaskID = Effect.fn("Team.resolveTaskID")(function* (teamID: string, taskID: string) {
      const exact = yield* db
        .select({ id: TeamTaskTable.id })
        .from(TeamTaskTable)
        .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, taskID)))
        .get()
        .pipe(Effect.orDie)
      if (exact) return Option.some(exact.id)
      const matches = (yield* db
        .select({ id: TeamTaskTable.id })
        .from(TeamTaskTable)
        .where(eq(TeamTaskTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)).filter((task) => task.id.startsWith(taskID))
      if (matches.length === 0) return Option.none()
      const match = matches[0]
      if (matches.length === 1 && match) return Option.some(match.id)
      return yield* Effect.fail(
        new Error(
          `Ambiguous task ID prefix "${taskID}". Matching tasks: ${matches.map((task) => task.id.slice(0, 8)).join(", ")}`,
        ),
      )
    })

    const sendMessage = Effect.fn("Team.sendMessage")(function* (input: {
      teamID: string
      sender: string
      recipients: string[]
      body: string
    }) {
      const id = crypto.randomUUID()
      const now = Date.now()
      const recipients = [...new Set(input.recipients)]
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(TeamMessageTable)
                .values({
                  id,
                  team_id: input.teamID,
                  sender: input.sender,
                  recipients,
                  body: input.body,
                  delivery_status: "pending",
                  time_created: now,
                  time_updated: now,
                })
                .run()
              yield* Effect.forEach(
                recipients,
                (recipient) =>
                  tx
                    .insert(TeamMessageRecipientTable)
                    .values({
                      id: crypto.randomUUID(),
                      message_id: id,
                      team_id: input.teamID,
                      recipient,
                      delivery_status: "pending",
                      time_created: now,
                      time_updated: now,
                    })
                    .run(),
                { discard: true },
              )
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      yield* events.publish(MessageReceived, { messageID: id, teamID: input.teamID, sender: input.sender })
      return {
        id,
        team_id: input.teamID,
        sender: input.sender,
        recipients,
        body: input.body,
        delivery_status: "pending",
        time_created: now,
        time_updated: now,
      } satisfies Message
    })

    const getMessages = Effect.fn("Team.getMessages")(function* (teamID: string) {
      return (yield* db
        .select()
        .from(TeamMessageTable)
        .where(eq(TeamMessageTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)).map((row) => ({
        id: row.id,
        team_id: row.team_id,
        sender: row.sender,
        recipients: row.recipients,
        body: row.body,
        delivery_status: row.delivery_status,
        time_created: row.time_created,
        time_updated: row.time_updated,
      }))
    })

    const getPendingMessages = Effect.fn("Team.getPendingMessages")(function* (
      recipientSession: string,
      teamID: string,
    ) {
      const rows = yield* db
        .select({
          id: TeamMessageTable.id,
          team_id: TeamMessageTable.team_id,
          sender: TeamMessageTable.sender,
          recipients: TeamMessageTable.recipients,
          body: TeamMessageTable.body,
          delivery_status: TeamMessageRecipientTable.delivery_status,
          time_created: TeamMessageTable.time_created,
          time_updated: TeamMessageTable.time_updated,
        })
        .from(TeamMessageTable)
        .innerJoin(TeamMessageRecipientTable, eq(TeamMessageRecipientTable.message_id, TeamMessageTable.id))
        .where(
          and(
            eq(TeamMessageRecipientTable.team_id, teamID),
            eq(TeamMessageRecipientTable.recipient, recipientSession),
            eq(TeamMessageRecipientTable.delivery_status, "pending"),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        team_id: row.team_id,
        sender: row.sender,
        recipients: row.recipients,
        body: row.body,
        delivery_status: row.delivery_status,
        time_created: row.time_created,
        time_updated: row.time_updated,
      }))
    })

    const claimPendingMessages = Effect.fn("Team.claimPendingMessages")(function* (
      recipientSession: string,
      teamID: string,
    ) {
      const now = Date.now()
      const rows = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const pending = yield* tx
                .select({
                  recipient_id: TeamMessageRecipientTable.id,
                  id: TeamMessageTable.id,
                  team_id: TeamMessageTable.team_id,
                  sender: TeamMessageTable.sender,
                  recipients: TeamMessageTable.recipients,
                  body: TeamMessageTable.body,
                  delivery_status: TeamMessageRecipientTable.delivery_status,
                  time_created: TeamMessageTable.time_created,
                  time_updated: TeamMessageTable.time_updated,
                })
                .from(TeamMessageTable)
                .innerJoin(TeamMessageRecipientTable, eq(TeamMessageRecipientTable.message_id, TeamMessageTable.id))
                .where(
                  and(
                    eq(TeamMessageRecipientTable.team_id, teamID),
                    eq(TeamMessageRecipientTable.recipient, recipientSession),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                  ),
                )
                .all()
              yield* Effect.forEach(
                pending,
                (row) =>
                  tx
                    .update(TeamMessageRecipientTable)
                    .set({ delivery_status: "delivered", time_updated: now })
                    .where(
                      and(
                        eq(TeamMessageRecipientTable.id, row.recipient_id),
                        eq(TeamMessageRecipientTable.delivery_status, "pending"),
                      ),
                    )
                    .run(),
                { discard: true },
              )
              yield* Effect.forEach(
                [...new Set(pending.map((row) => row.id))],
                (messageID) =>
                  Effect.gen(function* () {
                    const remaining = yield* tx
                      .select()
                      .from(TeamMessageRecipientTable)
                      .where(
                        and(
                          eq(TeamMessageRecipientTable.message_id, messageID),
                          eq(TeamMessageRecipientTable.delivery_status, "pending"),
                        ),
                      )
                      .all()
                    if (remaining.length > 0) return
                    yield* tx
                      .update(TeamMessageTable)
                      .set({ delivery_status: "delivered", time_updated: now })
                      .where(eq(TeamMessageTable.id, messageID))
                      .run()
                  }),
                { discard: true },
              )
              return pending
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        id: row.id,
        team_id: row.team_id,
        sender: row.sender,
        recipients: row.recipients,
        body: row.body,
        delivery_status: row.delivery_status,
        time_created: row.time_created,
        time_updated: row.time_updated,
      }))
    })

    const markMessageDelivered = Effect.fn("Team.markMessageDelivered")(function* (
      messageID: string,
      recipientSession?: string,
    ) {
      const now = Date.now()
      yield* db
        .update(TeamMessageRecipientTable)
        .set({ delivery_status: "delivered", time_updated: now })
        .where(
          recipientSession
            ? and(
                eq(TeamMessageRecipientTable.message_id, messageID),
                eq(TeamMessageRecipientTable.recipient, recipientSession),
              )
            : eq(TeamMessageRecipientTable.message_id, messageID),
        )
        .run()
        .pipe(Effect.orDie)
      const pending = yield* db
        .select()
        .from(TeamMessageRecipientTable)
        .where(
          and(
            eq(TeamMessageRecipientTable.message_id, messageID),
            eq(TeamMessageRecipientTable.delivery_status, "pending"),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (pending.length > 0) return
      yield* db
        .update(TeamMessageTable)
        .set({ delivery_status: "delivered", time_updated: now })
        .where(eq(TeamMessageTable.id, messageID))
        .run()
        .pipe(Effect.orDie)
    })

    const createUsageEvent = Effect.fn("Team.createUsageEvent")(function* (input: {
      teamID: string
      sessionID?: string
      memberID?: string
      type: UsageEventType
      metadata?: Record<string, unknown>
    }) {
      const event = {
        id: crypto.randomUUID(),
        team_id: input.teamID,
        session_id: input.sessionID,
        member_id: input.memberID,
        type: input.type,
        metadata: input.metadata ?? {},
        time_created: Date.now(),
      }
      yield* db
        .insert(TeamUsageEventTable)
        .values({
          id: event.id,
          team_id: event.team_id,
          session_id: event.session_id ?? null,
          member_id: event.member_id ?? null,
          type: event.type,
          metadata: event.metadata,
          time_created: event.time_created,
        })
        .run()
        .pipe(Effect.orDie)
      return event
    })

    const getUsageEvents = Effect.fn("Team.getUsageEvents")(function* (teamID: string) {
      return (yield* db
        .select()
        .from(TeamUsageEventTable)
        .where(eq(TeamUsageEventTable.team_id, teamID))
        .orderBy(asc(TeamUsageEventTable.time_created), asc(TeamUsageEventTable.id))
        .all()
        .pipe(Effect.orDie)).map((row) => ({
        id: row.id,
        team_id: row.team_id,
        session_id: row.session_id ?? undefined,
        member_id: row.member_id ?? undefined,
        type: row.type,
        metadata: row.metadata,
        time_created: row.time_created,
      }))
    })

    return Service.of({
      create,
      getActive,
      getByLeadSession,
      get,
      shutdown,
      addMember,
      updateMemberStatus,
      approveMemberPlan,
      getMembers,
      getMemberBySession,
      getContext,
      createTask,
      getTask,
      updateTask,
      claimTask,
      getTasks,
      sendMessage,
      getMessages,
      getPendingMessages,
      claimPendingMessages,
      markMessageDelivered,
      createUsageEvent,
      getUsageEvents,
    })
  }).pipe(Effect.withSpan("Team.layer")),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionRunState.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export * as Team from "./team"
