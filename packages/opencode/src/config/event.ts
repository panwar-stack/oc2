import { EventV2 } from "@oc2-ai/core/event"
import { Schema } from "effect"

export const Committed = EventV2.define({
  type: "config.reload.committed",
  schema: {
    revision: Schema.Finite,
    generation: Schema.Finite,
    scope: Schema.Literals(["project", "global"]),
    directories: Schema.Array(Schema.String),
    restartRequired: Schema.Array(Schema.String),
  },
})

export const Rejected = EventV2.define({
  type: "config.reload.rejected",
  schema: {
    path: Schema.String,
    revision: Schema.Finite,
    reason: Schema.Literals(["parse", "schema", "bootstrap", "unsupported"]),
    message: Schema.String,
  },
})

export * as ConfigEvent from "./event"
