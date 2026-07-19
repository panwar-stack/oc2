import { Database } from "@oc2-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { EventV2 } from "@oc2-ai/core/event"
import { Context, Effect, Layer, Schema, Option } from "effect"
import { eq, and, asc, desc, or } from "drizzle-orm"
import { recordMutation } from "./board-outbox"
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

const toMember = (row: TeamMemberRow): Member => row
const toTask = (row: TeamTaskRow): Task => row

export type RecipientDelivery = {
  recipientID: string
  messageID: string
  teamID: string
  recipientSessionID: string
  sender: string
  recipients: string[]
  body: string
  timeCreated: number
  timeUpdated: number
}

type TeamMemberStatusUpdate = {
  result?: string
  daemonState?: MemberDaemonState | null
  daemonLastActive?: number | null
  daemonError?: string | null
  displaySummary?: string | null
  mutability?: TeamMemberRow["mutability"]
  executionState?: TeamMemberRow["execution_state"]
  executionEpoch?: number
  leaseOwnerID?: string | null
  leaseExpiresAt?: number | null
  currentWorkSource?: TeamMemberRow["current_work_source"]
  currentWorkID?: string | null
  workStartedAt?: number | null
  outcome?: {
    type: NonNullable<TeamMemberRow["outcome_type"]>
    label: NonNullable<TeamMemberRow["outcome_label"]>
    cause?: string | null
  } | null
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
  get: (teamID: string) => Effect.Effect<Option.Option<Info>>
  shutdown: (teamID: string) => Effect.Effect<void>
  addMember: (input: {
    teamID: string
    sessionID: string
    name: string
    agentType: string
    model?: { providerID: string; modelID: string; variant?: string }
    rolePrompt: string
    role?: string
    displaySummary?: string
    mutability?: TeamMemberRow["mutability"]
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
  getHistory: (sessionID: string) => Effect.Effect<Info[]>
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
  listPendingRecipientDeliveries: (input?: {
    teamID?: string
    recipientSessionID?: string
  }) => Effect.Effect<RecipientDelivery[]>
  commitRecipientDelivery: (recipientID: string) => Effect.Effect<boolean>
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
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(TeamTable)
                .values({
                  id,
                  name: input.name,
                  goal: input.goal,
                  lead_session_id: input.leadSessionID,
                  status: "active",
                  board_revision: 0,
                  time_created: now,
                  time_updated: now,
                })
                .run()
              yield* recordMutation(tx, id, ["team.create"], now)
            }),
          { behavior: "immediate" },
        )
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
        board_revision: 1,
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

    const get = Effect.fn("Team.get")(function* (teamID: string) {
      const row = yield* db.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get().pipe(Effect.orDie)
      return toOption(row)
    })

    const shutdown = Effect.fn("Team.shutdown")(function* (teamID: string) {
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const info = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get()
              const allMembers = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.team_id, teamID))
                .all()
              if (!info || info.status !== "active") return { changed: false, members: allMembers }
              yield* tx
                .update(TeamTable)
                .set({ status: "closed", time_updated: now })
                .where(eq(TeamTable.id, teamID))
                .run()
              const changed = allMembers.filter(
                (member) => member.status !== "completed" && member.status !== "cancelled",
              )
              for (const member of changed) {
                yield* tx
                  .update(TeamMemberTable)
                  .set({
                    status: "cancelled",
                    outcome_type: "cancelled",
                    outcome_label: "cancelled",
                    outcome_cause: "team_shutdown",
                    outcome_at: now,
                    execution_state: "idle",
                    lease_owner_id: null,
                    lease_expires_at: null,
                    time_updated: now,
                    ...(member.lifecycle === "daemon"
                      ? { daemon_state: "cancelled" as const, daemon_last_active: now }
                      : {}),
                  })
                  .where(eq(TeamMemberTable.id, member.id))
                  .run()
              }
              yield* recordMutation(tx, teamID, ["team.shutdown"], now)
              return { changed: true, members: allMembers }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!result.changed) return
      const allMembers = result.members
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
      role?: string
      displaySummary?: string
      mutability?: TeamMemberRow["mutability"]
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
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(TeamMemberTable)
                .values({
                  id,
                  team_id: input.teamID,
                  session_id: input.sessionID,
                  name: input.name,
                  agent_type: input.agentType,
                  model: input.model ?? null,
                  role_prompt: input.rolePrompt,
                  role: input.role ?? null,
                  display_summary: input.displaySummary ? summarize(input.displaySummary) : null,
                  mutability: input.mutability ?? "unknown",
                  status: "starting",
                  lifecycle: input.lifecycle ?? "task",
                  daemon_state: input.daemonState ?? null,
                  daemon_last_active: input.daemonLastActive ?? null,
                  daemon_error: input.daemonError ?? null,
                  plan_mode: input.planMode ?? false,
                  work_mode: input.workMode ?? "implement",
                  dependency_ids: input.dependencyIDs ?? null,
                  execution_state: "starting",
                  result: null,
                  time_created: now,
                  time_updated: now,
                })
                .run()
              yield* recordMutation(tx, input.teamID, ["member.add"], now)
              return yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, id)).get()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`Inserted team member ${id} was not found`))
      return toMember(row)
    })

    const updateMemberStatus = Effect.fn("Team.updateMemberStatus")(function* (
      memberID: string,
      status: MemberStatus,
      resultOrUpdate?: string | TeamMemberStatusUpdate,
    ) {
      const now = Date.now()
      const update = typeof resultOrUpdate === "string" ? { result: resultOrUpdate } : resultOrUpdate
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get()
              if (!current) return { changed: false, row: undefined }
              const inferredOutcome =
                status === "completed"
                  ? ({ type: "succeeded", label: "completed", cause: null } as const)
                  : status === "cancelled"
                    ? current.daemon_state === "error" || update?.daemonState === "error"
                      ? ({ type: "failed", label: "failed", cause: "runtime_error" } as const)
                      : ({ type: "cancelled", label: "cancelled", cause: "cause_unknown" } as const)
                    : undefined
              const outcome = update?.outcome !== undefined ? update.outcome : inferredOutcome
              const displaySummary =
                update?.displaySummary === undefined
                  ? current.display_summary
                  : update.displaySummary === null
                    ? null
                    : summarize(update.displaySummary)
              const outcomeType = outcome === undefined ? current.outcome_type : outcome?.type ?? null
              const outcomeLabel = outcome === undefined ? current.outcome_label : outcome?.label ?? null
              const outcomeCause = outcome === undefined ? current.outcome_cause : outcome?.cause ?? null
              const terminal = outcomeType !== null
              const executionState = terminal ? "idle" : (update?.executionState ?? current.execution_state)
              const leaseOwnerID = terminal ? null : (update?.leaseOwnerID ?? current.lease_owner_id)
              const leaseExpiresAt = terminal ? null : (update?.leaseExpiresAt ?? current.lease_expires_at)
              const changed =
                current.status !== status ||
                (update?.result !== undefined && current.result !== update.result) ||
                (update?.daemonState !== undefined && current.daemon_state !== update.daemonState) ||
                (update?.daemonLastActive !== undefined && current.daemon_last_active !== update.daemonLastActive) ||
                (update?.daemonError !== undefined && current.daemon_error !== update.daemonError) ||
                current.display_summary !== displaySummary ||
                (update?.mutability !== undefined && current.mutability !== update.mutability) ||
                (update?.executionEpoch !== undefined && current.execution_epoch !== update.executionEpoch) ||
                current.execution_state !== executionState ||
                current.lease_owner_id !== leaseOwnerID ||
                current.lease_expires_at !== leaseExpiresAt ||
                (update?.currentWorkSource !== undefined &&
                  current.current_work_source !== update.currentWorkSource) ||
                (update?.currentWorkID !== undefined && current.current_work_id !== update.currentWorkID) ||
                (update?.workStartedAt !== undefined && current.work_started_at !== update.workStartedAt) ||
                current.outcome_type !== outcomeType ||
                current.outcome_label !== outcomeLabel ||
                current.outcome_cause !== outcomeCause
              if (!changed) return { changed: false, row: current }
              const setData: Partial<TeamMemberInsert> = {
                status,
                display_summary: displaySummary,
                execution_state: executionState,
                lease_owner_id: leaseOwnerID,
                lease_expires_at: leaseExpiresAt,
                outcome_type: outcomeType,
                outcome_label: outcomeLabel,
                outcome_cause: outcomeCause,
                outcome_at:
                  current.outcome_type === outcomeType && current.outcome_label === outcomeLabel
                    ? current.outcome_at
                    : terminal
                      ? now
                      : null,
                time_updated: now,
              }
              if (update?.result !== undefined) setData.result = update.result
              if (update?.daemonState !== undefined) setData.daemon_state = update.daemonState
              if (update?.daemonLastActive !== undefined) setData.daemon_last_active = update.daemonLastActive
              if (update?.daemonError !== undefined) setData.daemon_error = update.daemonError
              if (update?.mutability !== undefined) setData.mutability = update.mutability
              if (update?.executionEpoch !== undefined) setData.execution_epoch = update.executionEpoch
              if (update?.currentWorkSource !== undefined) setData.current_work_source = update.currentWorkSource
              if (update?.currentWorkID !== undefined) setData.current_work_id = update.currentWorkID
              if (update?.workStartedAt !== undefined) setData.work_started_at = update.workStartedAt
              yield* tx.update(TeamMemberTable).set(setData).where(eq(TeamMemberTable.id, memberID)).run()
              yield* recordMutation(tx, current.team_id, ["member.status"], now)
              const row = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get()
              return { changed: true, row }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      const row = result.row
      if (!row) return Option.none()
      if (!result.changed) return Option.some(toMember(row))
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

      return Option.some(toMember(row))
    })

    const approveMemberPlan = Effect.fn("Team.approveMemberPlan")(function* (memberID: string) {
      const now = Date.now()
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get()
              if (!current) return { changed: false, row: undefined }
              if (current.status === "active" && !current.plan_mode && current.work_mode === "implement")
                return { changed: false, row: current }
              yield* tx
                .update(TeamMemberTable)
                .set({ status: "active", plan_mode: false, work_mode: "implement", time_updated: now })
                .where(eq(TeamMemberTable.id, memberID))
                .run()
              yield* recordMutation(tx, current.team_id, ["plan.approved"], now)
              return {
                changed: true,
                row: yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get(),
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      const row = result.row
      if (!row) return Option.none()
      if (!result.changed) return Option.some(toMember(row))
      yield* events.publish(MemberUpdated, {
        memberID: row.id,
        sessionID: row.session_id,
        status: row.status,
        lifecycle: row.lifecycle,
        daemonState: row.daemon_state ?? undefined,
      })
      return Option.some(toMember(row))
    })

    const getMembers = Effect.fn("Team.getMembers")(function* (teamID: string) {
      return (yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)).map(toMember)
    })

    const getMemberBySession = Effect.fn("Team.getMemberBySession")(function* (sessionID: string) {
      const row = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      return Option.some(toMember(row))
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

    const getHistory = Effect.fn("Team.getHistory")(function* (sessionID: string) {
      const rows = yield* db
        .select({ team: TeamTable })
        .from(TeamTable)
        .leftJoin(TeamMemberTable, eq(TeamMemberTable.team_id, TeamTable.id))
        .where(or(eq(TeamTable.lead_session_id, sessionID), eq(TeamMemberTable.session_id, sessionID)))
        .orderBy(desc(TeamTable.time_created), desc(TeamTable.id))
        .all()
        .pipe(Effect.orDie)
      return [...new Map(rows.map((row) => [row.team.id, row.team])).values()]
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
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx
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
              yield* recordMutation(tx, input.teamID, ["task.create"], now)
              return yield* tx.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, id)).get()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`Inserted team task ${id} was not found`))
      return toTask(row)
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
      return Option.some(toTask(row))
    })

    const updateTask = Effect.fn("Team.updateTask")(function* (
      teamID: string,
      taskID: string,
      update: Partial<{ status: TaskStatus; assignee: string }>,
    ) {
      const resolved = yield* resolveTaskID(teamID, taskID)
      if (Option.isNone(resolved)) return Option.none()
      const now = Date.now()
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
              if (!current) return undefined
              const status = update.status ?? current.status
              const assignee = update.assignee ?? current.assignee
              if (status === current.status && assignee === current.assignee) return current
              yield* tx
                .update(TeamTaskTable)
                .set({
                  status,
                  assignee,
                  started_at: status === "in_progress" ? (current.started_at ?? now) : current.started_at,
                  completed_at:
                    status === "completed" || status === "cancelled"
                      ? (current.completed_at ?? now)
                      : current.completed_at,
                  time_updated: now,
                })
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .run()
              yield* recordMutation(tx, teamID, ["task.update"], now)
              return yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!row) return Option.none()
      return Option.some(toTask(row))
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
                .set({ status: "in_progress", assignee, started_at: current.started_at ?? now, time_updated: now })
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .run()
              yield* recordMutation(tx, teamID, ["task.claim"], now)
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
      return Option.some(toTask(result))
    })

    const getTasks = Effect.fn("Team.getTasks")(function* (teamID: string) {
      return (yield* db
        .select()
        .from(TeamTaskTable)
        .where(eq(TeamTaskTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)).map(toTask)
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
              yield* recordMutation(tx, input.teamID, ["message.send"], now)
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
              if (pending.length > 0) yield* recordMutation(tx, teamID, ["message.delivery"], now)
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
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select({ id: TeamMessageRecipientTable.id, teamID: TeamMessageRecipientTable.team_id })
                .from(TeamMessageRecipientTable)
                .where(
                  and(
                    eq(TeamMessageRecipientTable.message_id, messageID),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                    ...(recipientSession ? [eq(TeamMessageRecipientTable.recipient, recipientSession)] : []),
                  ),
                )
                .all()
              if (rows.length === 0) return
              yield* tx
                .update(TeamMessageRecipientTable)
                .set({ delivery_status: "delivered", time_updated: now })
                .where(
                  and(
                    eq(TeamMessageRecipientTable.message_id, messageID),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                    ...(recipientSession ? [eq(TeamMessageRecipientTable.recipient, recipientSession)] : []),
                  ),
                )
                .run()
              const pending = yield* tx
                .select({ id: TeamMessageRecipientTable.id })
                .from(TeamMessageRecipientTable)
                .where(
                  and(
                    eq(TeamMessageRecipientTable.message_id, messageID),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                  ),
                )
                .get()
              if (!pending) {
                yield* tx
                  .update(TeamMessageTable)
                  .set({ delivery_status: "delivered", time_updated: now })
                  .where(eq(TeamMessageTable.id, messageID))
                  .run()
              }
              const teamID = rows[0]?.teamID
              if (!teamID) return yield* Effect.die(new Error(`Message ${messageID} has no recipient team`))
              yield* recordMutation(tx, teamID, ["message.delivery"], now)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const listPendingRecipientDeliveries = Effect.fn("Team.listPendingRecipientDeliveries")(function* (input?: {
      teamID?: string
      recipientSessionID?: string
    }) {
      const conditions = [eq(TeamMessageRecipientTable.delivery_status, "pending")]
      if (input?.teamID) conditions.push(eq(TeamMessageRecipientTable.team_id, input.teamID))
      if (input?.recipientSessionID)
        conditions.push(eq(TeamMessageRecipientTable.recipient, input.recipientSessionID))
      const rows = yield* db
        .select({
          recipientID: TeamMessageRecipientTable.id,
          messageID: TeamMessageTable.id,
          teamID: TeamMessageTable.team_id,
          recipientSessionID: TeamMessageRecipientTable.recipient,
          sender: TeamMessageTable.sender,
          recipients: TeamMessageTable.recipients,
          body: TeamMessageTable.body,
          timeCreated: TeamMessageTable.time_created,
          timeUpdated: TeamMessageRecipientTable.time_updated,
        })
        .from(TeamMessageRecipientTable)
        .innerJoin(TeamMessageTable, eq(TeamMessageTable.id, TeamMessageRecipientTable.message_id))
        .where(and(...conditions))
        .orderBy(asc(TeamMessageTable.time_created), asc(TeamMessageTable.id), asc(TeamMessageRecipientTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ ...row, recipients: [...row.recipients] }))
    })

    const commitRecipientDelivery = Effect.fn("Team.commitRecipientDelivery")(function* (recipientID: string) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const delivery = yield* tx
                .select({
                  id: TeamMessageRecipientTable.id,
                  messageID: TeamMessageRecipientTable.message_id,
                  teamID: TeamMessageRecipientTable.team_id,
                })
                .from(TeamMessageRecipientTable)
                .where(
                  and(
                    eq(TeamMessageRecipientTable.id, recipientID),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                  ),
                )
                .get()
              if (!delivery) return false
              const now = Date.now()
              const changed = yield* tx
                .update(TeamMessageRecipientTable)
                .set({ delivery_status: "delivered", time_updated: now })
                .where(
                  and(
                    eq(TeamMessageRecipientTable.id, recipientID),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                  ),
                )
                .returning({ id: TeamMessageRecipientTable.id })
                .get()
              if (!changed) return false
              const remaining = yield* tx
                .select({ id: TeamMessageRecipientTable.id })
                .from(TeamMessageRecipientTable)
                .where(
                  and(
                    eq(TeamMessageRecipientTable.message_id, delivery.messageID),
                    eq(TeamMessageRecipientTable.delivery_status, "pending"),
                  ),
                )
                .get()
              if (!remaining) {
                yield* tx
                  .update(TeamMessageTable)
                  .set({ delivery_status: "delivered", time_updated: now })
                  .where(eq(TeamMessageTable.id, delivery.messageID))
                  .run()
              }
              const revision = yield* recordMutation(tx, delivery.teamID, ["message.delivery"], now)
              if (revision === undefined)
                return yield* Effect.die(new Error(`Recipient ${recipientID} references missing team ${delivery.teamID}`))
              return true
            }),
          { behavior: "immediate" },
        )
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
      get,
      shutdown,
      addMember,
      updateMemberStatus,
      approveMemberPlan,
      getMembers,
      getMemberBySession,
      getContext,
      getHistory,
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
      listPendingRecipientDeliveries,
      commitRecipientDelivery,
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

const summarize = (value: string) => {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= 160 ? normalized : normalized.slice(0, 160)
}

export * as Team from "./team"
