import { Database } from "@oc2-ai/core/database/database"
import { Context, Effect, Layer, Schema } from "effect"
import { and, desc, eq } from "drizzle-orm"
import { recordMutation } from "./board-outbox"
import { TeamMemberTable, TeamPlanReviewTable, TeamTable } from "./team.sql"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TeamPlanReview.NotFoundError", {
  resource: Schema.String,
}) {}

export class InvalidViewerError extends Schema.TaggedErrorClass<InvalidViewerError>()(
  "TeamPlanReview.InvalidViewerError",
  { teamID: Schema.String, viewerSessionID: Schema.String },
) {}

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "TeamPlanReview.RevisionConflictError",
  { expectedRevision: Schema.Number, currentRevision: Schema.Number },
) {}

export class StateConflictError extends Schema.TaggedErrorClass<StateConflictError>()(
  "TeamPlanReview.StateConflictError",
  { reviewID: Schema.String, state: Schema.String },
) {}

export type Review = typeof TeamPlanReviewTable.$inferSelect

export type DecisionResult = {
  changed: boolean
  review: Review
  currentRevision: number
  memberSessionID: string
  memberID: string
}

export interface Interface {
  submit: (input: {
    reviewID: string
    memberSessionID: string
    planBody: string
  }) => Effect.Effect<
    { changed: boolean; review: Review; currentRevision: number },
    NotFoundError | StateConflictError
  >
  decide: (input: {
    teamID: string
    reviewID: string
    viewerSessionID: string
    decision: "approve" | "reject"
    feedback?: string
    expectedRevision: number
  }) => Effect.Effect<
    DecisionResult,
    NotFoundError | InvalidViewerError | RevisionConflictError | StateConflictError
  >
  get: (teamID: string, reviewID: string) => Effect.Effect<Review | undefined>
  latest: (teamID: string, memberID: string) => Effect.Effect<Review | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamPlanReview") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const submit = Effect.fn("TeamPlanReview.submit")(function* (input: {
      reviewID: string
      memberSessionID: string
      planBody: string
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.session_id, input.memberSessionID))
                .get()
              if (!member) return yield* new NotFoundError({ resource: `member:${input.memberSessionID}` })
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, member.team_id)).get()
              if (!team) return yield* new NotFoundError({ resource: `team:${member.team_id}` })
              const existing = yield* tx
                .select()
                .from(TeamPlanReviewTable)
                .where(eq(TeamPlanReviewTable.id, input.reviewID))
                .get()
              if (existing) {
                if (
                  existing.team_id === member.team_id &&
                  existing.member_id === member.id &&
                  existing.submitted_by_session_id === input.memberSessionID &&
                  existing.plan_body === input.planBody
                ) {
                  return { changed: false, review: existing, currentRevision: team.board_revision }
                }
                return yield* new StateConflictError({ reviewID: input.reviewID, state: existing.state })
              }
              if (!member.plan_mode)
                return yield* new StateConflictError({ reviewID: input.reviewID, state: "not_in_plan_mode" })
              const pending = yield* tx
                .select()
                .from(TeamPlanReviewTable)
                .where(
                  and(
                    eq(TeamPlanReviewTable.team_id, member.team_id),
                    eq(TeamPlanReviewTable.member_id, member.id),
                    eq(TeamPlanReviewTable.state, "submitted"),
                  ),
                )
                .orderBy(desc(TeamPlanReviewTable.time_created))
                .get()
              if (pending)
                return yield* new StateConflictError({ reviewID: pending.id, state: pending.state })
              const now = Date.now()
              yield* tx
                .insert(TeamPlanReviewTable)
                .values({
                  id: input.reviewID,
                  team_id: member.team_id,
                  member_id: member.id,
                  submitted_by_session_id: input.memberSessionID,
                  plan_body: input.planBody,
                  state: "submitted",
                  time_created: now,
                  time_updated: now,
                })
                .run()
              const revision = yield* recordMutation(tx, member.team_id, ["plan.submitted"], now)
              if (revision === undefined)
                return yield* Effect.die(new Error(`Plan review ${input.reviewID} references missing team`))
              const review = yield* tx
                .select()
                .from(TeamPlanReviewTable)
                .where(eq(TeamPlanReviewTable.id, input.reviewID))
                .get()
              if (!review) return yield* Effect.die(new Error(`Inserted plan review ${input.reviewID} was not found`))
              return { changed: true, review, currentRevision: revision }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
    })

    const decide = Effect.fn("TeamPlanReview.decide")(function* (input: {
      teamID: string
      reviewID: string
      viewerSessionID: string
      decision: "approve" | "reject"
      feedback?: string
      expectedRevision: number
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, input.teamID)).get()
              if (!team) return yield* new NotFoundError({ resource: `team:${input.teamID}` })
              if (team.lead_session_id !== input.viewerSessionID)
                return yield* new InvalidViewerError({
                  teamID: input.teamID,
                  viewerSessionID: input.viewerSessionID,
                })
              const review = yield* tx
                .select()
                .from(TeamPlanReviewTable)
                .where(
                  and(eq(TeamPlanReviewTable.team_id, input.teamID), eq(TeamPlanReviewTable.id, input.reviewID)),
                )
                .get()
              if (!review) return yield* new NotFoundError({ resource: `review:${input.reviewID}` })
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(and(eq(TeamMemberTable.team_id, input.teamID), eq(TeamMemberTable.id, review.member_id)))
                .get()
              if (!member) return yield* new NotFoundError({ resource: `member:${review.member_id}` })
              if (review.state === "approved" || review.state === "rejected") {
                const stored = review.decision
                if (stored === input.decision) {
                  return {
                    changed: false,
                    review,
                    currentRevision: team.board_revision,
                    memberSessionID: member.session_id,
                    memberID: member.id,
                  }
                }
                return yield* new StateConflictError({ reviewID: review.id, state: review.state })
              }
              if (review.state !== "submitted")
                return yield* new StateConflictError({ reviewID: review.id, state: review.state })
              if (team.board_revision !== input.expectedRevision)
                return yield* new RevisionConflictError({
                  expectedRevision: input.expectedRevision,
                  currentRevision: team.board_revision,
                })
              const now = Date.now()
              const state = input.decision === "approve" ? ("approved" as const) : ("rejected" as const)
              yield* tx
                .update(TeamPlanReviewTable)
                .set({
                  state,
                  decision: input.decision,
                  decision_feedback: input.feedback ?? null,
                  decided_by_session_id: input.viewerSessionID,
                  decided_at: now,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(TeamPlanReviewTable.id, review.id),
                    eq(TeamPlanReviewTable.state, "submitted"),
                  ),
                )
                .run()
              if (input.decision === "approve") {
                yield* tx
                  .update(TeamMemberTable)
                  .set({ status: "active", plan_mode: false, work_mode: "implement", time_updated: now })
                  .where(eq(TeamMemberTable.id, member.id))
                  .run()
              }
              const revision = yield* recordMutation(
                tx,
                input.teamID,
                [`plan.${state}`],
                now,
                input.expectedRevision,
              )
              if (revision === undefined)
                return yield* new RevisionConflictError({
                  expectedRevision: input.expectedRevision,
                  currentRevision: team.board_revision,
                })
              const stored = yield* tx
                .select()
                .from(TeamPlanReviewTable)
                .where(eq(TeamPlanReviewTable.id, review.id))
                .get()
              if (!stored) return yield* Effect.die(new Error(`Decided plan review ${review.id} was not found`))
              return {
                changed: true,
                review: stored,
                currentRevision: revision,
                memberSessionID: member.session_id,
                memberID: member.id,
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("EffectDrizzleQueryError", Effect.die), Effect.catchTag("SqlError", Effect.die))
    })

    const get = Effect.fn("TeamPlanReview.get")(function* (teamID: string, reviewID: string) {
      return yield* db
        .select()
        .from(TeamPlanReviewTable)
        .where(and(eq(TeamPlanReviewTable.team_id, teamID), eq(TeamPlanReviewTable.id, reviewID)))
        .get()
        .pipe(Effect.orDie)
    })

    const latest = Effect.fn("TeamPlanReview.latest")(function* (teamID: string, memberID: string) {
      return yield* db
        .select()
        .from(TeamPlanReviewTable)
        .where(and(eq(TeamPlanReviewTable.team_id, teamID), eq(TeamPlanReviewTable.member_id, memberID)))
        .orderBy(desc(TeamPlanReviewTable.time_created), desc(TeamPlanReviewTable.id))
        .get()
        .pipe(Effect.orDie)
    })

    return Service.of({ submit, decide, get, latest })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as TeamPlanReview from "./plan-review"
