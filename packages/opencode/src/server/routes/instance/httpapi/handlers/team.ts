import { TeamEval } from "@/team/eval"
import { Team } from "@/team/team"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const teamHandlers = HttpApiBuilder.group(InstanceHttpApi, "team", (handlers) =>
  Effect.gen(function* () {
    const team = yield* Team.Service

    const getBySession = Effect.fn("TeamHttpApi.getBySession")(function* (ctx: { query: { sessionID: string } }) {
      const result = yield* team.getByLeadSession(ctx.query.sessionID)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      return result.value
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
      .handle("getByTeam", getByTeam)
      .handle("getEval", getEval)
      .handle("getTasks", getTasks)
      .handle("getMessages", getMessages)
      .handle("shutdown", shutdown)
  }),
)
