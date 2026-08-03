import * as Tool from "./tool"
import DESCRIPTION from "./team_task_update.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { canonicalize } from "@/team/file-ownership"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Effect, Schema, Option } from "effect"

const HandoffVerificationSchema = Schema.Struct({
  command: Schema.String.annotate({ description: "The command or check that was run" }),
  status: Schema.Literals(["passed", "failed", "not_run"]).annotate({
    description: "Outcome of the check: passed, failed, or not_run",
  }),
  detail: Schema.optional(Schema.String).annotate({ description: "Optional detail for the check result" }),
})

const HandoffSchema = Schema.Struct({
  summary: Schema.String.annotate({ description: "Nonblank summary of the completed work" }),
  changed_paths: Schema.Array(Schema.String).annotate({
    description:
      "Exact file paths changed by this task. Each path is canonicalized and must be a subset of the task's reserved owned_paths.",
  }),
  verification: Schema.Array(HandoffVerificationSchema).annotate({
    description: "Commands or checks run to verify the work",
  }),
  risks: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional known risks or caveats",
  }),
})

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The task ID" }),
  status: Schema.optional(Schema.Literals(["pending", "in_progress", "completed", "cancelled"])).annotate({
    description: "New status",
  }),
  assignee: Schema.optional(Schema.String).annotate({ description: "New assignee" }),
  handoff: Schema.optional(HandoffSchema).annotate({
    description: "Structured handoff required to complete an owned task",
  }),
})

export const TeamTaskUpdateTool = Tool.define(
  "team_task_update",
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
            return { title: "Task Update", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Task Update", output: "No active team.", metadata: {} }
          const current = yield* team.getTask(context.value.team.id, params.task_id)
          if (Option.isNone(current)) return { title: "Task Update Failed", output: "Task not found.", metadata: {} }
          if (context.value.team.lead_session_id !== ctx.sessionID && current.value.assignee !== ctx.sessionID)
            return {
              title: "Task Update Failed",
              output: "Only the lead or assigned teammate can update this task.",
              metadata: {},
            }
          // Canonicalize the handoff's changed paths. Each entry must canonicalize; the display
          // paths are stored and the canonical pathKeys are validated against the task's
          // reservations by the service.
          let handoff: Team.TaskHandoff | undefined
          let handoffPathKeys: string[] | undefined
          if (params.handoff) {
            const changed = yield* Effect.forEach(params.handoff.changed_paths, (target) =>
              canonicalize(session, ctx, target).pipe(Effect.provideService(FSUtil.Service, fs)),
            )
            handoff = {
              summary: params.handoff.summary,
              changed_paths: changed.map((entry) => entry.displayPath),
              verification: params.handoff.verification.map((entry) => ({
                command: entry.command,
                status: entry.status,
                ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
              })),
              ...(params.handoff.risks ? { risks: [...params.handoff.risks] } : {}),
            }
            handoffPathKeys = changed.map((entry) => entry.pathKey)
          }
          const requestedAssignee = params.assignee?.trim()
          const assignee =
            requestedAssignee && !(current.value.owned_paths.length > 0 && requestedAssignee === current.value.assignee)
              ? requestedAssignee
              : undefined
          const result = yield* team.updateTask(
            context.value.team.id,
            params.task_id,
            {
              status: params.status,
              ...(assignee ? { assignee } : {}),
              ...(handoff ? { handoff, handoffPathKeys } : {}),
            },
            { sessionID: ctx.sessionID, isLead: context.value.team.lead_session_id === ctx.sessionID },
          )
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
