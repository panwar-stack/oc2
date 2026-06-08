import * as Tool from "./tool"
import DESCRIPTION from "./team_task_update.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The task ID" }),
  status: Schema.optional(Schema.Literals(["pending", "in_progress", "completed", "cancelled"])).annotate({
    description: "New status",
  }),
  assignee: Schema.optional(Schema.String).annotate({ description: "New assignee" }),
})

export const TeamTaskUpdateTool = Tool.define(
  "team_task_update",
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
            return { title: "Task Update", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Task Update", output: "No active team.", metadata: {} }
          const current = yield* team.getTask(context.value.team.id, params.task_id)
          if (Option.isNone(current)) return { title: "Task Update Failed", output: "Task not found.", metadata: {} }
          if (context.value.team.lead_session_id !== ctx.sessionID && current.value.assignee !== ctx.sessionID)
            return { title: "Task Update Failed", output: "Only the lead or assigned teammate can update this task.", metadata: {} }
          const result = yield* team.updateTask(context.value.team.id, params.task_id, {
            status: params.status,
            assignee: params.assignee,
          })
          if (Option.isNone(result)) return { title: "Task Update Failed", output: "Task not found.", metadata: {} }
          return {
            title: "Task Updated",
            output: `Task ${result.value.id.slice(0, 8)} → ${result.value.status}`,
            metadata: {},
          }
        }).pipe(
          Effect.catchIf(
            (error): error is Error => error instanceof Error,
            (error) => Effect.succeed({ title: "Task Update Failed", output: error.message, metadata: {} }),
          ),
          Effect.orDie,
        ),
    }
  }),
)
