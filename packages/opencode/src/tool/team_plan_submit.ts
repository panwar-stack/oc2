import * as Tool from "./tool"
import DESCRIPTION from "./team_plan_submit.txt"
import { Team } from "@/team/team"
import { TeamDelivery } from "@/team/delivery"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "./task"
import { wakeTeamSession } from "./team_wake"
import { Effect, Schema, Option, Scope } from "effect"
import { TeamPlanReview } from "@/team/plan-review"

const Parameters = Schema.Struct({
  plan: Schema.String.annotate({ description: "The plan content to submit for approval" }),
})

type Metadata = { reviewID?: string }

export const TeamPlanSubmitTool = Tool.define(
  "team_plan_submit",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const reviews = yield* TeamPlanReview.Service
    const delivery = yield* TeamDelivery.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Plan Submit", output: "Agent teams disabled.", metadata: {} as Metadata }
          const member = yield* team.getMemberBySession(ctx.sessionID)
          if (Option.isNone(member))
            return { title: "Plan Submit Failed", output: "Not a team member.", metadata: {} as Metadata }
          if (!member.value.plan_mode)
            return { title: "Plan Submit Failed", output: "Not in plan mode.", metadata: {} as Metadata }
          const info = yield* team.get(member.value.team_id)
          if (Option.isNone(info))
            return { title: "Plan Submit Failed", output: "Team not found.", metadata: {} as Metadata }
          const reviewID = ctx.callID ?? `${ctx.messageID}:team_plan_submit`
          const submitted = yield* reviews.submit({ reviewID, memberSessionID: ctx.sessionID, planBody: params.plan })
          if (!submitted.changed)
            return {
              title: "Plan Submitted",
              output: "Plan submission already recorded for lead review.",
              metadata: { reviewID } as Metadata,
            }
          yield* team.sendMessage({
            teamID: member.value.team_id,
            sender: ctx.sessionID,
            recipients: [info.value.lead_session_id],
            body: `PLAN SUBMITTED by ${member.value.name} (review ${reviewID}):\n\n${params.plan}`,
          })
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (promptOps) {
            yield* wakeTeamSession(delivery, info.value.lead_session_id).pipe(Effect.ignore, Effect.forkIn(scope))
          }
          return {
            title: "Plan Submitted",
            output: "Plan submitted for lead review.",
            metadata: { reviewID } as Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(TeamPlanReview.defaultLayer)),
)
