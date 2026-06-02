export * as ConfigModelID from "./model-id"

import { Schema } from "effect"

export const ID = Schema.String.pipe(Schema.brand("ConfigModelID"))
export type ID = typeof ID.Type
