import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"
import { Log } from "../util/log"

const ATTR_DB_SYSTEM_NAME = "db.system.name"
const log = Log.create({ service: "database.sqlite" })
const slowQueryInfoMs = 250
const slowQueryWarnMs = 1_000
const lockWaitWarnMs = 500

const TypeId = "~@opencode-ai/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = [], waitMs: number) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const exit = yield* Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
          const statement = native.query(query)
          // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
          statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
          try {
            return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
          } catch (cause) {
            return Effect.fail(
              new SqlError({
                reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
              }),
            )
          }
        }).pipe(Effect.exit)
        const durationMs = waitMs + (yield* Clock.currentTimeMillis) - startedAt
        yield* logQuery({
          durationMs,
          waitMs,
          sqlShape: shapeSql(query),
          rowCount: Exit.isSuccess(exit) ? exit.value.length : undefined,
          status: Exit.isSuccess(exit) ? "success" : "error",
        })
        if (Exit.isSuccess(exit)) return exit.value
        return yield* Effect.failCause(exit.cause)
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = [], waitMs: number) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const exit = yield* Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
          const statement = native.query(query)
          // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
          statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
          try {
            return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
          } catch (cause) {
            return Effect.fail(
              new SqlError({
                reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
              }),
            )
          }
        }).pipe(Effect.exit)
        const durationMs = waitMs + (yield* Clock.currentTimeMillis) - startedAt
        yield* logQuery({
          durationMs,
          waitMs,
          sqlShape: shapeSql(query),
          rowCount: Exit.isSuccess(exit) ? exit.value.length : undefined,
          status: Exit.isSuccess(exit) ? "success" : "error",
        })
        if (Exit.isSuccess(exit)) return exit.value
        return yield* Effect.failCause(exit.cause)
      })

    const makeConnection = (waitMs: number) => {
      let pendingWaitMs = waitMs
      const takeWaitMs = () => {
        const result = pendingWaitMs
        pendingWaitMs = 0
        return result
      }
      return identity<SqliteConnection>({
        execute(query, params, transformRows) {
          const waitMs = takeWaitMs()
          return transformRows ? Effect.map(run(query, params, waitMs), transformRows) : run(query, params, waitMs)
        },
        executeRaw(query, params) {
          return run(query, params, takeWaitMs())
        },
        executeValues(query, params) {
          return runValues(query, params, takeWaitMs())
        },
        executeUnprepared(query, params, transformRows) {
          return this.execute(query, params, transformRows)
        },
        executeStream() {
          return Stream.die("executeStream not implemented")
        },
        export: Effect.try({
          try: () => native.serialize(),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
            }),
        }),
        loadExtension: (path) =>
          Effect.try({
            try: () => native.loadExtension(path),
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
              }),
          }),
      })
    }

    const semaphore = yield* Semaphore.make(1)
    const acquirer = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        yield* restore(semaphore.take(1))
        const waitMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Effect.addFinalizer(() => semaphore.release(1))
        return makeConnection(waitMs)
      }),
    )
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fiber = Fiber.getCurrent()!
        const scope = Context.getUnsafe(fiber.context, Scope.Scope)
        const startedAt = yield* Clock.currentTimeMillis
        yield* restore(semaphore.take(1))
        const waitMs = (yield* Clock.currentTimeMillis) - startedAt
        yield* Scope.addFinalizer(scope, semaphore.release(1))
        return makeConnection(waitMs)
      }),
    )

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.scoped(Effect.flatMap(acquirer, (_) => _.export)),
        loadExtension: (path: string) => Effect.scoped(Effect.flatMap(acquirer, (_) => _.loadExtension(path))),
      },
    )

    return client
  })

function logQuery(input: {
  durationMs: number
  waitMs: number
  sqlShape: string
  rowCount?: number
  status: "success" | "error"
}) {
  return Effect.sync(() => {
    if (input.durationMs > slowQueryWarnMs || input.waitMs > lockWaitWarnMs) {
      log.warn("sqlite.query", input)
      return
    }
    if (input.durationMs > slowQueryInfoMs) {
      log.info("sqlite.query", input)
      return
    }
    log.debug("sqlite.query", input)
  })
}

function shapeSql(query: string) {
  return query
    .replace(/--.*(?=\r?\n|$)/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\b[xX]'(?:''|[^'])*'/g, "?")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/"(?:""|[^"])*"/g, "?")
    .replace(/`(?:``|[^`])*`/g, "?")
    .replace(/\[[^\]]*\]/g, "?")
    .replace(/\b0[xX][0-9a-fA-F]+\b/g, "?")
    .replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
}

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      if (config.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}
