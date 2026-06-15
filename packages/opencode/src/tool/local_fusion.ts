import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { SessionCompoundConfig } from "@/session/compound/config"
import { SessionCompound } from "@/session/compound/runner"
import { Session } from "@/session/session"
import type { TaskPromptOps } from "./task"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The prompt to fan out to configured local compound branches" }),
  config: Schema.optional(Schema.String).annotate({ description: "Named local compound config to load" }),
  branches: Schema.optional(Schema.Array(SessionCompoundConfig.Branch)),
  judge: Schema.optional(SessionCompoundConfig.Judge),
  synthesizer: Schema.optional(SessionCompoundConfig.Synthesizer),
})

export const LocalFusionTool = Tool.define(
  "local_fusion",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Run a local compound model orchestration: fan out one prompt to inline configured branches, judge their outputs, and synthesize one final answer.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx) =>
        Effect.gen(function* () {
          if (params.config) {
            throw new Error(
              "Named local_fusion configs are not supported yet; pass inline branches, judge, and synthesizer.",
            )
          }
          if (!params.branches || !params.judge || !params.synthesizer) {
            throw new Error("local_fusion requires inline branches, judge, and synthesizer when config is not provided.")
          }

          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!promptOps) throw new Error("local_fusion requires promptOps in ctx.extra")

          const result = yield* SessionCompound.run({
            sessionID: ctx.sessionID,
            prompt: params.prompt,
            config: SessionCompoundConfig.parse({
              branches: params.branches,
              judge: params.judge,
              synthesizer: params.synthesizer,
            }),
            agent: ctx.agent,
            promptOps,
            abort: ctx.abort,
          }).pipe(Effect.provideService(Session.Service, sessions))

          return {
            title: "Local fusion",
            output: result.output,
            metadata: result.metadata,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
