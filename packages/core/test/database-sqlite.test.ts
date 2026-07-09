import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "@oc2-ai/core/util/log"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer as sqliteLayer } from "#sqlite"
import { Database } from "@oc2-ai/core/database/database"
import { Global } from "@oc2-ai/core/global"
import fs from "fs/promises"
import os from "os"
import path from "path"

afterEach(() => {
  mock.restore()
})

describe("sqlite logging", () => {
  test("redacts SQL literals and parameters from sqlShape", async () => {
    const logger = Log.create({ service: "database.sqlite" })
    const debug = spyOn(logger, "debug").mockImplementation(() => {})
    const info = spyOn(logger, "info").mockImplementation(() => {})
    const warn = spyOn(logger, "warn").mockImplementation(() => {})

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* SqlClient
        yield* db.unsafe("SELECT 'literal-secret' AS value, ? AS bound, 123 AS count, 0xdeadbeef AS hex", [
          "param-secret",
        ])
      }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )

    expect(debug).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(debug.mock.calls[0]?.[0]).toBe("sqlite.query")
    const fields = debug.mock.calls[0]?.[1]
    expect(fields).toMatchObject({
      sqlShape: "SELECT ? AS value, ? AS bound, ? AS count, ? AS hex",
      rowCount: 1,
      status: "success",
    })
    expect(fields?.durationMs).toBeGreaterThanOrEqual(0)
    expect(fields?.waitMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(debug.mock.calls[0])).not.toContain("literal-secret")
    expect(JSON.stringify(debug.mock.calls[0])).not.toContain("param-secret")
    expect(JSON.stringify(debug.mock.calls[0])).not.toContain("deadbeef")
  })
})

describe("database path", () => {
  test("uses oc2 database names for fresh selected data roots", async () => {
    await withDatabaseRoots(async ({ next }) => {
      expect(Database.path()).toBe(path.join(next, "oc2.db"))
    })
  })

})

async function withDatabaseRoots(fn: (roots: { next: string }) => Promise<void>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc2-db-test-"))
  const previous = {
    pathData: Global.Path.data,
    disableChannel: process.env.OC2_DISABLE_CHANNEL_DB,
  }
  const next = path.join(tmp, "oc2")
  await fs.mkdir(next, { recursive: true })
  process.env.OC2_DISABLE_CHANNEL_DB = "1"
  ;(Global.Path as { data: string }).data = next
  try {
    await fn({ next })
  } finally {
    ;(Global.Path as { data: string }).data = previous.pathData
    if (previous.disableChannel === undefined) delete process.env.OC2_DISABLE_CHANNEL_DB
    else process.env.OC2_DISABLE_CHANNEL_DB = previous.disableChannel
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
