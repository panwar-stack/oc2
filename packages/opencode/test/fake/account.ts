import { Effect, Layer, Option } from "effect"
import { Account } from "../../src/account/account"

export const empty = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  use: () => Effect.void,
})

export * as AccountTest from "./account"
