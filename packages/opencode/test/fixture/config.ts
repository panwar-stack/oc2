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
    update: () => Effect.succeed({ fileChanged: false, path: "/config", content: "{}", digest: "digest" }),
    updateAt: () => Effect.succeed({ fileChanged: false, path: "/config", content: "{}", digest: "digest" }),
    updatePath: () => Effect.succeed("/config"),
    updateGlobalPath: () => Effect.succeed("/config"),
    updateGlobal: (config) =>
      Effect.succeed({ info: config, fileChanged: false, path: "/config", content: "{}", digest: "digest" }),
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
