import * as Tool from "./tool"
import DESCRIPTION from "./team_get_messages.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
// Used to inspect stored tool parts when guarding against repeated empty mailbox polls.
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@oc2-ai/core/database/database"
import { Truncate } from "./truncate"
import { Effect, Option, Schema } from "effect"

const Parameters = Schema.Struct({})
const emptyMailboxOutputMarker = "No pending messages."

export const TeamGetMessagesTool = Tool.define(
  "team_get_messages",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    const agent = yield* Agent.Service
    const database = yield* Database.Service
    const truncate = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          // Keep metadata shape stable for callers even when team messaging is unavailable.
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Messages", output: "Agent teams disabled.", metadata: { count: 0, repeated: false } }
          const context = yield* team.getContext(ctx.sessionID)
          // A missing team is still an empty read, not a repeated-poll signal.
          if (Option.isNone(context))
            return { title: "Team Messages", output: "No active team.", metadata: { count: 0, repeated: false } }
          const messages = yield* team.claimPendingMessages(ctx.sessionID, context.value.team.id)
          let acknowledged = false
          return yield* Effect.gen(function* () {
            // Empty polling can span multiple assistant messages in one user turn, so inspect both prior
            // completed tool parts from the turn history and the current assistant message.
            const lastUser = ctx.messages.findLast((message) => message.info.role === "user")
            const previousParts = [
              ...ctx.messages
                .filter(
                  (message) => message.info.role === "assistant" && (!lastUser || message.info.id > lastUser.info.id),
                )
                .flatMap((message) => message.parts),
              ...(yield* MessageV2.parts(ctx.messageID).pipe(Effect.provideService(Database.Service, database))),
            ]
            // Count only completed empty reads, so actual pending messages still deliver normally.
            const previousEmptyChecks = previousParts.filter(
              (part) =>
                part.type === "tool" &&
                part.tool === "team_get_messages" &&
                part.callID !== ctx.callID &&
                part.state.status === "completed" &&
                part.state.metadata.count === 0 &&
                part.state.metadata.teamID === context.value.team.id &&
                part.state.output.startsWith(emptyMailboxOutputMarker),
            ).length
            if (messages.length === 0 && previousEmptyChecks > 0) {
              const lead = ctx.sessionID === context.value.team.lead_session_id
              return {
                title: "Team Messages (Polling Blocked)",
                output: lead
                  ? "No pending messages.\nRepeated empty mailbox check suppressed. Do not poll for mail. When no useful work remains, finish the current response normally."
                  : "No pending messages.\nRepeated empty mailbox check suppressed. Continue your assigned work instead of polling.",
                metadata: { count: 0, repeated: true, teamID: context.value.team.id },
              }
            }
            // Members are needed for both empty-mailbox status summaries and sender labels below.
            const members = yield* team.getMembers(context.value.team.id)
            // Include member status in the first empty-mailbox response so the lead can make one useful
            // coordination decision, then finish normally instead of polling.
            const status = members.map(
              (member) => `- ${member.name} (${member.agent_type}, ${member.status}, session ${member.session_id})`,
            )
            if (messages.length === 0) {
              // An empty mailbox is not a wait primitive. The lead finishes normally when useful
              // coordination is done, and the runtime parks successful finalization when necessary.
              const lead = ctx.sessionID === context.value.team.lead_session_id
              const guidance = lead
                ? [
                    "No pending messages.",
                    "Check complete. Continue useful decomposition, integration, review, or decision work. When no useful work remains, finish the current response normally. The runtime parks successful finalization while finite teammates remain active.",
                    "Team messages are delivered asynchronously; busy teammates can only process broadcasts or direct messages at their next prompt boundary.",
                    "Do not sleep, repeatedly read team state, ask for routine updates, or send filler. Teammates must send material progress, blockers, questions, and results without a lead status request. Relevant teammate or user events wake the lead.",
                  ]
                : ["No pending messages.", "Check complete. Continue your assigned work instead of polling."]
              return {
                title: "Team Messages",
                output: [...guidance, ...(status.length > 0 ? ["", "Current team status:", ...status] : [])].join("\n"),
                metadata: { count: 0, repeated: false, teamID: context.value.team.id },
              }
            }
            const senderName = (sender: string) => {
              if (sender === context.value.team.lead_session_id) return "lead"
              return members.find((member) => member.session_id === sender)?.name ?? sender
            }
            const activeAgent = yield* agent.get(ctx.agent)
            const rendered = yield* truncate.output(
              messages
                .map((message) => [`From ${senderName(message.sender)} (${message.sender}):`, message.body].join("\n"))
                .join("\n\n---\n\n"),
              {},
              activeAgent,
            )

            yield* Effect.forEach(messages, (message) => team.markMessageDelivered(message.id, ctx.sessionID), {
              concurrency: "unbounded",
              discard: true,
            })
            acknowledged = true

            return {
              title: "Team Messages",
              output: rendered.content,
              // Non-empty reads are never polling violations; the flag is for empty-read guardrails only.
              metadata: {
                count: messages.length,
                repeated: false,
                truncated: rendered.truncated,
                ...(rendered.truncated && { outputPath: rendered.outputPath }),
              },
            }
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                acknowledged
                  ? Effect.void
                  : team.releaseClaimedMessages(
                      messages.map((message) => message.id),
                      ctx.sessionID,
                    ),
              ),
            ),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
