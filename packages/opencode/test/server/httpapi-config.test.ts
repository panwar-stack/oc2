import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Server } from "../../src/server/server"
import * as Log from "@oc2-ai/core/util/log"
import { Effect, Fiber, Option } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { Global } from "@oc2-ai/core/global"
import { ConfigParse } from "@/config/parse"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "patches only the selected project source, disposes, and reloads from disk",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const direct = path.join(tmp.path, "oc2.json")
      const selected = path.join(tmp.path, ".oc2", "oc2.jsonc")
      const directBefore = yield* Effect.promise(() => Bun.file(direct).text())
      const selectedBefore = `{
  // selected project source
  "$schema": "project-schema",
  "model": "test/model"
}`
      yield* Effect.promise(() =>
        fs.mkdir(path.dirname(selected), { recursive: true }).then(() => Bun.write(selected, selectedBefore)),
      )
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-oc2-directory": tmp.path,
            },
            body: JSON.stringify({ $schema: "request-schema", username: "patched-user" }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(direct).text())).toBe(directBefore)
      const selectedAfter = yield* Effect.promise(() => Bun.file(selected).text())
      expect(selectedAfter).toContain("// selected project source")
      expect(ConfigParse.jsonc(selectedAfter, selected)).toMatchObject({
        $schema: "project-schema",
        model: "test/model",
        username: "patched-user",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).exists())).toBe(false)

      const reloaded = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers: { "x-oc2-directory": tmp.path } })),
      )
      expect(reloaded.status).toBe(200)
      expect(yield* Effect.promise(() => reloaded.json())).toMatchObject({ username: "patched-user" })
    }),
  )

  it.live(
    "patches global JSONC only, disposes active instances, and reloads from disk",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const global = yield* tmpdirEffect(undefined)
      const json = path.join(global.path, "oc2.json")
      const jsonc = path.join(global.path, "oc2.jsonc")
      const jsonBefore = JSON.stringify({ username: "json-user", model: "json/model" })
      const jsoncBefore = `{
  // selected global source
  "$schema": "global-schema",
  "username": "jsonc-user"
}`
      yield* Effect.promise(() => Promise.all([Bun.write(json, jsonBefore), Bun.write(jsonc, jsoncBefore)]))

      yield* withGlobalConfigDir(
        global.path,
        Effect.gen(function* () {
          const initial = yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-oc2-directory": tmp.path } })),
          )
          expect(initial.status).toBe(200)
          const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

          const response = yield* Effect.promise(() =>
            Promise.resolve(
              app().request("/global/config", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ $schema: "request-schema", username: "global-patched" }),
              }),
            ),
          )

          expect(response.status).toBe(200)
          yield* Fiber.join(disposed)
          expect(yield* Effect.promise(() => Bun.file(json).text())).toBe(jsonBefore)
          const jsoncAfter = yield* Effect.promise(() => Bun.file(jsonc).text())
          expect(jsoncAfter).toContain("// selected global source")
          expect(ConfigParse.jsonc(jsoncAfter, jsonc)).toMatchObject({
            $schema: "global-schema",
            username: "global-patched",
          })

          const reloaded = yield* Effect.promise(() => Promise.resolve(app().request("/global/config")))
          expect(reloaded.status).toBe(200)
          expect(yield* Effect.promise(() => reloaded.json())).toMatchObject({
            model: "json/model",
            username: "global-patched",
          })
        }),
      )
    }),
  )

  it.live(
    "does not rewrite or dispose for a no-op global config patch",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const global = yield* tmpdirEffect(undefined)
      const file = path.join(global.path, "oc2.jsonc")
      const before = `{
  // unchanged
  "username": "same-user"
}`
      yield* Effect.promise(() => Bun.write(file, before))

      yield* withGlobalConfigDir(
        global.path,
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-oc2-directory": tmp.path } })),
          )
          const disposed = yield* waitDisposed(tmp.path).pipe(
            Effect.exit,
            Effect.forkScoped({ startImmediately: true }),
          )

          const response = yield* Effect.promise(() =>
            Promise.resolve(
              app().request("/global/config", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: "same-user" }),
              }),
            ),
          )

          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
          expect(Option.isNone(yield* Fiber.join(disposed).pipe(Effect.timeoutOption("100 millis")))).toBe(true)
          yield* Fiber.interrupt(disposed)
        }),
      )
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-oc2-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
