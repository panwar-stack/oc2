import * as Tool from "./tool"
import DESCRIPTION from "./team_plan_decide.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import type { TaskPromptOps } from "./task"
import { wakeTeamSessionBounded } from "./team_wake"
import { Effect, Option, Schema } from "effect"
import { SessionID } from "@/session/schema"

const Parameters = Schema.Struct({
  member_name: Schema.String.annotate({ description: "Teammate name" }),
  decision: Schema.Literals(["approve", "reject"]).annotate({ description: "approve or reject" }),
  feedback: Schema.optional(Schema.String).annotate({ description: "Feedback for the teammate" }),
})

export const TeamPlanDecideTool = Tool.define(
  "team_plan_decide",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Plan Decide", output: "Agent teams disabled.", metadata: {} }
          const activeTeam = yield* team.getActive(ctx.sessionID)
          if (Option.isNone(activeTeam)) return { title: "Plan Decide Failed", output: "No active team.", metadata: {} }
          const members = yield* team.getMembers(activeTeam.value.id)
          const sessionMatch = members.find((member) => member.session_id === params.member_name)
          const nameMatches = sessionMatch ? [] : members.filter((member) => member.name === params.member_name)
          if (!sessionMatch && nameMatches.length > 1) {
            return {
              title: "Plan Decide Failed",
              output: `Member name '${params.member_name}' is ambiguous. Use a session ID instead.`,
              metadata: {},
            }
          }
          const target = sessionMatch ?? nameMatches[0]
          if (!target) return { title: "Plan Decide Failed", output: `No member '${params.member_name}'`, metadata: {} }
          if (!target.plan_mode) {
            return {
              title: "Plan Decide Failed",
              output: `Member '${params.member_name}' is not in plan mode.`,
              metadata: {},
            }
          }

          if (params.decision === "approve") {
            const targetSessionID = SessionID.make(target.session_id)
            const approved = yield* team.approveMemberPlan(target.id, {
              sender: ctx.sessionID,
              body: `PLAN APPROVED. Proceed with implementation.\n${params.feedback ?? ""}`,
              usageMetadata: {
                member_name: target.name,
                target_session_id: target.session_id,
                feedback_provided: params.feedback !== undefined,
              },
            })
            if (Option.isNone(approved)) {
              return {
                title: "Plan Decide Failed",
                output: `Member '${params.member_name}' is no longer an active non-terminal plan-mode member.`,
                metadata: {},
              }
            }
            const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
            if (promptOps) {
              yield* wakeTeamSessionBounded(promptOps, targetSessionID, undefined, team).pipe(Effect.ignore)
            }
            return { title: "Plan Approved", output: `Plan for ${params.member_name} approved.`, metadata: {} }
          }
          yield* team.sendMessage({
            teamID: activeTeam.value.id,
            sender: ctx.sessionID,
            recipients: [target.session_id],
            body: `PLAN REJECTED.\n${params.feedback ?? "Please revise and resubmit."}`,
          })
          yield* team.createUsageEvent({
            teamID: activeTeam.value.id,
            sessionID: ctx.sessionID,
            memberID: target.id,
            type: "plan_rejected",
            metadata: {
              member_name: target.name,
              target_session_id: target.session_id,
              feedback_provided: params.feedback !== undefined,
            },
          })
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (promptOps) {
            yield* wakeTeamSessionBounded(promptOps, SessionID.make(target.session_id), undefined, team).pipe(
              Effect.ignore,
            )
          }
          return { title: "Plan Rejected", output: `Plan for ${params.member_name} rejected.`, metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
