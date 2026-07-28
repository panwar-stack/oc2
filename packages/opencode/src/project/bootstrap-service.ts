import { Context, Effect, Scope } from "effect"

export interface Interface {
  readonly run: Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
