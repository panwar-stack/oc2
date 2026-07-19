import { Database } from "@oc2-ai/core/database/database"
import { NonNegativeInt } from "@oc2-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import { recordMutation } from "./board-outbox"
import {
  TeamAttentionTable,
  TeamMemberTable,
  TeamMessageTable,
  TeamMessageRecipientTable,
  TeamPlanReviewTable,
  TeamTable,
  TeamTaskTable,
} from "./team.sql"
import { TeamLease } from "./lease"

const TeamStatus = Schema.Literals(["active", "closed", "cancelled"])
const ViewerRole = Schema.Literals(["lead", "member"])
const WorkerState = Schema.Literals(["working", "blocked", "needs_you", "idle", "completed", "errored"])
const Lifecycle = Schema.Literals(["task", "daemon"])
const WorkMode = Schema.Literals(["plan", "implement"])
const Mutability = Schema.Literals(["read_only", "write_allowed", "unknown"])
const TaskStatus = Schema.Literals(["pending", "in_progress", "completed", "cancelled"])

class BoardTeam extends Schema.Class<BoardTeam>("TeamBoardTeam")({
  id: Schema.String,
  name: Schema.String,
  goal: Schema.String,
  lead_session_id: Schema.String,
  status: TeamStatus,
}) {}

class BoardViewer extends Schema.Class<BoardViewer>("TeamBoardViewer")({
  session_id: Schema.String,
  role: ViewerRole,
}) {}

class BoardCounts extends Schema.Class<BoardCounts>("TeamBoardCounts")({
  workers: NonNegativeInt,
  working: NonNegativeInt,
  blocked: NonNegativeInt,
  idle: NonNegativeInt,
  done: NonNegativeInt,
  errored: NonNegativeInt,
  cancelled: NonNegativeInt,
  needs_you: NonNegativeInt,
  unread: NonNegativeInt,
  claimed: NonNegativeInt,
  total_tasks: NonNegativeInt,
}) {}

class CurrentWork extends Schema.Class<CurrentWork>("TeamBoardCurrentWork")({
  source: Schema.Literals(["task", "assignment"]),
  id: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(NonNegativeInt),
}) {}

class PlanReview extends Schema.Class<PlanReview>("TeamBoardPlanReview")({
  review_id: Schema.String,
  state: Schema.Literals(["drafting", "submitted", "approved", "rejected"]),
}) {}

class Attention extends Schema.Class<Attention>("TeamBoardWorkerAttention")({
  plan: Schema.NullOr(PlanReview),
  permissions: NonNegativeInt,
  questions: NonNegativeInt,
}) {}

class Outcome extends Schema.Class<Outcome>("TeamBoardOutcome")({
  type: Schema.Literals(["succeeded", "failed", "cancelled", "interrupted"]),
  label: Schema.Literals(["completed", "failed", "cancelled", "interrupted"]),
}) {}

class Worker extends Schema.Class<Worker>("TeamBoardWorker")({
  member_id: Schema.String,
  session_id: Schema.String,
  name: Schema.String,
  agent_type: Schema.String,
  role: Schema.NullOr(Schema.String),
  state: WorkerState,
  lifecycle: Lifecycle,
  work_mode: WorkMode,
  mutability: Mutability,
  display_summary: Schema.NullOr(Schema.String),
  current_work: Schema.NullOr(CurrentWork),
  elapsed_ms: Schema.NullOr(NonNegativeInt),
  mailbox: Schema.Struct({ unread: NonNegativeInt }),
  attention: Attention,
  dependency_ids: Schema.Array(Schema.String),
  outcome: Schema.NullOr(Outcome),
  result_persisted: Schema.Boolean,
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
}) {}

class Task extends Schema.Class<Task>("TeamBoardTask")({
  id: Schema.String,
  description: Schema.String,
  status: TaskStatus,
  assignee: Schema.NullOr(Schema.String),
  dependency_ids: Schema.Array(Schema.String),
  started_at: Schema.NullOr(NonNegativeInt),
  completed_at: Schema.NullOr(NonNegativeInt),
}) {}

class Dependency extends Schema.Class<Dependency>("TeamBoardDependency")({
  id: Schema.String,
  kind: Schema.Literals(["member", "task"]),
  from_id: Schema.String,
  to_id: Schema.String,
  label: Schema.Literal("waits_on"),
  satisfied: Schema.Boolean,
}) {}

class AttentionItem extends Schema.Class<AttentionItem>("TeamBoardAttentionItem")({
  id: Schema.String,
  member_id: Schema.String,
  kind: Schema.Literals(["plan", "permission", "question"]),
  actionable: Schema.Boolean,
  detail_id: Schema.String,
}) {}

export class Snapshot extends Schema.Class<Snapshot>("TeamBoard")({
  team: BoardTeam,
  viewer: BoardViewer,
  revision: NonNegativeInt,
  generated_at: NonNegativeInt,
  counts: BoardCounts,
  workers: Schema.Array(Worker),
  tasks: Schema.Array(Task),
  dependencies: Schema.Array(Dependency),
  attention_items: Schema.Array(AttentionItem),
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TeamBoard.NotFoundError", {
  teamID: Schema.String,
}) {}

export class InvalidViewerError extends Schema.TaggedErrorClass<InvalidViewerError>()("TeamBoard.InvalidViewerError", {
  teamID: Schema.String,
  viewerSessionID: Schema.String,
}) {}

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()("TeamBoard.InvalidCursorError", {}) {}

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "TeamBoard.RevisionConflictError",
  { expectedRevision: Schema.Number, currentRevision: Schema.Number },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "TeamBoard.MessageNotFoundError",
  { messageID: Schema.String },
) {}

export class MessageStateConflictError extends Schema.TaggedErrorClass<MessageStateConflictError>()(
  "TeamBoard.MessageStateConflictError",
  { messageID: Schema.String, state: Schema.String },
) {}

export class MailboxMessage extends Schema.Class<MailboxMessage>("TeamBoardMailboxMessage")({
  id: Schema.String,
  sender: Schema.String,
  body: Schema.String,
  delivery_status: Schema.Literals(["pending", "delivered", "read"]),
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
}) {}

export class MailboxPage extends Schema.Class<MailboxPage>("TeamBoardMailboxPage")({
  items: Schema.Array(MailboxMessage),
  next_cursor: Schema.NullOr(Schema.String),
  revision: NonNegativeInt,
}) {}

export class MarkReadResult extends Schema.Class<MarkReadResult>("TeamBoardMarkReadResult")({
  changed: Schema.Boolean,
  revision: NonNegativeInt,
}) {}

export interface Interface {
  readSnapshot: (
    teamID: string,
    viewerSessionID: string,
  ) => Effect.Effect<Snapshot, NotFoundError | InvalidViewerError>
  readMailbox: (input: {
    teamID: string
    viewerSessionID: string
    cursor?: string
    limit?: number
  }) => Effect.Effect<MailboxPage, NotFoundError | InvalidViewerError | InvalidCursorError>
  markMessagesRead: (input: {
    teamID: string
    viewerSessionID: string
    messageIDs: string[]
    expectedRevision: number
  }) => Effect.Effect<
    MarkReadResult,
    | NotFoundError
    | InvalidViewerError
    | MessageNotFoundError
    | MessageStateConflictError
    | RevisionConflictError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamBoard") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const leases = yield* TeamLease.Service

    const readSnapshot = Effect.fn("TeamBoard.readSnapshot")(function* (teamID: string, viewerSessionID: string) {
      yield* leases.reconcile()
      const generatedAt = Date.now()
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* tx
              .select({
                id: TeamTable.id,
                name: TeamTable.name,
                goal: TeamTable.goal,
                lead_session_id: TeamTable.lead_session_id,
                status: TeamTable.status,
                board_revision: TeamTable.board_revision,
              })
              .from(TeamTable)
              .where(eq(TeamTable.id, teamID))
              .get()
            if (!team) return yield* new NotFoundError({ teamID })

            const members = yield* tx
              .select({
                id: TeamMemberTable.id,
                session_id: TeamMemberTable.session_id,
                name: TeamMemberTable.name,
                agent_type: TeamMemberTable.agent_type,
                role: TeamMemberTable.role,
                display_summary: TeamMemberTable.display_summary,
                mutability: TeamMemberTable.mutability,
                status: TeamMemberTable.status,
                lifecycle: TeamMemberTable.lifecycle,
                daemon_state: TeamMemberTable.daemon_state,
                work_mode: TeamMemberTable.work_mode,
                current_work_source: TeamMemberTable.current_work_source,
                current_work_id: TeamMemberTable.current_work_id,
                work_started_at: TeamMemberTable.work_started_at,
                execution_state: TeamMemberTable.execution_state,
                lease_owner_id: TeamMemberTable.lease_owner_id,
                lease_expires_at: TeamMemberTable.lease_expires_at,
                outcome_type: TeamMemberTable.outcome_type,
                outcome_label: TeamMemberTable.outcome_label,
                outcome_at: TeamMemberTable.outcome_at,
                dependency_ids: TeamMemberTable.dependency_ids,
                result_persisted: sql<boolean>`${TeamMemberTable.result} IS NOT NULL AND length(${TeamMemberTable.result}) > 0`,
                time_created: TeamMemberTable.time_created,
                time_updated: TeamMemberTable.time_updated,
              })
              .from(TeamMemberTable)
              .where(eq(TeamMemberTable.team_id, teamID))
              .orderBy(asc(TeamMemberTable.time_created), asc(TeamMemberTable.id))
              .all()
            const viewerRole =
              team.lead_session_id === viewerSessionID
                ? ("lead" as const)
                : members.some((member) => member.session_id === viewerSessionID)
                  ? ("member" as const)
                  : undefined
            if (!viewerRole) return yield* new InvalidViewerError({ teamID, viewerSessionID })

            const storedTasks = yield* tx
              .select({
                id: TeamTaskTable.id,
                description: TeamTaskTable.description,
                status: TeamTaskTable.status,
                assignee: TeamTaskTable.assignee,
                dependency_ids: TeamTaskTable.dependency_ids,
                time_created: TeamTaskTable.time_created,
                time_updated: TeamTaskTable.time_updated,
                started_at: TeamTaskTable.started_at,
                completed_at: TeamTaskTable.completed_at,
              })
              .from(TeamTaskTable)
              .where(eq(TeamTaskTable.team_id, teamID))
              .orderBy(asc(TeamTaskTable.time_created), asc(TeamTaskTable.id))
              .all()
            const recipients = yield* tx
              .select({
                recipient: TeamMessageRecipientTable.recipient,
                delivery_status: TeamMessageRecipientTable.delivery_status,
                time_updated: TeamMessageRecipientTable.time_updated,
              })
              .from(TeamMessageRecipientTable)
              .where(eq(TeamMessageRecipientTable.team_id, teamID))
              .all()
            const reviews = yield* tx
              .select({
                id: TeamPlanReviewTable.id,
                member_id: TeamPlanReviewTable.member_id,
                state: TeamPlanReviewTable.state,
                time_created: TeamPlanReviewTable.time_created,
              })
              .from(TeamPlanReviewTable)
              .where(eq(TeamPlanReviewTable.team_id, teamID))
              .orderBy(asc(TeamPlanReviewTable.time_created), asc(TeamPlanReviewTable.id))
              .all()
            const storedAttention = yield* tx
              .select({
                id: TeamAttentionTable.id,
                member_id: TeamAttentionTable.member_id,
                kind: TeamAttentionTable.kind,
                detail_id: TeamAttentionTable.detail_id,
              })
              .from(TeamAttentionTable)
              .where(and(eq(TeamAttentionTable.team_id, teamID), eq(TeamAttentionTable.state, "open")))
              .orderBy(asc(TeamAttentionTable.time_created), asc(TeamAttentionTable.id))
              .all()

            const names = new Map<string, typeof members>()
            for (const member of members) names.set(member.name, [...(names.get(member.name) ?? []), member])
            const resolveMember = (selector: string | null) => {
              if (selector === null) return undefined
              const exact = members.find((member) => member.id === selector || member.session_id === selector)
              if (exact) return exact
              const named = names.get(selector)
              return named?.length === 1 ? named[0] : undefined
            }
            const resolvedTasks = storedTasks.map((task) => ({
              ...task,
              member: resolveMember(task.assignee),
              dependency_ids: [...new Set(task.dependency_ids ?? [])],
            }))
            const latestReviews = new Map<string, (typeof reviews)[number]>()
            for (const review of reviews) latestReviews.set(review.member_id, review)
            const attentionByMember = new Map<string, typeof storedAttention>()
            for (const item of storedAttention)
              attentionByMember.set(item.member_id, [...(attentionByMember.get(item.member_id) ?? []), item])
            const stateOf = (member: (typeof members)[number]) => {
              const attention = attentionByMember.get(member.id) ?? []
              if (latestReviews.get(member.id)?.state === "submitted" || attention.length > 0)
                return "needs_you" as const
              if (member.outcome_type === "failed" || member.daemon_state === "error") return "errored" as const
              if (
                member.status === "active" &&
                (member.execution_state === "starting" ||
                  member.execution_state === "busy" ||
                  member.execution_state === "retry") &&
                member.lease_owner_id !== null &&
                member.lease_expires_at !== null &&
                member.lease_expires_at > generatedAt
              )
                return "working" as const
              if (member.status === "blocked") return "blocked" as const
              if (member.outcome_type !== null || member.status === "completed" || member.status === "cancelled")
                return "completed" as const
              return "idle" as const
            }
            const priority = { needs_you: 0, errored: 1, working: 2, blocked: 3, idle: 4, completed: 5 }
            const workers = members
              .map((member) => {
                const current = resolvedTasks.find(
                  (task) => task.status === "in_progress" && task.member?.id === member.id,
                )
                const review = latestReviews.get(member.id)
                const attention = attentionByMember.get(member.id) ?? []
                const currentWork = member.current_work_source
                  ? new CurrentWork({
                      source: member.current_work_source,
                      id: member.current_work_id,
                      started_at: member.work_started_at,
                    })
                  : current
                    ? new CurrentWork({ source: "task", id: current.id, started_at: current.started_at })
                    : null
                const startedAt = currentWork?.started_at ?? member.work_started_at
                return new Worker({
                  member_id: member.id,
                  session_id: member.session_id,
                  name: member.name,
                  agent_type: member.agent_type,
                  role: member.role,
                  state: stateOf(member),
                  lifecycle: member.lifecycle,
                  work_mode: member.work_mode,
                  mutability: member.mutability,
                  display_summary: member.display_summary ?? (current ? summarize(current.description) : null),
                  current_work: currentWork,
                  elapsed_ms:
                    startedAt === null ? null : Math.max(0, (member.outcome_at ?? generatedAt) - startedAt),
                  mailbox: {
                    unread: recipients.filter(
                      (recipient) =>
                        recipient.recipient === member.session_id && recipient.delivery_status === "delivered",
                    ).length,
                  },
                  attention: new Attention({
                    plan: review ? new PlanReview({ review_id: review.id, state: review.state }) : null,
                    permissions: attention.filter((item) => item.kind === "permission").length,
                    questions: attention.filter((item) => item.kind === "question").length,
                  }),
                  dependency_ids: [
                    ...new Set(
                      (member.dependency_ids ?? []).map((dependency) => resolveMember(dependency)?.id ?? dependency),
                    ),
                  ],
                  outcome:
                    member.outcome_type && member.outcome_label
                      ? new Outcome({ type: member.outcome_type, label: member.outcome_label })
                      : null,
                  result_persisted: Boolean(member.result_persisted),
                  time_created: member.time_created,
                  time_updated: member.time_updated,
                })
              })
              .sort(
                (a, b) =>
                  priority[a.state] - priority[b.state] ||
                  a.time_created - b.time_created ||
                  a.member_id.localeCompare(b.member_id),
              )
            const tasks = resolvedTasks.map(
              (task) =>
                new Task({
                  id: task.id,
                  description: task.description,
                  status: task.status,
                  assignee: task.member?.id ?? null,
                  dependency_ids: task.dependency_ids,
                  started_at: task.started_at,
                  completed_at: task.completed_at,
                }),
            )
            const memberByID = new Map(members.map((member) => [member.id, member]))
            const taskByID = new Map(storedTasks.map((task) => [task.id, task]))
            const dependencies = [
              ...workers.flatMap((worker) =>
                worker.dependency_ids.map(
                  (dependency) =>
                    new Dependency({
                      id: `member:${worker.member_id}:waits_on:${dependency}`,
                      kind: "member",
                      from_id: worker.member_id,
                      to_id: dependency,
                      label: "waits_on",
                      satisfied:
                        memberByID.get(dependency)?.status === "completed" ||
                        memberByID.get(dependency)?.status === "cancelled",
                    }),
                ),
              ),
              ...tasks.flatMap((task) =>
                task.dependency_ids.map(
                  (dependency) =>
                    new Dependency({
                      id: `task:${task.id}:waits_on:${dependency}`,
                      kind: "task",
                      from_id: task.id,
                      to_id: dependency,
                      label: "waits_on",
                      satisfied: taskByID.get(dependency)?.status === "completed",
                    }),
                ),
              ),
            ].sort(
              (a, b) =>
                a.kind.localeCompare(b.kind) || a.from_id.localeCompare(b.from_id) || a.to_id.localeCompare(b.to_id),
            )
            const count = (state: Worker["state"]) => workers.filter((worker) => worker.state === state).length
            const attentionItems = [
              ...reviews
                .filter((review) => review.state === "submitted")
                .map(
                  (review) =>
                    new AttentionItem({
                      id: `plan:${review.id}`,
                      member_id: review.member_id,
                      kind: "plan",
                      actionable: viewerRole === "lead",
                      detail_id: review.id,
                    }),
                ),
              ...storedAttention.map(
                (item) =>
                  new AttentionItem({
                    id: item.id,
                    member_id: item.member_id,
                    kind: item.kind,
                    actionable: viewerRole === "lead",
                    detail_id: item.detail_id,
                  }),
              ),
            ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
            return new Snapshot({
              team: new BoardTeam({
                id: team.id,
                name: team.name,
                goal: team.goal,
                lead_session_id: team.lead_session_id,
                status: team.status,
              }),
              viewer: new BoardViewer({ session_id: viewerSessionID, role: viewerRole }),
              revision: team.board_revision,
              generated_at: generatedAt,
              counts: new BoardCounts({
                workers: workers.length,
                working: count("working"),
                blocked: count("blocked"),
                idle: count("idle"),
                done: count("completed"),
                errored: count("errored"),
                cancelled: workers.filter(
                  (worker) =>
                    worker.state === "completed" &&
                    members.find((member) => member.id === worker.member_id)?.outcome_type === "cancelled",
                ).length,
                needs_you: count("needs_you"),
                unread: recipients.filter((recipient) => recipient.delivery_status === "delivered").length,
                claimed: resolvedTasks.filter((task) => task.member !== undefined).length,
                total_tasks: tasks.length,
              }),
              workers,
              tasks,
              dependencies,
              attention_items: attentionItems,
            })
          }),
        )
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
          Effect.catchTag("SqlError", Effect.die),
        )
    })

    const readMailbox = Effect.fn("TeamBoard.readMailbox")(function* (input: {
      teamID: string
      viewerSessionID: string
      cursor?: string
      limit?: number
    }) {
      const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 50)))
      const cursor = input.cursor
        ? (() => {
            const value = Buffer.from(input.cursor, "base64url").toString("utf8")
            const separator = value.indexOf(":")
            const time = Number(value.slice(0, separator))
            const id = value.slice(separator + 1)
            return separator > 0 && Number.isSafeInteger(time) && time >= 0 && id.length > 0 ? { time, id } : undefined
          })()
        : undefined
      if (input.cursor && !cursor) return yield* new InvalidCursorError()
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, input.teamID)).get()
            if (!team) return yield* new NotFoundError({ teamID: input.teamID })
            if (team.lead_session_id !== input.viewerSessionID) {
              const member = yield* tx
                .select({ id: TeamMemberTable.id })
                .from(TeamMemberTable)
                .where(
                  and(
                    eq(TeamMemberTable.team_id, input.teamID),
                    eq(TeamMemberTable.session_id, input.viewerSessionID),
                  ),
                )
                .get()
              if (!member)
                return yield* new InvalidViewerError({
                  teamID: input.teamID,
                  viewerSessionID: input.viewerSessionID,
                })
            }
            const rows = yield* tx
              .select({
                id: TeamMessageTable.id,
                sender: TeamMessageTable.sender,
                body: TeamMessageTable.body,
                delivery_status: TeamMessageRecipientTable.delivery_status,
                time_created: TeamMessageTable.time_created,
                time_updated: TeamMessageRecipientTable.time_updated,
              })
              .from(TeamMessageRecipientTable)
              .innerJoin(TeamMessageTable, eq(TeamMessageTable.id, TeamMessageRecipientTable.message_id))
              .where(
                and(
                  eq(TeamMessageRecipientTable.team_id, input.teamID),
                  eq(TeamMessageRecipientTable.recipient, input.viewerSessionID),
                  ...(cursor
                    ? [
                        or(
                          lt(TeamMessageTable.time_created, cursor.time),
                          and(
                            eq(TeamMessageTable.time_created, cursor.time),
                            lt(TeamMessageTable.id, cursor.id),
                          ),
                        ),
                      ]
                    : []),
                ),
              )
              .orderBy(desc(TeamMessageTable.time_created), desc(TeamMessageTable.id))
              .limit(limit + 1)
              .all()
            const page = rows.slice(0, limit)
            const last = page.at(-1)
            return new MailboxPage({
              items: page.map((row) => new MailboxMessage(row)),
              next_cursor:
                rows.length > limit && last
                  ? Buffer.from(`${last.time_created}:${last.id}`, "utf8").toString("base64url")
                  : null,
              revision: team.board_revision,
            })
          }),
        )
        .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
    })

    const markMessagesRead = Effect.fn("TeamBoard.markMessagesRead")(function* (input: {
      teamID: string
      viewerSessionID: string
      messageIDs: string[]
      expectedRevision: number
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, input.teamID)).get()
              if (!team) return yield* new NotFoundError({ teamID: input.teamID })
              if (team.lead_session_id !== input.viewerSessionID) {
                const member = yield* tx
                  .select({ id: TeamMemberTable.id })
                  .from(TeamMemberTable)
                  .where(
                    and(
                      eq(TeamMemberTable.team_id, input.teamID),
                      eq(TeamMemberTable.session_id, input.viewerSessionID),
                    ),
                  )
                  .get()
                if (!member)
                  return yield* new InvalidViewerError({
                    teamID: input.teamID,
                    viewerSessionID: input.viewerSessionID,
                  })
              }
              const messageIDs = [...new Set(input.messageIDs)]
              if (messageIDs.length === 0)
                return new MarkReadResult({ changed: false, revision: team.board_revision })
              const rows = yield* tx
                .select({
                  recipientID: TeamMessageRecipientTable.id,
                  messageID: TeamMessageRecipientTable.message_id,
                  status: TeamMessageRecipientTable.delivery_status,
                })
                .from(TeamMessageRecipientTable)
                .where(
                  and(
                    eq(TeamMessageRecipientTable.team_id, input.teamID),
                    eq(TeamMessageRecipientTable.recipient, input.viewerSessionID),
                    inArray(TeamMessageRecipientTable.message_id, messageIDs),
                  ),
                )
                .all()
              if (rows.length !== messageIDs.length) {
                const existing = new Set(rows.map((row) => row.messageID))
                return yield* new MessageNotFoundError({ messageID: messageIDs.find((id) => !existing.has(id)) ?? "" })
              }
              const pending = rows.find((row) => row.status === "pending")
              if (pending)
                return yield* new MessageStateConflictError({ messageID: pending.messageID, state: pending.status })
              if (rows.every((row) => row.status === "read"))
                return new MarkReadResult({ changed: false, revision: team.board_revision })
              if (team.board_revision !== input.expectedRevision)
                return yield* new RevisionConflictError({
                  expectedRevision: input.expectedRevision,
                  currentRevision: team.board_revision,
                })
              const now = Date.now()
              for (const row of rows.filter((row) => row.status === "delivered")) {
                yield* tx
                  .update(TeamMessageRecipientTable)
                  .set({ delivery_status: "read", time_updated: now })
                  .where(
                    and(
                      eq(TeamMessageRecipientTable.id, row.recipientID),
                      eq(TeamMessageRecipientTable.delivery_status, "delivered"),
                    ),
                  )
                  .run()
              }
              for (const messageID of messageIDs) {
                const unread = yield* tx
                  .select({ id: TeamMessageRecipientTable.id })
                  .from(TeamMessageRecipientTable)
                  .where(
                    and(
                      eq(TeamMessageRecipientTable.message_id, messageID),
                      or(
                        eq(TeamMessageRecipientTable.delivery_status, "pending"),
                        eq(TeamMessageRecipientTable.delivery_status, "delivered"),
                      ),
                    ),
                  )
                  .get()
                if (!unread)
                  yield* tx
                    .update(TeamMessageTable)
                    .set({ delivery_status: "read", time_updated: now })
                    .where(eq(TeamMessageTable.id, messageID))
                    .run()
              }
              const revision = yield* recordMutation(
                tx,
                input.teamID,
                ["message.read"],
                now,
                input.expectedRevision,
              )
              if (revision === undefined)
                return yield* new RevisionConflictError({
                  expectedRevision: input.expectedRevision,
                  currentRevision: team.board_revision,
                })
              return new MarkReadResult({ changed: true, revision })
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({ readSnapshot, readMailbox, markMessagesRead })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(TeamLease.defaultLayer), Layer.provide(Database.defaultLayer))

const summarize = (description: string) => {
  const value = description.replace(/\s+/g, " ").trim()
  return value.length <= 160 ? value : value.slice(0, 160)
}

export * as TeamBoard from "./board"
