import { Config } from "@/config/config"
import { emptyConsoleState } from "@oc2-ai/core/v1/config/console-state"
import { Effect, Layer } from "effect"

export function make(overrides: Partial<Config.Interface> = {}) {
  const snapshot = Object.freeze({
    revision: 0,
    globalEpoch: 0,
    fingerprint: "",
    dependencies: Object.freeze([]),
    config: Object.freeze({}),
    directories: Object.freeze([]),
  })
  return Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
    commit: () => Effect.succeed(snapshot),
    snapshot: () => Effect.succeed(snapshot),
    ...overrides,
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
