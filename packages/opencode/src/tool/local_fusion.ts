import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { SessionCompoundConfig } from "@/session/compound/config"
import { SessionCompound } from "@/session/compound/runner"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import type { TaskPromptOps } from "./task"
import { ToolJsonSchema } from "./json-schema"

const ConfigParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The prompt to fan out to configured local compound branches" }),
  config: Schema.String.annotate({ description: "Named local compound config to load" }),
  branches: Schema.optionalKey(Schema.Never),
  judge: Schema.optionalKey(Schema.Never),
  synthesizer: Schema.optionalKey(Schema.Never),
})

const InlineParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The prompt to fan out to configured local compound branches" }),
  config: Schema.optionalKey(Schema.Never),
  branches: Schema.Array(SessionCompoundConfig.Branch),
  judge: SessionCompoundConfig.Judge,
  synthesizer: SessionCompoundConfig.Synthesizer,
})

const InputSchema = Schema.Union([ConfigParameters, InlineParameters])

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
    const config = yield* Config.Service
    return {
      description:
        "Run a local compound model orchestration: fan out one prompt to configured branches, judge their outputs, and synthesize one final answer.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(InputSchema),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx) =>
        Effect.gen(function* () {
          if (params.config && (params.branches || params.judge || params.synthesizer)) {
            throw new Error("local_fusion config cannot be combined with inline branches, judge, or synthesizer.")
          }
          const compound = params.config
            ? (yield* config.get()).local_fusion?.[params.config]
            : params.branches && params.judge && params.synthesizer
              ? { branches: params.branches, judge: params.judge, synthesizer: params.synthesizer }
              : undefined
          if (!compound) {
            if (params.config) throw new Error(`local_fusion config not found: ${params.config}`)
            throw new Error("local_fusion requires config or inline branches, judge, and synthesizer.")
          }

          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!promptOps) throw new Error("local_fusion requires promptOps in ctx.extra")

          const result = yield* SessionCompound.run({
            sessionID: ctx.sessionID,
            prompt: params.prompt,
            config: SessionCompoundConfig.parse(compound),
            agent: ctx.agent,
            promptOps,
            abort: ctx.abort,
          })

          return {
            title: "Local fusion",
            output: result.output,
            metadata: result.metadata,
          }
        }).pipe(Effect.provideService(Session.Service, sessions), Effect.orDie),
    }
  }),
)
