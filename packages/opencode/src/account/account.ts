import { Effect, Layer, Option, Context } from "effect"
import { serviceUse } from "@oc2-ai/core/effect/service-use"

import { AccountRepo } from "./repo"
import type { AccountError, AccountID, Info, OrgID } from "./schema"

export {
  AccountID,
  type AccountError,
  AccountRepoError,
  AccountServiceError,
  AccountTransportError,
  Info,
  OrgID,
} from "./schema"

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountError>
  readonly list: () => Effect.Effect<Info[], AccountError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Account") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, AccountRepo.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repo = yield* AccountRepo.Service

    return Service.of({
      active: repo.active,
      list: repo.list,
      remove: repo.remove,
      use: repo.use,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AccountRepo.defaultLayer))

export * as Account from "./account"
