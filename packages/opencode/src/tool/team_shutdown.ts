import * as Tool from "./tool"
import DESCRIPTION from "./team_shutdown.txt"
import { Team } from "@/team/team"
import { Config } from "@/config/config"
import { Cause, Effect, Exit, Option, Schema } from "effect"

const Parameters = Schema.Struct({
  force: Schema.optional(Schema.Boolean).annotate({
    description:
      "Force shutdown. Lead-only and requires a nonblank reason. Bypasses the final-report checkpoint for a wedged or explicitly abandoned team. This is an escape hatch, not the normal completion path.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Nonblank reason required when force is true. Recorded as a deterministic forced-shutdown event.",
  }),
})

export const TeamShutdownTool = Tool.define<
  typeof Parameters,
  Record<string, unknown>,
  Team.Service | Config.Service
>(
  "team_shutdown",
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
            return { title: "Team Shutdown", output: "Agent teams disabled.", metadata: {} }
          const context = yield* team.getContext(ctx.sessionID)
          if (Option.isNone(context)) return { title: "Team Shutdown", output: "No active team.", metadata: {} }
          const info = context.value.team
          const exit = yield* team
            .shutdown({
              teamID: info.id,
              sessionID: ctx.sessionID,
              force: params.force,
              reason: params.reason,
            })
            .pipe(Effect.exit)
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause)
            if (error instanceof Team.ShutdownNotAuthorized) {
              return {
                title: "Team Shutdown Failed",
                output: "Only the team lead can shut down a team.",
                metadata: {},
              }
            }
            if (error instanceof Team.ShutdownAlreadyClosed) {
              return { title: "Team Shutdown Failed", output: error.message, metadata: {} }
            }
            if (error instanceof Team.ShutdownFinalReportRequired) {
              return { title: "Team Shutdown Rejected", output: error.message, metadata: {} }
            }
            if (error instanceof Team.ShutdownReasonRequired) {
              return { title: "Team Shutdown Rejected", output: error.message, metadata: {} }
            }
            return yield* Effect.die(error)
          }
          return {
            title: "Team Shut Down",
            output: `Team shut down successfully.\n${JSON.stringify(exit.value, null, 2)}`,
            metadata: { ...exit.value },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
