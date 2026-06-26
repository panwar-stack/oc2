export * as ConfigFugu from "./fugu"

import { Schema } from "effect"

const Model = Schema.String.check(Schema.isPattern(/^[^/]+\/.+$/))

const Target = Schema.Struct({
  model: Model,
  variant: Schema.optional(Schema.String),
})

export const Branch = Target
export type Branch = typeof Branch.Type

export const Judge = Target
export type Judge = typeof Judge.Type

export const Synthesizer = Target
export type Synthesizer = typeof Synthesizer.Type

export const Info = Schema.Struct({
  branches: Schema.optional(Schema.Array(Branch)),
  judge: Schema.optional(Judge),
  synthesizer: Schema.optional(Synthesizer),
}).annotate({ identifier: "FuguConfig" })
export type Info = typeof Info.Type
