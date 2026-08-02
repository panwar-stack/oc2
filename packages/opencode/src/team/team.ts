import { Database } from "@oc2-ai/core/database/database"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import { Context, Effect, Layer, Schema, Option, Cause } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { eq, and, asc, desc, inArray, isNull, notInArray, sql } from "drizzle-orm"
import { Runner } from "@/effect/runner"
import { SessionPauseBlockerTable, SessionPauseCascadeTable } from "@oc2-ai/core/session/sql"
import { TeamFileOwnershipTable } from "@oc2-ai/core/team/ownership.sql"
import {
  TeamTable,
  TeamMemberTable,
  TeamTaskTable,
  TeamMessageTable,
  TeamMessageRecipientTable,
  TeamUsageEventTable,
} from "./team.sql"
import { TeamCreated, TeamClosed, MemberUpdated, MessageReceived } from "./events"
import { bumpTeamRevision } from "./revision"
import { TeamEval, type TeamEvalReport } from "./eval"
import { PendingMailbox } from "./pending-mailbox"
import {
  OwnedPathConflict,
  assertNoActivePathConflicts,
  buildReservationRows,
  toOwnedReservation,
  withReservationLocks,
  type OwnedPath,
  type OwnedReservation,
} from "./file-ownership"

const toOption = <T>(v: T | null | undefined): Option.Option<T> => (v != null ? Option.some(v) : Option.none())

/** Read the stored v1 structured handoff from task metadata, or null. */
const readTaskHandoff = (metadata: Record<string, unknown> | null | undefined): TaskHandoff | null => {
  const value = metadata?.["handoff"]
  return value && typeof value === "object" ? (value as TaskHandoff) : null
}

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

/** Structured v1 terminal handoff required to complete an owned task. */
export type TaskHandoff = {
  summary: string
  changed_paths: string[]
  verification: Array<{
    command: string
    status: "passed" | "failed" | "not_run"
    detail?: string
  }>
  risks?: string[]
}

export type Task = Omit<TeamTaskRow, "assignee" | "dependency_ids" | "metadata"> & {
  assignee: TeamTaskInsert["assignee"]
  dependency_ids: TeamTaskInsert["dependency_ids"]
  metadata: TeamTaskInsert["metadata"]
  /** Root-relative display paths of this task's reservation rows (active or released). */
  owned_paths: string[]
  /** Reservation summary rows for audit and listing. */
  reservations: OwnedReservation[]
  /** The structured v1 handoff stored on completion, when present. */
  handoff: TaskHandoff | null
}
export type Message = TeamMessageRow
export type MemberStatus = TeamMemberRow["status"]
export type MemberLifecycle = TeamMemberRow["lifecycle"]
export type MemberDaemonState = NonNullable<TeamMemberRow["daemon_state"]>
export type TaskStatus = TeamTaskRow["status"]

/** Stable failure codes for terminal failed members. Only provider_error and dependency_failed are
 * produced in this slice; the remaining codes arrive with later retry and handoff slices. */
export type MemberFailureCode = "empty_result" | "provider_error" | "dependency_failed" | "missing_task_handoff"

/** Durable run-phase of a finite member session, persisted with the session lifecycle metadata. */
export type MemberRunPhase = "running" | "retry_admitted" | "retry_running" | "terminal"

type TeamMemberStatusUpdate = {
  result?: string
  failureCode?: MemberFailureCode | null
  daemonState?: MemberDaemonState | null
  daemonLastActive?: number | null
  daemonError?: string | null
}

type MessageTx = Pick<Database.Interface["db"], "insert">

/** Insert a team message row and one recipient row per recipient inside an already-open
 * immediate transaction. Callers own the active-team check and the single revision bump. */
const insertMessageRows = (
  tx: MessageTx,
  input: { id: string; teamID: string; sender: string; recipients: string[]; body: string; now: number },
) =>
  Effect.gen(function* () {
    yield* tx
      .insert(TeamMessageTable)
      .values({
        id: input.id,
        team_id: input.teamID,
        sender: input.sender,
        recipients: input.recipients,
        body: input.body,
        delivery_status: "pending",
        time_created: input.now,
        time_updated: input.now,
      })
      .run()
    if (input.recipients.length > 0) {
      yield* tx
        .insert(TeamMessageRecipientTable)
        .values(
          input.recipients.map((recipient) => ({
            id: crypto.randomUUID(),
            message_id: input.id,
            team_id: input.teamID,
            recipient,
            delivery_status: "pending" as const,
            time_created: input.now,
            time_updated: input.now,
          })),
        )
        .run()
    }
  })

/** Canonical terminal lead notification, containing the result or failure reason. */
const terminalNotificationBody = (member: TeamMemberRow, status: MemberStatus, update?: TeamMemberStatusUpdate) => {
  const statusText =
    status === "completed" ? "completed their work" : status === "cancelled" ? "been cancelled" : "failed"
  const head = `Teammate ${member.name} (${member.agent_type}) has ${statusText}.`
  if (status === "completed" && update?.result) return `${head}\n\nResult:\n${update.result}`
  if (status === "cancelled") {
    const reason =
      typeof update?.result === "string" && update.result.trim() !== ""
        ? update.result
        : update?.failureCode
          ? `failure code ${update.failureCode}`
          : undefined
    return reason ? `${head}\n\nReason: ${reason}` : head
  }
  if (status === "failed" && (update?.result || update?.failureCode)) {
    return `${head}\n\nReason: ${update?.result ?? `failure code ${update.failureCode}`}`
  }
  return head
}

/** Publish a team event, logging instead of failing on a broken event bus so a committed
 * terminal transition or a wake can never be failed by an in-memory publish defect. */
const safePublish = (effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("team event publish failed", { cause })
      }),
    ),
  )

/** Expected conflict when a lead session already has an active team. The database
 * partial unique index `team_active_lead_session_idx` is the final race guard; this
 * typed error is produced both by the precheck and by a lost insert race. */
export class ActiveTeamConflict extends Schema.TaggedErrorClass<ActiveTeamConflict>()(
  "Team.ActiveTeamConflict",
  {
    leadSessionID: Schema.String,
    teamID: Schema.String,
  },
) {
  override get message() {
    return `Lead session ${this.leadSessionID} already has an active team (${this.teamID})`
  }
}

/** Stable rejection when a non-lead session attempts to shut a team down. */
export class ShutdownNotAuthorized extends Schema.TaggedErrorClass<ShutdownNotAuthorized>()(
  "Team.ShutdownNotAuthorized",
  { teamID: Schema.String },
) {
  override get message() {
    return `Only the team lead can shut down team ${this.teamID}.`
  }
}

/** Stable rejection when the team is not active (already closed or cancelled). */
export class ShutdownAlreadyClosed extends Schema.TaggedErrorClass<ShutdownAlreadyClosed>()(
  "Team.ShutdownAlreadyClosed",
  { teamID: Schema.String },
) {
  override get message() {
    return `Team ${this.teamID} is already closed.`
  }
}

/** Stable rejection for protocol-1 normal shutdown without a current final-report checkpoint. */
export class ShutdownFinalReportRequired extends Schema.TaggedErrorClass<ShutdownFinalReportRequired>()(
  "Team.ShutdownFinalReportRequired",
  {
    teamID: Schema.String,
    revision: Schema.Number,
    finalReportRevision: Schema.NullOr(Schema.Number),
  },
) {
  override get message() {
    return `Team ${this.teamID} requires a current final report before normal shutdown (revision ${this.revision}, final report covers ${
      this.finalReportRevision ?? "nothing"
    }). Run team_report({ final: true }) or force shutdown with a nonblank reason.`
  }
}

/** Stable rejection when a forced shutdown is requested without a nonblank reason. */
export class ShutdownReasonRequired extends Schema.TaggedErrorClass<ShutdownReasonRequired>()(
  "Team.ShutdownReasonRequired",
  { teamID: Schema.String },
) {
  override get message() {
    return `Forced shutdown requires a nonblank reason.`
  }
}

/** Stable rejection when a message targets a team that is not active. */
export class MessageToClosedTeam extends Schema.TaggedErrorClass<MessageToClosedTeam>()(
  "Team.MessageToClosedTeam",
  { teamID: Schema.String },
) {
  override get message() {
    return `Cannot send messages to team ${this.teamID}: the team is not active.`
  }
}

export type ShutdownResult = {
  /** Members transitioned from a nonterminal status to cancelled by this shutdown. */
  cancelledMembers: number
  /** Tasks transitioned from pending/in_progress to cancelled by this shutdown. */
  cancelledTasks: number
  /** Reservation rows released (time_released set) by this shutdown; rows are kept for audit. */
  releasedReservations: number
  /** Per-session run cancellation failures after commit; durable team state stays closed. */
  sessionCancellationFailures: number
}

export type ShutdownError =
  | ShutdownNotAuthorized
  | ShutdownAlreadyClosed
  | ShutdownFinalReportRequired
  | ShutdownReasonRequired

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
  create: (input: { name: string; goal: string; leadSessionID: string }) => Effect.Effect<Info, ActiveTeamConflict>
  getActive: (leadSessionID: string) => Effect.Effect<Option.Option<Info>>
  getByLeadSession: (leadSessionID: string) => Effect.Effect<Option.Option<Info>>
  get: (teamID: string) => Effect.Effect<Option.Option<Info>>
  /**
   * Shuts a team down. Lead-only: rejects unless the caller is the team's lead session.
   * Normal shutdown of a protocol-1 team requires the current final-report checkpoint
   * (`final_report_revision === revision`). `force: true` bypasses the checkpoint and
   * requires a nonblank `reason`; it records a `forced_shutdown` usage event. The close,
   * member cancellation, task cancellation, and reservation release happen in one immediate
   * transaction that does not bump the revision. Events and per-session run cancellation
   * happen only after commit.
   */
  shutdown: (input: {
    teamID: string
    sessionID: string
    force?: boolean
    reason?: string
  }) => Effect.Effect<ShutdownResult, ShutdownError>
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
    owned?: OwnedPath[]
  }) => Effect.Effect<Task, Error>
  getTask: (teamID: string, taskID: string) => Effect.Effect<Option.Option<Task>, Error>
  updateTask: (
    teamID: string,
    taskID: string,
    update: Partial<{
      status: TaskStatus
      assignee: string
      handoff: TaskHandoff
      /** Canonical pathKeys of `handoff.changed_paths`, validated against the task's reservations. */
      handoffPathKeys?: string[]
    }>,
    caller?: { sessionID: string; isLead: boolean },
  ) => Effect.Effect<Option.Option<Task>, Error>
  claimTask: (teamID: string, taskID: string, assignee: string) => Effect.Effect<Option.Option<Task>, Error>
  getTasks: (teamID: string) => Effect.Effect<Task[]>
  sendMessage: (input: {
    teamID: string
    sender: string
    recipients: string[]
    body: string
  }) => Effect.Effect<Message, MessageToClosedTeam>
  getMessages: (teamID: string) => Effect.Effect<Message[]>
  getPendingMessages: (recipientSession: string, teamID: string) => Effect.Effect<Message[]>
  /**
   * Non-destructive pending-mailbox probe. Reports whether the recipient has any mailbox rows
   * still in "pending" state without claiming them, so a paused session's mailbox stays
   * claimable exactly once after resume.
   */
  hasPendingMailboxMessages: (recipientSession: string) => Effect.Effect<boolean>
  claimPendingMessages: (
    recipientSession: string,
    teamID: string,
  ) => Effect.Effect<Message[], Runner.Suspended>
  releaseClaimedMessages: (messageIDs: readonly string[], recipientSession: string) => Effect.Effect<void>
  markMessageDelivered: (messageID: string, recipientSession?: string) => Effect.Effect<void>
  createUsageEvent: (input: {
    teamID: string
    sessionID?: string
    memberID?: string
    type: UsageEventType
    metadata?: Record<string, unknown>
  }) => Effect.Effect<UsageEvent>
  getUsageEvents: (teamID: string) => Effect.Effect<UsageEvent[]>
  /**
   * Builds the TeamEval report and captures the team revision at construction time. The returned
   * revision is the CAS anchor for `recordFinalReport`: any material mutation between the build and
   * the record makes the record fail (stale), so only a report that observed a stable state becomes
   * the final checkpoint.
   */
  buildFinalReport: (teamID: string) => Effect.Effect<{ report: TeamEvalReport; revision: number }, TeamEval.NotFoundError>
  /**
   * Records the final-report checkpoint. In one immediate transaction it compares the team status
   * (active) and the revision (unchanged since the build); on success it sets
   * `final_report_revision = revision` and inserts the `report_generated` event with metadata
   * `{ revision, final: true, stale: false }`. Returns true when the checkpoint was recorded and
   * false when the CAS failed (stale report). Never bumps the revision.
   */
  recordFinalReport: (input: {
    teamID: string
    revision: number
    sessionID?: string
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Team") {}

export { TeamEvents } from "./events"

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
        return yield* Effect.fail(
          new ActiveTeamConflict({ leadSessionID: input.leadSessionID, teamID: existing.id }),
        )
      }

      const id = crypto.randomUUID()
      const now = Date.now()
      // The partial unique index `team_active_lead_session_idx` is the final race guard.
      // A lost insert race surfaces through the database layer as an EffectDrizzleQueryError
      // whose cause chain holds a SqlError with a UniqueViolation reason; map that to the
      // same typed conflict (reading the winning team back for its ID) so two concurrent
      // creates yield exactly one success and one typed conflict, never a second row and
      // never a defect.
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
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) => {
            const cause = Cause.findErrorOption(error.cause as Cause.Cause<unknown>)
            const isUniqueViolation =
              Option.isSome(cause) && cause.value instanceof SqlError && cause.value.reason._tag === "UniqueViolation"
            if (!isUniqueViolation) return Effect.die(error)
            return Effect.gen(function* () {
              const winner = yield* db
                .select()
                .from(TeamTable)
                .where(and(eq(TeamTable.lead_session_id, input.leadSessionID), eq(TeamTable.status, "active")))
                .get()
                .pipe(Effect.orDie)
              if (!winner) return yield* Effect.die(error)
              return yield* Effect.fail(
                new ActiveTeamConflict({ leadSessionID: input.leadSessionID, teamID: winner.id }),
              )
            })
          }),
        )
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
        protocol_version: 0,
        revision: 0,
        final_report_revision: null,
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

    const shutdown = Effect.fn("Team.shutdown")(function* (input: {
      teamID: string
      sessionID: string
      force?: boolean
      reason?: string
    }) {
      const now = Date.now()
      const force = input.force === true
      // Forced shutdown is the explicit abort path for a wedged or abandoned team. It must
      // never become the normal completion path: it requires a nonblank reason and records a
      // deterministic forced_shutdown usage event inside the close transaction.
      if (force && (typeof input.reason !== "string" || input.reason.trim() === "")) {
        return yield* Effect.fail(new ShutdownReasonRequired({ teamID: input.teamID }))
      }
      // ONE immediate transaction: admission checks, close, member cancellation, task
      // cancellation, reservation release, and (for forced shutdown) the audit event. The
      // checked revision covers all pre-shutdown work; this transaction must NOT bump the
      // revision. Unread mailbox rows are never touched.
      const closed = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, input.teamID)).get()
              if (!team || team.status !== "active") {
                return yield* Effect.fail(new ShutdownAlreadyClosed({ teamID: input.teamID }))
              }
              if (team.lead_session_id !== input.sessionID) {
                return yield* Effect.fail(new ShutdownNotAuthorized({ teamID: input.teamID }))
              }
              // Protocol-1 gate: normal shutdown requires the final-report checkpoint to cover
              // the current revision. Protocol-0 teams skip this gate. Forced shutdown bypasses
              // it for a wedged or explicitly abandoned team.
              if (team.protocol_version === 1 && !force && team.final_report_revision !== team.revision) {
                return yield* Effect.fail(
                  new ShutdownFinalReportRequired({
                    teamID: input.teamID,
                    revision: team.revision,
                    finalReportRevision: team.final_report_revision,
                  }),
                )
              }
              yield* tx
                .update(TeamTable)
                .set({ status: "closed", time_updated: now })
                .where(eq(TeamTable.id, input.teamID))
                .run()
              const members = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.team_id, input.teamID))
                .all()
              const nonterminal = members.filter(
                (member) =>
                  member.status !== "completed" && member.status !== "cancelled" && member.status !== "failed",
              )
              yield* Effect.forEach(
                nonterminal,
                (member) =>
                  tx
                    .update(TeamMemberTable)
                    .set({
                      status: "cancelled",
                      time_updated: now,
                      ...(member.lifecycle === "daemon"
                        ? { daemon_state: "cancelled" as const, daemon_last_active: now }
                        : {}),
                    })
                    .where(eq(TeamMemberTable.id, member.id))
                    .run(),
                { concurrency: "unbounded", discard: true },
              )
              const pendingTasks = yield* tx
                .select({ id: TeamTaskTable.id })
                .from(TeamTaskTable)
                .where(
                  and(
                    eq(TeamTaskTable.team_id, input.teamID),
                    inArray(TeamTaskTable.status, ["pending", "in_progress"]),
                  ),
                )
                .all()
              yield* Effect.forEach(
                pendingTasks,
                (task) =>
                  tx
                    .update(TeamTaskTable)
                    .set({ status: "cancelled", time_updated: now })
                    .where(eq(TeamTaskTable.id, task.id))
                    .run(),
                { concurrency: "unbounded", discard: true },
              )
              // Release reservations of the tasks cancelled above. Rows are kept for audit; only
              // the release time is set, so a later owned task can re-reserve the path.
              let releasedReservations = 0
              if (pendingTasks.length > 0) {
                const released = yield* tx
                  .update(TeamFileOwnershipTable)
                  .set({ time_released: now, time_updated: now })
                  .where(
                    and(
                      eq(TeamFileOwnershipTable.team_id, input.teamID),
                      inArray(
                        TeamFileOwnershipTable.task_id,
                        pendingTasks.map((task) => task.id),
                      ),
                      isNull(TeamFileOwnershipTable.time_released),
                    ),
                  )
                  .returning({ id: TeamFileOwnershipTable.id })
                  .run()
                releasedReservations = released.length
              }
              if (force) {
                yield* tx
                  .insert(TeamUsageEventTable)
                  .values({
                    id: crypto.randomUUID(),
                    team_id: input.teamID,
                    session_id: input.sessionID,
                    member_id: null,
                    type: "forced_shutdown",
                    metadata: { reason: input.reason, force: true, forced_at: now },
                    time_created: now,
                  })
                  .run()
              }
              return { members, nonterminal, pendingTasks, releasedReservations }
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof ShutdownAlreadyClosed ||
            error instanceof ShutdownNotAuthorized ||
            error instanceof ShutdownFinalReportRequired
              ? Effect.fail(error)
              : Effect.die(error),
          ),
        )
      // AFTER commit only: publish member and team events, and cancel each cancelled member's
      // session run. Cancellation failures are collected as a stable count and never reopen the
      // durable closed team state.
      yield* Effect.forEach(
        closed.members,
        (member) =>
          events.publish(MemberUpdated, {
            memberID: member.id,
            sessionID: member.session_id,
            status:
              member.status === "completed" || member.status === "cancelled" || member.status === "failed"
                ? member.status
                : "cancelled",
            lifecycle: member.lifecycle,
            daemonState: member.lifecycle === "daemon" ? "cancelled" : (member.daemon_state ?? undefined),
          }),
        { concurrency: "unbounded", discard: true },
      )
      yield* events.publish(TeamClosed, { teamID: input.teamID })
      yield* events.publish(TuiEvent.ToastShow, {
        title: "Team Shut Down",
        message: "The team has been closed and all active members cancelled.",
        variant: "info",
        duration: 5000,
      })
      const cancelOutcomes = yield* Effect.forEach(
        closed.nonterminal,
        (member) =>
          runState.cancel(SessionID.make(member.session_id)).pipe(
            // Any per-session cancellation failure (typed or defect) is surfaced as a stable
            // count; it must never reopen the durable closed team state.
            Effect.matchCause({
              onFailure: () => 1,
              onSuccess: () => 0,
            }),
          ),
        { concurrency: "unbounded" },
      )
      const sessionCancellationFailures = cancelOutcomes.reduce((acc, value) => acc + value, 0)
      return {
        cancelledMembers: closed.nonterminal.length,
        cancelledTasks: closed.pendingTasks.length,
        releasedReservations: closed.releasedReservations,
        sessionCancellationFailures,
      } satisfies ShutdownResult
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
              yield* bumpTeamRevision(tx, input.teamID)
            }),
          { behavior: "immediate" },
        )
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
        failure_code: null,
        run_generation: 0,
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
      if (update?.failureCode !== undefined) setData.failure_code = update.failureCode
      if (update?.daemonState !== undefined) setData.daemon_state = update.daemonState
      if (update?.daemonLastActive !== undefined) setData.daemon_last_active = update.daemonLastActive
      if (update?.daemonError !== undefined) setData.daemon_error = update.daemonError

      const terminalStatuses: MemberStatus[] = ["completed", "cancelled", "failed"]
      const terminalTarget = terminalStatuses.includes(status)

      // A terminal status and its canonical lead notification persist in ONE immediate
      // transaction with ONE revision bump. Repeated terminal updates are idempotent: an
      // already-terminal member is a no-op (no write, no new notification, no bump).
      const outcome = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.id, memberID))
                .get()
              if (!member) return { found: false } as const
              const alreadyTerminal = terminalStatuses.includes(member.status)
              if (alreadyTerminal) return { found: true, wrote: false, messageID: undefined } as const
              yield* tx
                .update(TeamMemberTable)
                .set(setData)
                .where(eq(TeamMemberTable.id, memberID))
                .run()
              let messageID: string | undefined
              if (terminalTarget) {
                const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, member.team_id)).get()
                if (team) {
                  messageID = `team:member:${memberID}:terminal:${status}`
                  yield* insertMessageRows(tx, {
                    id: messageID,
                    teamID: member.team_id,
                    sender: member.session_id,
                    recipients: [team.lead_session_id],
                    body: terminalNotificationBody(member, status, update),
                    now,
                  })
                }
              }
              yield* bumpTeamRevision(tx, member.team_id)
              return { found: true, wrote: true, messageID } as const
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!outcome.found) return Option.none()
      // After commit: publish member and message events uninterruptibly so the commit -> publish
      // section cannot be interrupted mid-way.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(TeamMemberTable)
            .where(eq(TeamMemberTable.id, memberID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return Option.none()
          if (outcome.wrote) {
            yield* safePublish(
              events.publish(MemberUpdated, {
                memberID: row.id,
                sessionID: row.session_id,
                status: row.status,
                lifecycle: row.lifecycle,
                daemonState: row.daemon_state ?? undefined,
              }),
            )
            if (outcome.messageID) {
              yield* safePublish(
                events.publish(MessageReceived, {
                  messageID: outcome.messageID,
                  teamID: row.team_id,
                  sender: row.session_id,
                }),
              )
            }
          }
          // Daemon idle notifications are not terminal handoffs and keep their existing behavior:
          // the status transaction already committed and the notification persists separately.
          if (row.status === "idle") {
            const team = yield* db.select().from(TeamTable).where(eq(TeamTable.id, row.team_id)).get().pipe(Effect.orDie)
            if (team) {
              yield* sendMessage({
                teamID: row.team_id,
                sender: row.session_id,
                recipients: [team.lead_session_id],
                body: `Teammate ${row.name} (${row.agent_type}) has become idle.`,
              }).pipe(
                // A terminal transition racing a team close must not fail the status update: the
                // team is closed, so the automatic notification is moot.
                Effect.catchTag("Team.MessageToClosedTeam", () => Effect.void),
              )
              yield* safePublish(
                events.publish(TuiEvent.ToastShow, {
                  title: "Teammate Update",
                  message: `${row.name} (${row.agent_type}) has become idle.`,
                  variant: "info",
                  duration: 5000,
                }),
              )
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
            failure_code: row.failure_code,
            run_generation: row.run_generation,
            plan_mode: row.plan_mode,
            work_mode: row.work_mode,
            dependency_ids: row.dependency_ids,
            result: row.result,
            time_created: row.time_created,
            time_updated: row.time_updated,
          })
        }),
      )
    })

    const approveMemberPlan = Effect.fn("Team.approveMemberPlan")(function* (memberID: string) {
      const now = Date.now()
      const teamID = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get()
              if (!member) return Option.none<string>()
              yield* tx
                .update(TeamMemberTable)
                .set({ status: "active", plan_mode: false, work_mode: "implement", time_updated: now })
                .where(eq(TeamMemberTable.id, memberID))
                .run()
              yield* bumpTeamRevision(tx, member.team_id)
              return Option.some(member.team_id)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (Option.isNone(teamID)) return Option.none()
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
        failure_code: row.failure_code,
        run_generation: row.run_generation,
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
        failure_code: row.failure_code,
        run_generation: row.run_generation,
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
        failure_code: row.failure_code,
        run_generation: row.run_generation,
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
      owned?: OwnedPath[]
    }) {
      const dependencyIDs = yield* Effect.forEach(input.dependencyIDs ?? [], (dependencyID) =>
        Effect.gen(function* () {
          const resolved = yield* resolveTaskID(input.teamID, dependencyID)
          if (Option.isNone(resolved))
            return yield* Effect.fail(new Error(`Task dependency not found: ${dependencyID}`))
          return resolved.value
        }),
      )
      const owned = input.owned ?? []
      const id = crypto.randomUUID()
      const now = Date.now()
      // Owned tasks bind the owner at claim time from authoritative ctx.sessionID;
      // a free-form assignee is meaningless for them and must not be stored.
      const assignee = owned.length > 0 ? undefined : input.assignee

      if (owned.length === 0) {
        yield* db
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
                    assignee: assignee ?? null,
                    dependency_ids: dependencyIDs.length > 0 ? dependencyIDs : null,
                    metadata: input.metadata ?? null,
                    time_created: now,
                    time_updated: now,
                  })
                  .run()
                yield* bumpTeamRevision(tx, input.teamID)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        return {
          id,
          team_id: input.teamID,
          description: input.description,
          status: "pending",
          assignee: assignee,
          dependency_ids: dependencyIDs.length > 0 ? dependencyIDs : undefined,
          metadata: input.metadata,
          owned_paths: [],
          reservations: [],
          handoff: null,
          time_created: now,
          time_updated: now,
        } satisfies Task
      }

      // Owned task: insert the pending task and all reservation rows in one
      // immediate transaction. The sorted path locks are held from before the
      // conflict check through commit (matching the file tools' lease order);
      // any active-path conflict rolls back the entire operation and fails
      // with a stable error naming the conflicting file.
      return yield* withReservationLocks(
        owned.map((entry) => entry.pathKey),
        db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* assertNoActivePathConflicts(tx, owned)
              yield* tx
                .insert(TeamTaskTable)
                .values({
                  id,
                  team_id: input.teamID,
                  description: input.description,
                  status: "pending",
                  assignee: null,
                  dependency_ids: dependencyIDs.length > 0 ? dependencyIDs : null,
                  metadata: input.metadata ?? null,
                  time_created: now,
                  time_updated: now,
                })
                .run()
              yield* tx
                .insert(TeamFileOwnershipTable)
                .values(buildReservationRows({ id, teamID: input.teamID, taskID: id, owned, now }))
                .run()
              yield* bumpTeamRevision(tx, input.teamID)
              return {
                id,
                team_id: input.teamID,
                description: input.description,
                status: "pending",
                assignee: undefined,
                dependency_ids: dependencyIDs.length > 0 ? dependencyIDs : undefined,
                metadata: input.metadata,
                owned_paths: owned.map((entry) => entry.displayPath),
                reservations: owned.map((entry, index) => ({
                  id: `${id}-${index}`,
                  rootKey: entry.rootKey,
                  pathKey: entry.pathKey,
                  displayPath: entry.displayPath,
                  ownerSessionID: null,
                  timeReleased: null,
                })),
                handoff: null,
                time_created: now,
                time_updated: now,
              } satisfies Task
            }),
          { behavior: "immediate" },
        ),
      )
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) => {
            // The partial unique index is the final race guard; a lost insert
            // race surfaces here. Map it to the same stable conflict error.
            const cause = Cause.findErrorOption(error.cause as Cause.Cause<unknown>)
            const isUniqueViolation =
              Option.isSome(cause) && cause.value instanceof SqlError && cause.value.reason._tag === "UniqueViolation"
            if (!isUniqueViolation) return Effect.die(error)
            return Effect.fail(new OwnedPathConflict({ displayPath: owned[0]?.displayPath ?? "" }))
          }),
        )
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
      const reservations = yield* db
        .select()
        .from(TeamFileOwnershipTable)
        .where(
          and(
            eq(TeamFileOwnershipTable.team_id, teamID),
            eq(TeamFileOwnershipTable.task_id, resolved.value),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return Option.some({
        id: row.id,
        team_id: row.team_id,
        description: row.description,
        status: row.status,
        assignee: row.assignee,
        dependency_ids: row.dependency_ids,
        metadata: row.metadata,
        owned_paths: reservations.map((reservation) => reservation.display_path),
        reservations: reservations.map(toOwnedReservation),
        handoff: readTaskHandoff(row.metadata),
        time_created: row.time_created,
        time_updated: row.time_updated,
      })
    })

    const updateTask = Effect.fn("Team.updateTask")(function* (
      teamID: string,
      taskID: string,
      update: Partial<{
        status: TaskStatus
        assignee: string
        handoff: TaskHandoff
        handoffPathKeys?: string[]
      }>,
      caller?: { sessionID: string; isLead: boolean },
    ) {
      const resolved = yield* resolveTaskID(teamID, taskID)
      if (Option.isNone(resolved)) return Option.none()
      const now = Date.now()
      // Peek the task's reservation pathKeys so the owned-update transaction holds the same sorted
      // path locks the file tools use; release/cancellation must acquire them before changing
      // reservation state, and sorted acquisition keeps service and tool paths deadlock-free.
      const reservedRows = yield* db
        .select({ pathKey: TeamFileOwnershipTable.path_key })
        .from(TeamFileOwnershipTable)
        .where(and(eq(TeamFileOwnershipTable.team_id, teamID), eq(TeamFileOwnershipTable.task_id, resolved.value)))
        .all()
        .pipe(Effect.orDie)
      const reservedPathKeys = reservedRows.map((row) => row.pathKey)
      const result = yield* withReservationLocks(
        reservedPathKeys,
        db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
              if (!current) return null
              const reservations = yield* tx
                .select()
                .from(TeamFileOwnershipTable)
                .where(
                  and(
                    eq(TeamFileOwnershipTable.team_id, teamID),
                    eq(TeamFileOwnershipTable.task_id, resolved.value),
                  ),
                )
                .all()
              const isOwned = reservations.length > 0
              const setData: Partial<TeamTaskInsert> = { time_updated: now }
              let material = false

              if (isOwned) {
                // Owned-task invariants live here, not only in the tool wrapper.
                if (!caller)
                  return yield* Effect.fail(new Error("Caller identity is required to update an owned task."))
                const ownerSessionID = reservations[0]?.owner_session_id ?? null
                if (update.assignee !== undefined) {
                  return yield* Effect.fail(
                    new Error("Cannot reassign an owned task. Cancel it and create a replacement."),
                  )
                }
                if (update.status !== undefined) {
                  const target = update.status
                  if (target === "completed") {
                    if (current.status === "pending") {
                      return yield* Effect.fail(
                        new Error("An owned task cannot transition directly from pending to completed."),
                      )
                    }
                    if (current.status !== "in_progress") {
                      return yield* Effect.fail(new Error(`Cannot complete a ${current.status} owned task.`))
                    }
                    if (ownerSessionID !== caller.sessionID) {
                      return yield* Effect.fail(new Error("Only the task owner can complete this task."))
                    }
                    // PR 6: completion requires a nonblank structured handoff whose canonical
                    // changed pathKeys are a subset of this task's reserved pathKeys.
                    if (!update.handoff) {
                      return yield* Effect.fail(
                        new Error(
                          "Completing an owned task requires a structured handoff with a nonblank summary.",
                        ),
                      )
                    }
                    if (typeof update.handoff.summary !== "string" || update.handoff.summary.trim() === "") {
                      return yield* Effect.fail(
                        new Error("Owned-task completion requires a nonblank handoff summary."),
                      )
                    }
                    if (
                      !Array.isArray(update.handoff.verification) ||
                      !update.handoff.verification.every(
                        (entry) =>
                          entry &&
                          typeof entry.command === "string" &&
                          ["passed", "failed", "not_run"].includes(entry.status),
                      )
                    ) {
                      return yield* Effect.fail(
                        new Error(
                          "Owned-task completion requires verification entries with a valid status.",
                        ),
                      )
                    }
                    const reservedKeySet = new Set(reservations.map((reservation) => reservation.path_key))
                    for (const pathKey of update.handoffPathKeys ?? []) {
                      if (!reservedKeySet.has(pathKey)) {
                        return yield* Effect.fail(
                          new Error("Handoff changed path is not reserved by this task."),
                        )
                      }
                    }
                    setData.status = "completed"
                    // Store the v1 terminal handoff with the completion in the same transaction.
                    const nextMetadata = { ...(current.metadata ?? {}), handoff: update.handoff }
                    setData.metadata = nextMetadata
                    material = true
                  } else if (target === "cancelled") {
                    if (current.status === "completed" || current.status === "cancelled") {
                      return yield* Effect.fail(new Error(`Cannot cancel a ${current.status} owned task.`))
                    }
                    if (!caller.isLead && ownerSessionID !== caller.sessionID) {
                      return yield* Effect.fail(new Error("Only the task owner or the lead can cancel this task."))
                    }
                    setData.status = "cancelled"
                    material = true
                  } else if (target === "in_progress") {
                    return yield* Effect.fail(
                      new Error("Only team_task_claim may start an owned task."),
                    )
                  } else {
                    return yield* Effect.fail(new Error(`Invalid transition to ${target} for an owned task.`))
                  }
                }
                yield* tx
                  .update(TeamTaskTable)
                  .set(setData)
                  .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                  .run()
                // On completion or cancellation release all reservations in the
                // same transaction. Rows are kept for audit.
                if (setData.status === "completed" || setData.status === "cancelled") {
                  yield* tx
                    .update(TeamFileOwnershipTable)
                    .set({ time_released: now, time_updated: now })
                    .where(
                      and(
                        eq(TeamFileOwnershipTable.team_id, teamID),
                        eq(TeamFileOwnershipTable.task_id, resolved.value),
                        isNull(TeamFileOwnershipTable.time_released),
                      ),
                    )
                    .run()
                }
              } else {
                if (update.status !== undefined) {
                  setData.status = update.status
                  material = true
                }
                if (update.assignee !== undefined) {
                  setData.assignee = update.assignee
                  material = true
                }
                yield* tx
                  .update(TeamTaskTable)
                  .set(setData)
                  .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                  .run()
              }

              if (material) yield* bumpTeamRevision(tx, teamID)

              const row = yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
              const updatedReservations = yield* tx
                .select()
                .from(TeamFileOwnershipTable)
                .where(
                  and(
                    eq(TeamFileOwnershipTable.team_id, teamID),
                    eq(TeamFileOwnershipTable.task_id, resolved.value),
                  ),
                )
                .all()
              if (!row) return null
              return {
                row,
                reservations: updatedReservations,
              }
            }),
          { behavior: "immediate" },
        ),
      ).pipe(
        // Expected validation failures are Error instances; only database
        // query failures should become defects.
        Effect.catchIf(
          (error): error is Error => !(error instanceof Error),
          (error) => Effect.die(error),
        ),
      )
      if (!result) return Option.none()
      return Option.some({
        id: result.row.id,
        team_id: result.row.team_id,
        description: result.row.description,
        status: result.row.status,
        assignee: result.row.assignee,
        dependency_ids: result.row.dependency_ids,
        metadata: result.row.metadata,
        owned_paths: result.reservations.map((reservation) => reservation.display_path),
        reservations: result.reservations.map(toOwnedReservation),
        handoff: readTaskHandoff(result.row.metadata),
        time_created: result.row.time_created,
        time_updated: result.row.time_updated,
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
              // Owned tasks bind every reservation to the claiming session in
              // the same transaction. Reject if any reservation is already
              // owned by a different session.
              const reservations = yield* tx
                .select()
                .from(TeamFileOwnershipTable)
                .where(
                  and(
                    eq(TeamFileOwnershipTable.team_id, teamID),
                    eq(TeamFileOwnershipTable.task_id, resolved.value),
                  ),
                )
                .all()
              if (reservations.length > 0) {
                const foreignOwner = reservations.find(
                  (reservation) =>
                    reservation.owner_session_id !== null && reservation.owner_session_id !== assignee,
                )
                if (foreignOwner) return null
                yield* tx
                  .update(TeamFileOwnershipTable)
                  .set({ owner_session_id: assignee, time_updated: now })
                  .where(
                    and(
                      eq(TeamFileOwnershipTable.team_id, teamID),
                      eq(TeamFileOwnershipTable.task_id, resolved.value),
                      isNull(TeamFileOwnershipTable.time_released),
                    ),
                  )
                  .run()
              }
              yield* tx
                .update(TeamTaskTable)
                .set({ status: "in_progress", assignee, time_updated: now })
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .run()
              yield* bumpTeamRevision(tx, teamID)
              const row = yield* tx
                .select()
                .from(TeamTaskTable)
                .where(and(eq(TeamTaskTable.team_id, teamID), eq(TeamTaskTable.id, resolved.value)))
                .get()
              const updatedReservations = yield* tx
                .select()
                .from(TeamFileOwnershipTable)
                .where(
                  and(
                    eq(TeamFileOwnershipTable.team_id, teamID),
                    eq(TeamFileOwnershipTable.task_id, resolved.value),
                  ),
                )
                .all()
              return row ? { row, reservations: updatedReservations } : null
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!result) return Option.none()
      return Option.some({
        id: result.row.id,
        team_id: result.row.team_id,
        description: result.row.description,
        status: result.row.status,
        assignee: result.row.assignee,
        dependency_ids: result.row.dependency_ids,
        metadata: result.row.metadata,
        owned_paths: result.reservations.map((reservation) => reservation.display_path),
        reservations: result.reservations.map(toOwnedReservation),
        handoff: readTaskHandoff(result.row.metadata),
        time_created: result.row.time_created,
        time_updated: result.row.time_updated,
      })
    })

    const getTasks = Effect.fn("Team.getTasks")(function* (teamID: string) {
      const rows = yield* db
        .select()
        .from(TeamTaskTable)
        .where(eq(TeamTaskTable.team_id, teamID))
        .orderBy(asc(TeamTaskTable.time_created), asc(TeamTaskTable.id))
        .all()
        .pipe(Effect.orDie)
      const reservations = yield* db
        .select()
        .from(TeamFileOwnershipTable)
        .where(eq(TeamFileOwnershipTable.team_id, teamID))
        .all()
        .pipe(Effect.orDie)
      const byTask = new Map<string, typeof TeamFileOwnershipTable.$inferSelect[]>()
      for (const reservation of reservations) {
        const list = byTask.get(reservation.task_id) ?? []
        list.push(reservation)
        byTask.set(reservation.task_id, list)
      }
      return rows.map((row) => {
        const taskReservations = byTask.get(row.id) ?? []
        return {
          id: row.id,
          team_id: row.team_id,
          description: row.description,
          status: row.status,
          assignee: row.assignee,
          dependency_ids: row.dependency_ids,
          metadata: row.metadata,
          owned_paths: taskReservations.map((reservation) => reservation.display_path),
          reservations: taskReservations.map(toOwnedReservation),
          handoff: readTaskHandoff(row.metadata),
          time_created: row.time_created,
          time_updated: row.time_updated,
        }
      })
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
      // Reject messages to a closed or cancelled team in the same immediate transaction as the
      // insert, so no message or recipient rows are ever created for a non-active team.
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, input.teamID)).get()
              if (!team || team.status !== "active") {
                return yield* Effect.fail(new MessageToClosedTeam({ teamID: input.teamID }))
              }
              yield* insertMessageRows(tx, {
                id,
                teamID: input.teamID,
                sender: input.sender,
                recipients,
                body: input.body,
                now,
              })
              yield* bumpTeamRevision(tx, input.teamID)
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof MessageToClosedTeam ? Effect.fail(error) : Effect.die(error),
          ),
        )
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

    const hasPendingMailboxMessages = Effect.fn("Team.hasPendingMailboxMessages")((recipientSession: string) =>
      PendingMailbox.hasPendingMailboxMessages(db, recipientSession),
    )

    const claimPendingMessages = Effect.fn("Team.claimPendingMessages")(function* (
      recipientSession: string,
      teamID: string,
    ) {
      const now = Date.now()
      const rows = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const blocker = yield* tx
                .select({ cascadeID: SessionPauseCascadeTable.id })
                .from(SessionPauseBlockerTable)
                .innerJoin(
                  SessionPauseCascadeTable,
                  eq(SessionPauseCascadeTable.id, SessionPauseBlockerTable.cascade_id),
                )
                .where(
                  and(
                    eq(SessionPauseBlockerTable.session_id, SessionID.make(recipientSession)),
                    isNull(SessionPauseCascadeTable.time_released),
                  ),
                )
                .get()
              if (blocker) return yield* new Runner.Suspended()
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
              if (pending.length > 0) {
                yield* tx
                  .update(TeamMessageRecipientTable)
                  .set({ delivery_status: "read", time_updated: now })
                  .where(
                    and(
                      inArray(
                        TeamMessageRecipientTable.id,
                        pending.map((row) => row.recipient_id),
                      ),
                      eq(TeamMessageRecipientTable.delivery_status, "pending"),
                    ),
                  )
                  .run()
              }
              return pending
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof Runner.Suspended ? Effect.fail(error) : Effect.die(error),
          ),
        )
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

    const releaseClaimedMessages = Effect.fn("Team.releaseClaimedMessages")(function* (
      messageIDs: readonly string[],
      recipientSession: string,
    ) {
      if (messageIDs.length === 0) return
      yield* db
        .update(TeamMessageRecipientTable)
        .set({ delivery_status: "pending", time_updated: Date.now() })
        .where(
          and(
            inArray(TeamMessageRecipientTable.message_id, messageIDs),
            eq(TeamMessageRecipientTable.recipient, recipientSession),
            eq(TeamMessageRecipientTable.delivery_status, "read"),
          ),
        )
        .run()
        .pipe(Effect.orDie)
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
            notInArray(TeamMessageRecipientTable.delivery_status, ["delivered"]),
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

    const buildFinalReport = Effect.fn("Team.buildFinalReport")(function* (teamID: string) {
      const row = yield* db.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get().pipe(Effect.orDie)
      if (!row) return yield* new TeamEval.NotFoundError({ teamID })
      const report = yield* TeamEval.build(teamID).pipe(Effect.provideService(Database.Service, { db }))
      return { report, revision: row.revision }
    })

    const recordFinalReport = Effect.fn("Team.recordFinalReport")(function* (input: {
      teamID: string
      revision: number
      sessionID?: string
    }) {
      const now = Date.now()
      const eventID = crypto.randomUUID()
      const recorded = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, input.teamID)).get()
              if (!row || row.status !== "active" || row.revision !== input.revision) return false
              yield* tx
                .update(TeamTable)
                .set({ final_report_revision: input.revision, time_updated: now })
                .where(eq(TeamTable.id, input.teamID))
                .run()
              yield* tx
                .insert(TeamUsageEventTable)
                .values({
                  id: eventID,
                  team_id: input.teamID,
                  session_id: input.sessionID ?? null,
                  member_id: null,
                  type: "report_generated",
                  metadata: { revision: input.revision, final: true, stale: false, generated_at: now },
                  time_created: now,
                })
                .run()
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return recorded
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
      hasPendingMailboxMessages,
      claimPendingMessages,
      releaseClaimedMessages,
      markMessageDelivered,
      createUsageEvent,
      getUsageEvents,
      buildFinalReport,
      recordFinalReport,
    })
  }).pipe(Effect.withSpan("Team.layer")),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionRunState.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export * as Team from "./team"
