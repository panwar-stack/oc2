import { Context, Effect, Layer } from "effect"
import { Location } from "./location"

export * as LocationAdmission from "./location-admission"

export interface Interface {
  readonly provide: <A, E, R>(
    ref: Location.Ref,
    use: (committed: Location.Ref) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationAdmission") {}

/** Standalone core/server compatibility when no generation-owning host is present. */
export const defaultLayer = Layer.succeed(Service, Service.of({ provide: (ref, use) => use(ref) }))
