import { afterEach, describe, expect, test } from "bun:test"
import { Context, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as Log from "@oc2-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, reloadTestInstance, tmpdir, withTestInstance } from "../fixture/fixture"

void Log.init({ print: false })

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has("x-oc2-directory")) headers.set("x-oc2-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  location: Schema.Struct({
    directory: Schema.String,
    project: Schema.Struct({ id: Schema.String, directory: Schema.String }),
  }),
  data: Schema.Unknown,
})

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const value = await reader.read()
  if (value.done) throw new Error("event stream closed")
  return Schema.decodeUnknownSync(Event)(JSON.parse(new TextDecoder().decode(value.value).replace(/^data: /, "")))
}

async function readEventType(reader: ReadableStreamDefaultReader<Uint8Array>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; generation: number; revision: number; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
      const v1 = await withTestInstance({ directory: tmp.path, fn: (ctx) => ctx })
      expect(body.location.generation).toBe(v1.generation)
      expect(body.location.revision).toBe(v1.revision ?? 0)
    }
  })

  test("workspace variants retain the committed V1 revision while a candidate fails", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await request("/api/command", tmp.path, { headers: { "x-oc2-workspace": "wrk_a" } })
    expect(first.status).toBe(200)
    const active = (await first.json()) as {
      location: { workspaceID?: string; generation: number; revision: number }
      data: unknown
    }
    expect(active.location.workspaceID).toBe("wrk_a")
    const v1 = await withTestInstance({ directory: tmp.path, fn: (ctx) => ctx })
    expect(active.location).toMatchObject({ generation: v1.generation, revision: v1.revision })

    await fs.writeFile(path.join(tmp.path, "oc2.json"), "{ invalid")
    await expect(reloadTestInstance({ directory: tmp.path })).rejects.toBeDefined()

    const retained = await request("/api/command", tmp.path, { headers: { "x-oc2-workspace": "wrk_b" } })
    expect(retained.status).toBe(200)
    expect((await retained.json()) as unknown).toMatchObject({
      location: {
        workspaceID: "wrk_b",
        generation: active.location.generation,
        revision: active.location.revision,
      },
      data: active.data,
    })
  })

  test("native routes retain the old snapshot until an in-flight candidate commits", async () => {
    await using tmp = await tmpdir({ git: true })
    const plugin = path.join(tmp.path, "barrier-plugin.ts")
    const config = path.join(tmp.path, "oc2.json")
    await fs.writeFile(
      plugin,
      [
        "export default async () => ({",
        "  config: async (value) => {",
        '    if (value.username !== "candidate") return',
        "    globalThis.__oc2CandidateStarted.resolve()",
        "    await globalThis.__oc2CandidateRelease.promise",
        "  },",
        "})",
      ].join("\n"),
    )
    await fs.writeFile(
      config,
      JSON.stringify({ plugin: [pathToFileURL(plugin).href], username: "active" }),
    )
    const first = await request("/api/command", tmp.path)
    const active = (await first.json()) as { location: { generation: number; revision: number } }

    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const globals = globalThis as typeof globalThis & {
      __oc2CandidateStarted?: PromiseWithResolvers<void>
      __oc2CandidateRelease?: PromiseWithResolvers<void>
    }
    globals.__oc2CandidateStarted = started
    globals.__oc2CandidateRelease = release
    try {
      await fs.writeFile(
        config,
        JSON.stringify({ plugin: [pathToFileURL(plugin).href], username: "candidate" }),
      )
      const reload = reloadTestInstance({ directory: tmp.path })
      await started.promise

      const during = await request("/api/command", tmp.path)
      expect((await during.json()) as unknown).toMatchObject({ location: active.location })

      release.resolve()
      const committed = await reload
      const after = await request("/api/command", tmp.path)
      expect((await after.json()) as unknown).toMatchObject({
        location: { generation: committed.generation, revision: committed.revision },
      })
      expect(committed.generation).not.toBe(active.location.generation)
    } finally {
      release.resolve()
      delete globals.__oc2CandidateStarted
      delete globals.__oc2CandidateRelease
    }
  })

  test("uses x-oc2-directory location header", async () => {
    await using headerDir = await tmpdir({ git: true })
    await using fallback = await tmpdir({ git: true })

    const response = await request("/api/command", fallback.path, {
      headers: { "x-oc2-directory": headerDir.path },
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { location: { directory: string } }).location.directory).toBe(headerDir.path)
  })

  test("streams native EventV2 payloads with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/event", tmp.path)
    const reader = response.body!.getReader()
    expect((await readEvent(reader)).type).toBe("server.connected")

    const created = await request("/session", tmp.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: tmp.path, project: { directory: tmp.path } },
      data: { sessionID: expect.any(String) },
    })
    await reader.cancel()
  })
})
