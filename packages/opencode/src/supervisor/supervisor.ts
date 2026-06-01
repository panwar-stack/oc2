import { BusEvent } from "@/bus/bus-event"
import type { Config } from "@/config/config"
import { ConfigModelID } from "@/config/model-id"
import { ConfigSupervisor } from "@/config/supervisor"
import { SessionID } from "@/session/schema"
import { NonNegativeInt, optionalOmitUndefined, PositiveInt } from "@opencode-ai/core/schema"
import { Schema, Types } from "effect"

export const Mode = ConfigSupervisor.Mode
export type Mode = ConfigSupervisor.Mode
export const ReviewCadence = ConfigSupervisor.ReviewCadence
export type ReviewCadence = ConfigSupervisor.ReviewCadence

const SettingsFields = {
  mode: optionalOmitUndefined(Mode),
  recommendation_model: optionalOmitUndefined(ConfigModelID),
  recommendation_variant: optionalOmitUndefined(Schema.String),
  recommendation_timeout_ms: optionalOmitUndefined(PositiveInt),
  review_cadence: optionalOmitUndefined(ReviewCadence),
  min_review_interval_ms: optionalOmitUndefined(PositiveInt),
  max_recommendation_chars: optionalOmitUndefined(PositiveInt),
  max_repeated_command_failures: optionalOmitUndefined(PositiveInt),
  broad_diff_file_limit: optionalOmitUndefined(PositiveInt),
  sensitive_path_globs: optionalOmitUndefined(Schema.Array(Schema.String)),
  validation_command_patterns: optionalOmitUndefined(Schema.Array(Schema.String)),
  insert_recommendations: optionalOmitUndefined(Schema.Boolean),
  max_recommendations_per_session: optionalOmitUndefined(PositiveInt),
} as const

export const SessionSettings = Schema.Struct({
  ...SettingsFields,
  updatedAt: NonNegativeInt,
}).annotate({ identifier: "SupervisorSessionSettings" })
export type SessionSettings = Types.DeepMutable<Schema.Schema.Type<typeof SessionSettings>>

export const SettingsPatch = Schema.Struct({
  reset: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.NullOr(Mode)),
  recommendation_model: Schema.optional(Schema.NullOr(ConfigModelID)),
  recommendation_variant: Schema.optional(Schema.NullOr(Schema.String)),
  recommendation_timeout_ms: Schema.optional(Schema.NullOr(PositiveInt)),
  review_cadence: Schema.optional(Schema.NullOr(ReviewCadence)),
  min_review_interval_ms: Schema.optional(Schema.NullOr(PositiveInt)),
  max_recommendation_chars: Schema.optional(Schema.NullOr(PositiveInt)),
  max_repeated_command_failures: Schema.optional(Schema.NullOr(PositiveInt)),
  broad_diff_file_limit: Schema.optional(Schema.NullOr(PositiveInt)),
  sensitive_path_globs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  validation_command_patterns: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  insert_recommendations: Schema.optional(Schema.NullOr(Schema.Boolean)),
  max_recommendations_per_session: Schema.optional(Schema.NullOr(PositiveInt)),
}).annotate({ identifier: "SupervisorSettingsPatch" })
export type SettingsPatch = Schema.Schema.Type<typeof SettingsPatch>

export const EffectiveConfig = Schema.Struct({
  mode: Mode,
  recommendation_model: optionalOmitUndefined(ConfigModelID),
  recommendation_variant: optionalOmitUndefined(Schema.String),
  recommendation_timeout_ms: PositiveInt,
  review_cadence: ReviewCadence,
  min_review_interval_ms: PositiveInt,
  max_recommendation_chars: PositiveInt,
  max_repeated_command_failures: PositiveInt,
  broad_diff_file_limit: PositiveInt,
  sensitive_path_globs: Schema.Array(Schema.String),
  validation_command_patterns: Schema.Array(Schema.String),
  insert_recommendations: Schema.Boolean,
  max_recommendations_per_session: PositiveInt,
}).annotate({ identifier: "SupervisorEffectiveConfig" })
export type EffectiveConfig = Types.DeepMutable<Schema.Schema.Type<typeof EffectiveConfig>>

export const Status = Schema.Literals(["on_track", "uncertain", "drifting", "blocked", "high_risk"]).annotate({
  identifier: "SupervisorStatus",
})
export const Action = Schema.Literals(["nudge", "ask", "warn"]).annotate({ identifier: "SupervisorAction" })
export const Trigger = Schema.Literals([
  "missing_reproduction",
  "repeated_command_failure",
  "missing_validation",
  "scope_expansion",
  "risky_edit",
  "wrong_localization",
  "evidence_mismatch",
  "validation_mismatch",
  "premature_success",
  "less_optimal_action",
  "trajectory_drift",
]).annotate({ identifier: "SupervisorTrigger" })

export const Risk = Schema.Struct({
  trigger: Trigger,
  severity: Schema.Literals(["info", "warning", "high"]),
  evidence: Schema.Array(Schema.String),
  message: Schema.String,
}).annotate({ identifier: "SupervisorRisk" })
export type Risk = Types.DeepMutable<Schema.Schema.Type<typeof Risk>>

export const ActivityType = Schema.Literals(["file", "command", "validation", "risk", "recommendation", "settings"]).annotate({
  identifier: "SupervisorActivityType",
})
export type ActivityType = Schema.Schema.Type<typeof ActivityType>

export const ActivityMetadata = Schema.Struct({
  file: optionalOmitUndefined(Schema.String),
  command: optionalOmitUndefined(Schema.String),
  exitCode: optionalOmitUndefined(Schema.Number),
  validation: optionalOmitUndefined(Schema.Boolean),
  repeatedFailureCount: optionalOmitUndefined(NonNegativeInt),
  trigger: optionalOmitUndefined(Trigger),
  action: optionalOmitUndefined(Action),
  inserted: optionalOmitUndefined(Schema.Boolean),
}).annotate({ identifier: "SupervisorActivityMetadata" })
export type ActivityMetadata = Types.DeepMutable<Schema.Schema.Type<typeof ActivityMetadata>>

export const Activity = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  time: NonNegativeInt,
  type: ActivityType,
  severity: optionalOmitUndefined(Schema.Literals(["info", "warning", "high"])),
  title: Schema.String,
  message: optionalOmitUndefined(Schema.String),
  evidence: Schema.Array(Schema.String),
  metadata: optionalOmitUndefined(ActivityMetadata),
}).annotate({ identifier: "SupervisorActivity" })
export type Activity = Types.DeepMutable<Schema.Schema.Type<typeof Activity>>

export const Recommendation = Schema.Struct({
  source: Schema.Literal("model"),
  action: Action,
  trigger: Trigger,
  message: Schema.String,
  evidence: Schema.Array(Schema.String),
  model: optionalOmitUndefined(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: optionalOmitUndefined(Schema.String),
    }),
  ),
  inserted: optionalOmitUndefined(
    Schema.Struct({
      messageID: optionalOmitUndefined(Schema.String),
      partID: optionalOmitUndefined(Schema.String),
      insertedAt: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "SupervisorRecommendation" })
export type Recommendation = Types.DeepMutable<Schema.Schema.Type<typeof Recommendation>>

export const RecommendationInput = Schema.Struct({
  sessionID: SessionID,
  status: Status,
  summary: optionalOmitUndefined(Schema.String),
  supervisorModel: optionalOmitUndefined(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      variant: optionalOmitUndefined(Schema.String),
    }),
  ),
  allowedTriggers: Schema.Array(Trigger),
  triggeredRisks: Schema.Array(Risk),
  filesTouched: Schema.Array(Schema.String),
  commandsRun: StateCommandArray(),
  validationsRun: Schema.Array(Schema.String),
  risks: Schema.Array(Risk),
  recentEvents: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      target: optionalOmitUndefined(Schema.String),
      outcome: optionalOmitUndefined(Schema.Literals(["success", "failure", "unknown"])),
    }),
  ),
  reviewReason: Schema.Literals(["cadence", "deterministic_trigger", "session_idle"]),
  maxRecommendationChars: PositiveInt,
}).annotate({ identifier: "SupervisorRecommendationInput" })
export type RecommendationInput = Types.DeepMutable<Schema.Schema.Type<typeof RecommendationInput>>

export const RecommendationOutput = Schema.Struct({
  recommend: Schema.Boolean,
  action: Action,
  trigger: Trigger,
  message: Schema.String,
  evidence: Schema.Array(Schema.String),
}).annotate({ identifier: "SupervisorRecommendationOutput" })
export type RecommendationOutput = Types.DeepMutable<Schema.Schema.Type<typeof RecommendationOutput>>

export const Report = Schema.Struct({
  sessionID: SessionID,
  status: Status,
  summary: optionalOmitUndefined(Schema.String),
  filesTouched: Schema.Array(Schema.String),
  commandsRun: StateCommandArray(),
  validationsRun: Schema.Array(Schema.String),
  risks: Schema.Array(Risk),
  recommendations: Schema.Array(Recommendation),
  evidence: Schema.Array(Schema.String),
  generatedAt: NonNegativeInt,
}).annotate({ identifier: "SupervisorReport" })
export type Report = Types.DeepMutable<Schema.Schema.Type<typeof Report>>

export const State = Schema.Struct({
  sessionID: SessionID,
  mode: Mode,
  config: Schema.Struct({
    modeSource: Schema.Literals(["global", "session"]),
    globalMode: Mode,
    session: optionalOmitUndefined(SessionSettings),
    effective: EffectiveConfig,
  }),
  status: Status,
  summary: optionalOmitUndefined(Schema.String),
  filesTouched: Schema.Array(Schema.String),
  commandsRun: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      exitCode: optionalOmitUndefined(Schema.Number),
      validation: Schema.Boolean,
      repeatedFailureCount: NonNegativeInt,
    }),
  ),
  validationsRun: Schema.Array(Schema.String),
  risks: Schema.Array(Risk),
  recommendation: optionalOmitUndefined(Recommendation),
  updatedAt: NonNegativeInt,
}).annotate({ identifier: "SupervisorState" })
export type State = Types.DeepMutable<Schema.Schema.Type<typeof State>>

export const Event = {
  SettingsUpdated: BusEvent.define(
    "supervisor.settings.updated",
    Schema.Struct({
      sessionID: SessionID,
      settings: optionalOmitUndefined(SessionSettings),
      state: State,
    }),
  ),
  StateUpdated: BusEvent.define(
    "supervisor.state.updated",
    Schema.Struct({
      sessionID: SessionID,
      state: State,
    }),
  ),
  RecommendationCreated: BusEvent.define(
    "supervisor.recommendation.created",
    Schema.Struct({
      sessionID: SessionID,
      recommendation: Recommendation,
      state: State,
    }),
  ),
  ReportCompleted: BusEvent.define(
    "supervisor.report.completed",
    Schema.Struct({
      sessionID: SessionID,
      report: Report,
    }),
  ),
}

function StateCommandArray() {
  return Schema.Array(
    Schema.Struct({
      command: Schema.String,
      exitCode: optionalOmitUndefined(Schema.Number),
      validation: Schema.Boolean,
      repeatedFailureCount: NonNegativeInt,
    }),
  )
}

export const defaults = {
  mode: "off",
  recommendation_timeout_ms: 15000,
  review_cadence: "step",
  min_review_interval_ms: 10000,
  max_recommendation_chars: 800,
  max_repeated_command_failures: 3,
  broad_diff_file_limit: 5,
  sensitive_path_globs: [
    "**/auth/**",
    "**/authorization/**",
    "**/permission/**",
    "**/permissions/**",
    "**/migration/**",
    "**/migrations/**",
    "**/*delete*",
    "**/*deletion*",
    "**/*encrypt*",
    "**/*decrypt*",
    "**/billing/**",
    "**/deployment/**",
    "**/deploy/**",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/bun.lock",
    "**/bun.lockb",
  ],
  validation_command_patterns: [
    "bun test",
    "bun typecheck",
    "npm test",
    "pnpm test",
    "yarn test",
    "go test",
    "cargo test",
    "pytest",
    "vitest",
    "jest",
    "tsc",
    "eslint",
  ],
  insert_recommendations: true,
  max_recommendations_per_session: 8,
} satisfies Omit<EffectiveConfig, "recommendation_model" | "recommendation_variant">

export function resolveEffectiveConfig(input: { config: Config.Info; session?: SessionSettings }): EffectiveConfig {
  return {
    ...defaults,
    ...input.config.supervisor,
    ...input.session,
    recommendation_model:
      input.session?.recommendation_model ??
      input.config.supervisor?.recommendation_model ??
      input.config.model ??
      input.config.small_model,
    recommendation_variant: input.session?.recommendation_variant ?? input.config.supervisor?.recommendation_variant,
  }
}

export function state(input: { sessionID: SessionID; config: Config.Info; session?: SessionSettings }): State {
  const globalMode = input.config.supervisor?.mode ?? defaults.mode
  const effective = resolveEffectiveConfig(input)
  return {
    sessionID: input.sessionID,
    mode: effective.mode,
    config: {
      modeSource: input.session?.mode === undefined ? "global" : "session",
      globalMode,
      session: input.session,
      effective,
    },
    status: "on_track",
    filesTouched: [],
    commandsRun: [],
    validationsRun: [],
    risks: [],
    updatedAt: input.session?.updatedAt ?? Date.now(),
  }
}

export function applySettingsPatch(input: {
  current?: SessionSettings
  patch: SettingsPatch
  updatedAt: number
}): SessionSettings | undefined {
  const next: Partial<Omit<SessionSettings, "updatedAt">> = input.patch.reset
    ? {}
    : Object.fromEntries(Object.entries(input.current ?? {}).filter(([key]) => key !== "updatedAt"))

  for (const key of Object.keys(SettingsFields) as (keyof typeof SettingsFields)[]) {
    if (!(key in input.patch)) continue
    if (input.patch[key] === null) delete next[key]
    else if (input.patch[key] !== undefined) Object.assign(next, { [key]: input.patch[key] })
  }

  if (Object.keys(next).length === 0) return undefined
  return { ...next, updatedAt: input.updatedAt } as SessionSettings
}

export * as Supervisor from "./supervisor"
