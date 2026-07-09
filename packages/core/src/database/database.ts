export * as Database from "./database"

import { EffectDrizzleSqlite } from "@oc2-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { makeRuntime } from "../effect/runtime"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { Naming } from "../naming"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

export function path() {
  if (Flag.OC2_DB) {
    if (Flag.OC2_DB === ":memory:" || isAbsolute(Flag.OC2_DB)) return Flag.OC2_DB
    return join(Global.Path.data, Flag.OC2_DB)
  }
  const suffix =
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    Naming.truthyEnv("OC2_DISABLE_CHANNEL_DB")
      ? ""
      : `-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}`
  return join(Global.Path.data, `oc2${suffix}.db`)
}

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

const runtime = makeRuntime(Service, defaultLayer)

export function Client() {
  return runtime.runSync((service) => Effect.succeed(service.db))
}

export function use<T>(fn: (db: Interface["db"]) => Effect.Effect<T, unknown, Service>): T
export function use<T>(fn: (db: Interface["db"]) => T): T
export function use<T>(fn: (db: Interface["db"]) => T | Effect.Effect<T, unknown, Service>) {
  return runtime.runSync((service) => {
    const result = fn(service.db)
    return Effect.isEffect(result) ? result : Effect.succeed(result)
  })
}

export function transaction<T>(fn: (db: Interface["db"]) => T) {
  return use((db) =>
    db.transaction(
      () => {
        const result = fn(db)
        return Effect.isEffect(result) ? result : Effect.succeed(result)
      },
      { behavior: "immediate" },
    ),
  )
}
