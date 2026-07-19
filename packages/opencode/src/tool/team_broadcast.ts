import * as Tool from "./tool"
import DESCRIPTION from "./team_broadcast.txt"
import { Team } from "@/team/team"
import { TeamDelivery } from "@/team/delivery"
import { Config } from "@/config/config"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({
  body: Schema.String.annotate({ description: "The message body" }),
})

type Metadata = { messageID?: string }

export const TeamBroadcastTool = Tool.define(
  "team_broadcast",
  Effect.gen(function* () {
    const team = yield* Team.Service
    yield* TeamDelivery.Service
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Broadcast", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Broadcast", output: "No active team.", metadata: {} }
          const members = yield* team.getMembers(context.value.team.id)
          const activeMembers = members.filter(
            (member) => member.status === "active" || member.status === "starting" || member.status === "idle",
          )
          const recipients = [
            ...new Set(
              [context.value.team.lead_session_id, ...activeMembers.map((member) => member.session_id)].filter(
                (sessionID) => sessionID !== ctx.sessionID,
              ),
            ),
          ]
          if (recipients.length === 0) return { title: "Team Broadcast", output: "No active teammates.", metadata: {} }
          const msg = yield* team.sendMessage({
            teamID: context.value.team.id,
            sender: ctx.sessionID,
            recipients,
            body: params.body,
          })
          const lead = ctx.sessionID === context.value.team.lead_session_id
          yield* team.createUsageEvent({
            teamID: context.value.team.id,
            sessionID: ctx.sessionID,
            memberID: context.value.member?.id,
            type: "broadcast_sent",
            metadata: { message_id: msg.id, recipient_count: recipients.length, lead_sender: lead },
          })
          return {
            title: "Broadcast Sent",
            output: [
              `Sent to ${recipients.length} recipient(s).`,
              lead
                ? "Recipient activities were durably admitted and advisory wakes were issued."
                : "Delivery is durable and asynchronous. Busy recipients will only see this when their current run reaches the next prompt boundary.",
              lead
                ? "Check team_get_messages once for teammate responses before deciding the next coordination step."
                : "Continue your assigned work unless this broadcast reports a blocker.",
            ].join("\n"),
            metadata: { messageID: msg.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
