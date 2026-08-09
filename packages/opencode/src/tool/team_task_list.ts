import * as Tool from "./tool"
import DESCRIPTION from "./team_task_list.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@oc2-ai/core/database/database"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({})

type TeamTaskListMetadata = {
  revision: number
  repeated: boolean
}

const unavailableMetadata: TeamTaskListMetadata = { revision: -1, repeated: false }

export const TeamTaskListTool = Tool.define(
  "team_task_list",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    const database = yield* Database.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Tasks", output: "Agent teams disabled.", metadata: unavailableMetadata }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context))
            return { title: "Team Tasks", output: "No active team.", metadata: unavailableMetadata }
          const revision = context.value.team.revision
          // Task-list polling can span multiple assistant messages in one user turn. Inspect both
          // prior completed tool parts from the turn history and the current assistant message.
          const lastUser = ctx.messages.findLast((message) => message.info.role === "user")
          const previousParts = [
            ...ctx.messages
              .filter(
                (message) => message.info.role === "assistant" && (!lastUser || message.info.id > lastUser.info.id),
              )
              .flatMap((message) => message.parts),
            ...(yield* MessageV2.parts(ctx.messageID).pipe(Effect.provideService(Database.Service, database))),
          ]
          const repeated = previousParts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "team_task_list" &&
              part.callID !== ctx.callID &&
              part.state.status === "completed" &&
              part.state.metadata.revision === revision,
          )
          // Suppress an unchanged repeat before task retrieval. A new user turn or any material
          // team mutation changes the comparison boundary and allows another planning read.
          if (repeated) {
            const lead = ctx.sessionID === context.value.team.lead_session_id
            return {
              title: "Team Tasks (Polling Blocked)",
              output: lead
                ? "Repeated unchanged task-list read suppressed. Do not poll team state. Continue useful decomposition, integration, review, or decision work. When no useful work remains, finish the current response normally. The runtime parks successful finalization while finite teammates remain active."
                : "Repeated unchanged task-list read suppressed. Continue your assigned work instead of polling.",
              metadata: { revision, repeated: true },
            }
          }
          const tasks = yield* team.getTasks(context.value.team.id)
          if (tasks.length === 0)
            return { title: "Team Tasks", output: "No tasks found.", metadata: { revision, repeated: false } }
          const lines = tasks.map(
            (task) =>
              `- [${task.status}] ${task.id.slice(0, 8)}: ${task.description}${task.assignee ? ` (${task.assignee})` : ""}${
                task.owned_paths.length > 0 ? ` [owned: ${task.owned_paths.join(", ")}]` : ""
              }`,
          )
          return { title: "Team Tasks", output: lines.join("\n"), metadata: { revision, repeated: false } }
        }).pipe(Effect.orDie),
    }
  }),
)
