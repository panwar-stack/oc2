import * as Tool from "./tool"
import DESCRIPTION from "./team_send_message.txt"
import { Team } from "@/team/team"
import { TeamDelivery } from "@/team/delivery"
import { Config } from "@/config/config"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({
  recipient: Schema.String.annotate({ description: "The name or sessionID of the teammate" }),
  body: Schema.String.annotate({ description: "The message body" }),
})

type Metadata = { messageID?: string }

export const TeamSendMessageTool = Tool.define(
  "team_send_message",
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
            return { title: "Team Message", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Message", output: "No active team.", metadata: {} }
          const members = yield* team.getMembers(context.value.team.id)
          const requested = params.recipient
            .split(",")
            .map((recipient) => recipient.trim())
            .filter((recipient) => recipient.length > 0)
          const resolved = requested.map((recipient) => {
            if (recipient === "lead" || recipient === "lead_session" || recipient === "lead_session_id") {
              return { recipient, sessionID: context.value.team.lead_session_id }
            }
            const sessionMatch = members.find((member) => member.session_id === recipient)
            if (sessionMatch) return { recipient, sessionID: sessionMatch.session_id }
            const nameMatches = members.filter((member) => member.name === recipient)
            if (nameMatches.length === 1) return { recipient, sessionID: nameMatches[0]?.session_id }
            return { recipient, ambiguous: nameMatches.length > 1 }
          })
          const ambiguous = resolved.filter((recipient) => recipient.ambiguous).map((recipient) => recipient.recipient)
          if (ambiguous.length > 0) {
            return {
              title: "Team Message",
              output: `Recipient name(s) are ambiguous; use session IDs instead: ${ambiguous.join(", ")}`,
              metadata: {},
            }
          }
          const recipientIDs = resolved
            .map((recipient) => recipient.sessionID)
            .filter((recipient): recipient is string => recipient !== undefined)
          const missing = resolved
            .filter((recipient) => recipient.sessionID === undefined)
            .map((recipient) => recipient.recipient)
          if (missing.length > 0) {
            return { title: "Team Message", output: `Recipient '${missing.join(", ")}' not found.`, metadata: {} }
          }
          const recipients = [...new Set(recipientIDs)]
          if (recipients.length === 0) return { title: "Team Message", output: "No recipients.", metadata: {} }
          const msg = yield* team.sendMessage({
            teamID: context.value.team.id,
            sender: ctx.sessionID,
            recipients,
            body: params.body,
          })
          const lead = ctx.sessionID === context.value.team.lead_session_id
          return {
            title: "Message Sent",
            output: [
              `Sent to ${recipients.length} recipient(s).`,
              lead
                ? "Recipient activities were durably admitted and advisory wakes were issued."
                : "Delivery is durable and asynchronous. Busy recipients will only see this when their current run reaches the next prompt boundary.",
              lead
                ? "Check team_get_messages once for any teammate response before deciding the next coordination step."
                : "Continue your assigned work unless this message reports a blocker.",
            ].join("\n"),
            metadata: { messageID: msg.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
