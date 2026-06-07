export * as ConfigSupervisor from "./supervisor"

import { PositiveInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { ConfigModelID } from "./model-id"

export const Mode = Schema.Literals(["off", "observe", "advise"]).annotate({ identifier: "SupervisorMode" })
export type Mode = Schema.Schema.Type<typeof Mode>

export const ReviewCadence = Schema.Literals(["step", "event", "idle"]).annotate({
  identifier: "SupervisorReviewCadence",
})
export type ReviewCadence = Schema.Schema.Type<typeof ReviewCadence>

export const Info = Schema.Struct({
  mode: Schema.optional(Mode).annotate({ description: "Supervisor mode. Defaults to advise." }),
  recommendation_model: Schema.optional(ConfigModelID.ID).annotate({
    description: "Supervisor recommendation model in provider/model format.",
  }),
  recommendation_variant: Schema.optional(Schema.String).annotate({
    description: "Supervisor recommendation model variant.",
  }),
  recommendation_timeout_ms: Schema.optional(PositiveInt),
  review_cadence: Schema.optional(ReviewCadence),
  min_review_interval_ms: Schema.optional(PositiveInt),
  max_recommendation_chars: Schema.optional(PositiveInt),
  max_repeated_command_failures: Schema.optional(PositiveInt),
  broad_diff_file_limit: Schema.optional(PositiveInt),
  sensitive_path_globs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  validation_command_patterns: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  insert_recommendations: Schema.optional(Schema.Boolean),
  max_recommendations_per_session: Schema.optional(PositiveInt),
}).annotate({ identifier: "SupervisorConfig" })
export type Info = Schema.Schema.Type<typeof Info>
