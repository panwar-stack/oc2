import { afterEach, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { InstanceLayer } from "../../src/project/instance-layer"
import { InstanceStore } from "../../src/project/instance-store"
import { warmSearch } from "../../src/project/bootstrap"
import { Config } from "../../src/config/config"
import { fingerprint } from "../../src/config/hot-reload"
import { InstanceRef } from "../../src/effect/instance-ref"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(Layer.mergeAll(InstanceLayer.layer, CrossSpawnSpawner.defaultLayer))
const configIt = testEffect(
  Layer.mergeAll(InstanceLayer.layer, CrossSpawnSpawner.defaultLayer, Config.defaultLayer),
)

it.effect("candidate search warm failures cross the readiness barrier", () =>
  Effect.gen(function* () {
    const search = { warm: () => Effect.die(new Error("warm failed")) }
    const candidate = yield* warmSearch(
      { directory: "/candidate", generation: 2, candidate: true },
      search,
    ).pipe(Effect.exit)
    expect(Exit.isFailure(candidate)).toBe(true)
  }),
)

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. The plugin config hook writes a marker file; the test
// bodies deliberately avoid Plugin/config directly. The marker only
// appears if InstanceBootstrap ran at the instance boundary.
//
// The boundaries below are transport-agnostic and stay.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        '    await Bun.write(MARKER, "ran")',
        "  },",
        "})",
        "",
      ].join("\n"),
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "oc2.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(pluginFile).href],
      }),
    ),
  )
  return { directory: dir, marker }
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) =>
      event.payload.type === "server.instance.disposed" && event.directory === directory && event.generation !== undefined,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap runs InstanceBootstrap before callback", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture

    yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped({ startImmediately: true }))

    const exit = yield* Effect.promise(() =>
      cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory: tmp.directory })

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("failed candidate plugin hooks dispose candidate resources exactly once", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const disposed = path.join(dir, "disposed-count")
    const pluginFile = path.join(dir, "cleanup-plugin.ts")
    yield* Effect.promise(() =>
      Bun.write(
        pluginFile,
        [
          `const DISPOSED = ${JSON.stringify(disposed)}`,
          "export default async () => ({",
          '  config: async (config) => { if (config.username === "reject") throw new Error("reject hook") },',
          "  dispose: async () => {",
          '    const file = Bun.file(DISPOSED)',
          '    const count = (await file.exists()) ? Number(await file.text()) : 0',
          '    await Bun.write(DISPOSED, String(count + 1))',
          "  },",
          "})",
          "",
        ].join("\n"),
      ),
    )
    const configFile = path.join(dir, "oc2.json")
    yield* Effect.promise(() =>
      Bun.write(configFile, JSON.stringify({ plugin: [pathToFileURL(pluginFile).href], username: "active" })),
    )
    const store = yield* InstanceStore.Service
    const active = yield* store.load({ directory: dir, revision: 1 })

    yield* Effect.promise(() =>
      Bun.write(configFile, JSON.stringify({ plugin: [pathToFileURL(pluginFile).href], username: "reject" })),
    )
    const rejected = yield* store.reload({ directory: dir, revision: 2 }).pipe(Effect.exit)

    expect(Exit.isFailure(rejected)).toBe(true)
    expect(yield* store.load({ directory: dir })).toBe(active)
    expect(yield* Effect.promise(() => Bun.file(disposed).text())).toBe("1")
  }),
)

configIt.live("commits plugin-mutated config and retains the frozen LKG after hook failure", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const pluginFile = path.join(dir, "mutating-plugin.ts")
    const configFile = path.join(dir, "oc2.json")
    yield* Effect.promise(() =>
      Bun.write(
        pluginFile,
        [
          "export default async () => ({",
          "  config: async (config) => {",
          '    config.model = `provider/${config.username}`',
          '    config.provider = { mutated: { options: { source: config.username } } }',
          '    if (config.username === "reject") throw new Error("reject after mutation")',
          "  },",
          "})",
          "",
        ].join("\n"),
      ),
    )
    const write = (username: string) =>
      Effect.promise(() =>
        Bun.write(configFile, JSON.stringify({ plugin: [pathToFileURL(pluginFile).href], username })),
      )
    const store = yield* InstanceStore.Service
    const config = yield* Config.Service

    yield* write("active")
    const active = yield* store.load({ directory: dir, revision: 1 })
    yield* write("mutated")
    const committed = yield* store.reload({ directory: dir, revision: 2 })
    const info = yield* config.get().pipe(Effect.provideService(InstanceRef, committed))
    const snapshot = yield* config.snapshot().pipe(Effect.provideService(InstanceRef, committed))

    expect(info.model).toBe("provider/mutated")
    expect(info.provider?.mutated?.options).toEqual({ source: "mutated" })
    expect(committed.fingerprint).toBe(fingerprint(info))
    expect(committed.fingerprint).not.toBe(active.fingerprint)
    expect(JSON.stringify(committed.coreConfigEntries)).toContain("provider/mutated")
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.config)).toBe(true)
    expect(Object.isFrozen((snapshot.config as Config.Info).provider?.mutated?.options)).toBe(true)
    expect(Object.isFrozen(committed.coreConfigEntries)).toBe(true)
    expect(Object.isFrozen(committed.coreConfigEntries?.[0])).toBe(true)
    expect(Object.isFrozen(committed.effectiveConfig)).toBe(true)

    yield* write("reject")
    expect(Exit.isFailure(yield* store.reload({ directory: dir, revision: 3 }).pipe(Effect.exit))).toBe(true)
    expect(yield* store.load({ directory: dir })).toBe(committed)
    const retained = yield* config.get().pipe(Effect.provideService(InstanceRef, committed))
    expect(retained.model).toBe("provider/mutated")
    expect(retained.provider?.mutated?.options).toEqual({ source: "mutated" })
  }),
)
