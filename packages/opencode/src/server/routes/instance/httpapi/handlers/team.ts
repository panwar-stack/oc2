import { TeamEval } from "@/team/eval"
import { Team } from "@/team/team"
import { TeamBoard } from "@/team/board"
import { TeamAttention } from "@/team/attention"
import { TeamPlanReview } from "@/team/plan-review"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const teamHandlers = HttpApiBuilder.group(InstanceHttpApi, "team", (handlers) =>
  Effect.gen(function* () {
    const team = yield* Team.Service
    const board = yield* TeamBoard.Service
    const attention = yield* TeamAttention.Service
    const reviews = yield* TeamPlanReview.Service
    const sessions = yield* Session.Service

    const getBySession = Effect.fn("TeamHttpApi.getBySession")(function* (ctx: {
      query: { sessionID?: string; viewer_session_id?: string }
    }) {
      const selector = ctx.query.viewer_session_id ?? ctx.query.sessionID
      if (!selector) return yield* new HttpApiError.BadRequest({})
      const result = yield* team.getContext(selector)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      return result.value.team
    })

    const getHistory = Effect.fn("TeamHttpApi.getHistory")(function* (ctx: {
      query: { viewer_session_id: string }
    }) {
      return yield* team.getHistory(ctx.query.viewer_session_id)
    })

    const getBoard = Effect.fn("TeamHttpApi.getBoard")(function* (ctx: {
      params: { teamID: string }
      query: { viewer_session_id: string }
    }) {
      return yield* board.readSnapshot(ctx.params.teamID, ctx.query.viewer_session_id).pipe(
        Effect.catchTag("TeamBoard.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("TeamBoard.InvalidViewerError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
    })

    const getMailbox = Effect.fn("TeamHttpApi.getMailbox")(function* (ctx: {
      params: { teamID: string }
      query: { viewer_session_id: string; cursor?: string; limit?: number }
    }) {
      return yield* board
        .readMailbox({
          teamID: ctx.params.teamID,
          viewerSessionID: ctx.query.viewer_session_id,
          cursor: ctx.query.cursor,
          limit: ctx.query.limit,
        })
        .pipe(
          Effect.catchTag("TeamBoard.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("TeamBoard.InvalidViewerError", () => Effect.fail(new HttpApiError.BadRequest({}))),
          Effect.catchTag("TeamBoard.InvalidCursorError", () => Effect.fail(new HttpApiError.BadRequest({}))),
        )
    })

    const getAttention = Effect.fn("TeamHttpApi.getAttention")(function* (ctx: {
      params: { teamID: string; attentionID: string }
      query: { viewer_session_id: string }
    }) {
      yield* board.readSnapshot(ctx.params.teamID, ctx.query.viewer_session_id).pipe(
        Effect.catchTag("TeamBoard.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
        Effect.catchTag("TeamBoard.InvalidViewerError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      const stored = yield* attention.get(ctx.params.teamID, ctx.params.attentionID)
      if (stored)
        return {
          id: stored.id,
          member_id: stored.member_id,
          kind: stored.kind,
          state: stored.state,
          detail: stored.detail,
        }
      const reviewID = ctx.params.attentionID.startsWith("plan:")
        ? ctx.params.attentionID.slice("plan:".length)
        : ctx.params.attentionID
      const review = yield* reviews.get(ctx.params.teamID, reviewID)
      if (!review) return yield* new HttpApiError.NotFound({})
      return {
        id: `plan:${review.id}`,
        member_id: review.member_id,
        kind: "plan" as const,
        state: review.state,
        detail: {
          plan: review.plan_body,
          ...(review.decision_feedback === null ? {} : { feedback: review.decision_feedback }),
        },
      }
    })

    const markMessagesRead = Effect.fn("TeamHttpApi.markMessagesRead")(function* (ctx: {
      params: { teamID: string }
      query: { viewer_session_id: string }
      payload: { message_ids: readonly string[]; expected_revision: number }
    }) {
      return yield* board
        .markMessagesRead({
          teamID: ctx.params.teamID,
          viewerSessionID: ctx.query.viewer_session_id,
          messageIDs: [...ctx.payload.message_ids],
          expectedRevision: ctx.payload.expected_revision,
        })
        .pipe(
          Effect.catchTag("TeamBoard.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("TeamBoard.MessageNotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("TeamBoard.InvalidViewerError", () => Effect.fail(new HttpApiError.BadRequest({}))),
          Effect.catchTag("TeamBoard.RevisionConflictError", () => Effect.fail(new HttpApiError.Conflict({}))),
          Effect.catchTag("TeamBoard.MessageStateConflictError", () => Effect.fail(new HttpApiError.Conflict({}))),
        )
    })

    const decidePlan = Effect.fn("TeamHttpApi.decidePlan")(function* (ctx: {
      params: { teamID: string; reviewID: string }
      query: { viewer_session_id: string }
      payload: { decision: "approve" | "reject"; feedback?: string; expected_revision: number }
    }) {
      const result = yield* reviews
        .decide({
          teamID: ctx.params.teamID,
          reviewID: ctx.params.reviewID,
          viewerSessionID: ctx.query.viewer_session_id,
          decision: ctx.payload.decision,
          feedback: ctx.payload.feedback,
          expectedRevision: ctx.payload.expected_revision,
        })
        .pipe(
          Effect.catchTag("TeamPlanReview.NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))),
          Effect.catchTag("TeamPlanReview.InvalidViewerError", () => Effect.fail(new HttpApiError.BadRequest({}))),
          Effect.catchTag("TeamPlanReview.RevisionConflictError", () => Effect.fail(new HttpApiError.Conflict({}))),
          Effect.catchTag("TeamPlanReview.StateConflictError", () => Effect.fail(new HttpApiError.Conflict({}))),
        )
      if (result.changed && ctx.payload.decision === "approve") {
        const sessionID = SessionID.make(result.memberSessionID)
        const session = yield* sessions
          .get(sessionID)
          .pipe(Effect.catchTag("NotFoundError", () => Effect.fail(new HttpApiError.NotFound({}))))
        const removed = new Set<string>()
        const permission = (session.permission ?? []).reduceRight<Permission.Rule[]>((rules, rule) => {
          if (
            rule.action === "deny" &&
            rule.pattern === "*" &&
            (rule.permission === "bash" ||
              rule.permission === "write" ||
              rule.permission === "edit" ||
              rule.permission === "apply_patch") &&
            !removed.has(rule.permission)
          ) {
            removed.add(rule.permission)
            return rules
          }
          return [rule, ...rules]
        }, [])
        yield* sessions.setPermission({ sessionID, permission })
      }
      return { changed: result.changed, state: result.review.state as "approved" | "rejected", revision: result.currentRevision }
    })

    const requireTeamAccess = Effect.fn("TeamHttpApi.requireTeamAccess")(function* (teamID: string, sessionID: string) {
      const result = yield* team.get(teamID)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      if (result.value.lead_session_id === sessionID) return result.value
      const members = yield* team.getMembers(teamID)
      if (members.some((member) => member.session_id === sessionID)) return result.value
      return yield* new HttpApiError.BadRequest({})
    })

    const getByTeam = Effect.fn("TeamHttpApi.getByTeam")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      const result = yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return result
    })

    const getTasks = Effect.fn("TeamHttpApi.getTasks")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return (yield* team.getTasks(ctx.params.teamID)).map((task) => ({
        id: task.id,
        team_id: task.team_id,
        description: task.description,
        status: task.status,
        ...(task.assignee == null ? {} : { assignee: task.assignee }),
        ...(task.dependency_ids == null ? {} : { dependency_ids: task.dependency_ids }),
        ...(task.metadata == null ? {} : { metadata: task.metadata }),
        time_created: task.time_created,
        time_updated: task.time_updated,
      }))
    })

    const getMessages = Effect.fn("TeamHttpApi.getMessages")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return yield* team.getMessages(ctx.params.teamID)
    })

    const getEval = Effect.fn("TeamHttpApi.getEval")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return yield* TeamEval.build(ctx.params.teamID).pipe(
        Effect.catchTag("TeamEval.NotFoundError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
    })

    const shutdown = Effect.fn("TeamHttpApi.shutdown")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      yield* team.shutdown(ctx.params.teamID)
      return true
    })

    return handlers
      .handle("getBySession", getBySession)
      .handle("getHistory", getHistory)
      .handle("getBoard", getBoard)
      .handle("getMailbox", getMailbox)
      .handle("getAttention", getAttention)
      .handle("markMessagesRead", markMessagesRead)
      .handle("decidePlan", decidePlan)
      .handle("getByTeam", getByTeam)
      .handle("getEval", getEval)
      .handle("getTasks", getTasks)
      .handle("getMessages", getMessages)
      .handle("shutdown", shutdown)
  }),
)
