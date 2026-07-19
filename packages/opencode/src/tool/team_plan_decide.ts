import * as Tool from "./tool"
import DESCRIPTION from "./team_plan_decide.txt"
import { Team } from "@/team/team"
import { TeamDelivery } from "@/team/delivery"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import type { TaskPromptOps } from "./task"
import { wakeTeamSessionBounded } from "./team_wake"
import { Effect, Option, Schema } from "effect"
import { SessionID } from "@/session/schema"
import { TeamPlanReview } from "@/team/plan-review"
import { Cause, Exit } from "effect"

const Parameters = Schema.Struct({
  member_name: Schema.String.annotate({ description: "Teammate name" }),
  decision: Schema.Literals(["approve", "reject"]).annotate({ description: "approve or reject" }),
  feedback: Schema.optional(Schema.String).annotate({ description: "Feedback for the teammate" }),
})

type Metadata = { reviewID?: string }

export const TeamPlanDecideTool = Tool.define(
  "team_plan_decide",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const reviews = yield* TeamPlanReview.Service
    const delivery = yield* TeamDelivery.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Plan Decide", output: "Agent teams disabled.", metadata: {} as Metadata }
          const activeTeam = yield* team.getActive(ctx.sessionID)
          if (Option.isNone(activeTeam))
            return { title: "Plan Decide Failed", output: "No active team.", metadata: {} as Metadata }
          const members = yield* team.getMembers(activeTeam.value.id)
          const sessionMatch = members.find((member) => member.session_id === params.member_name)
          const nameMatches = sessionMatch ? [] : members.filter((member) => member.name === params.member_name)
          if (!sessionMatch && nameMatches.length > 1) {
            return {
              title: "Plan Decide Failed",
              output: `Member name '${params.member_name}' is ambiguous. Use a session ID instead.`,
              metadata: {} as Metadata,
            }
          }
          const target = sessionMatch ?? nameMatches[0]
          if (!target)
            return {
              title: "Plan Decide Failed",
              output: `No member '${params.member_name}'`,
              metadata: {} as Metadata,
            }
          const review = yield* reviews.latest(activeTeam.value.id, target.id)
          if (!review)
            return {
              title: "Plan Decide Failed",
              output: `No submitted plan for '${params.member_name}'.`,
              metadata: {} as Metadata,
            }
          const decidedExit = yield* reviews
            .decide({
              teamID: activeTeam.value.id,
              reviewID: review.id,
              viewerSessionID: ctx.sessionID,
              decision: params.decision,
              feedback: params.feedback,
              expectedRevision: activeTeam.value.board_revision,
            })
            .pipe(Effect.exit)
          if (Exit.isFailure(decidedExit)) {
            const error = Cause.squash(decidedExit.cause)
            return {
              title: "Plan Decide Failed",
              output: error instanceof Error ? error.message : String(error),
              metadata: { reviewID: review.id } as Metadata,
            }
          }
          const decided = decidedExit.value
          if (!decided.changed)
            return {
              title: params.decision === "approve" ? "Plan Approved" : "Plan Rejected",
              output: `Plan for ${params.member_name} was already ${decided.review.state}.`,
              metadata: { reviewID: review.id } as Metadata,
            }

          if (params.decision === "approve") {
            const targetSessionID = SessionID.make(target.session_id)
            const session = yield* sessions.get(targetSessionID)
            const newPermission = removePlanModePermissionOverlay(session.permission ?? [])
            yield* sessions.setPermission({ sessionID: targetSessionID, permission: newPermission })
            yield* team.sendMessage({
              teamID: activeTeam.value.id,
              sender: ctx.sessionID,
              recipients: [target.session_id],
              body: `PLAN APPROVED. Proceed with implementation.\n${params.feedback ?? ""}`,
            })
            yield* team.createUsageEvent({
              teamID: activeTeam.value.id,
              sessionID: ctx.sessionID,
              memberID: target.id,
              type: "plan_approved",
              metadata: {
                member_name: target.name,
                target_session_id: target.session_id,
                feedback_provided: params.feedback !== undefined,
              },
            })
            const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
            if (promptOps) {
              yield* wakeTeamSessionBounded(delivery, targetSessionID).pipe(Effect.ignore)
            }
            return {
              title: "Plan Approved",
              output: `Plan for ${params.member_name} approved.`,
              metadata: { reviewID: review.id } as Metadata,
            }
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
            yield* wakeTeamSessionBounded(delivery, SessionID.make(target.session_id)).pipe(Effect.ignore)
          }
          return {
            title: "Plan Rejected",
            output: `Plan for ${params.member_name} rejected.`,
            metadata: { reviewID: review.id } as Metadata,
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(TeamPlanReview.defaultLayer)),
)

function removePlanModePermissionOverlay(rules: Permission.Rule[]) {
  const removed = new Set<string>()
  return rules.reduceRight<Permission.Rule[]>((result, rule) => {
    if (isPlanModePermissionRule(rule) && !removed.has(rule.permission)) {
      removed.add(rule.permission)
      return result
    }
    return [rule, ...result]
  }, [])
}

function isPlanModePermissionRule(rule: Permission.Rule) {
  return (
    rule.action === "deny" &&
    rule.pattern === "*" &&
    (rule.permission === "bash" ||
      rule.permission === "write" ||
      rule.permission === "edit" ||
      rule.permission === "apply_patch")
  )
}
