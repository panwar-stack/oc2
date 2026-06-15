export * as ConfigLocalFusion from "./local-fusion"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

const Model = Schema.String.check(Schema.isPattern(/^[^/]+\/.+$/))

export const ToolPolicy = Schema.Literals(["readonly", "none"])
export type ToolPolicy = typeof ToolPolicy.Type

export const Branch = Schema.Struct({
  model: Model,
  agent: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  toolPolicy: Schema.optional(ToolPolicy),
  timeout: Schema.optional(PositiveInt),
})
export type Branch = typeof Branch.Type

export const Judge = Schema.Struct({
  model: Model,
  prompt: Schema.optional(Schema.String),
})
export type Judge = typeof Judge.Type

export const Synthesizer = Schema.Struct({
  model: Model,
  prompt: Schema.optional(Schema.String),
})
export type Synthesizer = typeof Synthesizer.Type

export const Limits = Schema.Struct({
  timeout: Schema.optional(PositiveInt),
  maxBranches: Schema.optional(PositiveInt),
})
export type Limits = typeof Limits.Type

export const Info = Schema.Struct({
  branches: Schema.Array(Branch),
  judge: Judge,
  synthesizer: Synthesizer,
  limits: Schema.optional(Limits),
}).annotate({ identifier: "LocalFusionConfig" })
export type Info = typeof Info.Type
