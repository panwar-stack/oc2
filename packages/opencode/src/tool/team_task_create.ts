import * as Tool from "./tool"
import DESCRIPTION from "./team_task_create.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { canonicalize, assertNoDuplicateAliases } from "@/team/file-ownership"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Effect, Schema, Option } from "effect"

const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "Task description" }),
  assignee: Schema.optional(Schema.String).annotate({ description: "Optional assignee" }),
  dependency_ids: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional dependency task IDs",
  }),
  owned_paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional exact file paths this task exclusively reserves. Each path is canonicalized; an already-reserved path rejects the whole create. Directory and glob claims are not yet supported.",
  }),
})

export const TeamTaskCreateTool = Tool.define(
  "team_task_create",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams)
            return { title: "Team Task", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Task", output: "No active team.", metadata: {} }
          const owned = yield* Effect.forEach(
            params.owned_paths ?? [],
            (target) => canonicalize(session, ctx, target).pipe(Effect.provideService(FSUtil.Service, fs)),
          )
          yield* assertNoDuplicateAliases(owned)
          const task = yield* team.createTask({
            teamID: context.value.team.id,
            description: params.description,
            assignee: params.assignee,
            dependencyIDs: params.dependency_ids ? [...params.dependency_ids] : undefined,
            owned,
          })
          return {
            title: "Task Created",
            output: `Task: ${task.id.slice(0, 8)} - ${task.description}`,
            metadata: { taskID: task.id },
          }
        }).pipe(
          Effect.catchIf(
            (error): error is Error => error instanceof Error,
            (error) => Effect.succeed({ title: "Task Create Failed", output: error.message, metadata: {} }),
          ),
          Effect.orDie,
        ),
    }
  }),
)
