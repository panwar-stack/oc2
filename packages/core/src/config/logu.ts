export * as ConfigLogu from "./logu"

import { Schema } from "effect"

export const RoutingMode = Schema.Literals(["auto", "always", "never"])
export type RoutingMode = typeof RoutingMode.Type

export const Routing = Schema.Struct({
  mode: Schema.optional(RoutingMode),
}).annotate({ identifier: "LoguRoutingConfig" })
export type Routing = typeof Routing.Type

export const Info = Schema.Struct({
  model: Schema.optional(Schema.String),
  fusion: Schema.optional(Schema.String),
  routing: Schema.optional(Routing),
}).annotate({ identifier: "LoguConfig" })
export type Info = typeof Info.Type
