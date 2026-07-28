import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import * as Log from "@oc2-ai/core/util/log"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceStore } from "../../src/project/instance-store"
import { EventV2 } from "@oc2-ai/core/event"
import { Location } from "@oc2-ai/core/location"
import { Project } from "@oc2-ai/core/project"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

void Log.init({ print: false })

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const GenerationEvent = EventV2.define({ type: "test.generation", schema: { value: Schema.String } })

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({
          type: "server.connected",
          properties: { generation: expect.any(Number) },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "isolates normal events by instance generation",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const store = yield* InstanceStore.Service
        const instance = yield* store.load({ directory })
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected" })
        const location = (generation: number) =>
          new Location.Info({
            directory: AbsolutePath.make(directory),
            generation,
            project: {
              id: Project.ID.make(instance.project.id),
              directory: AbsolutePath.make(instance.worktree),
            },
          })

        const publish = (value: string, generation: number) =>
          Effect.promise(() =>
            AppRuntime.runPromise(
              Effect.flatMap(EventV2Bridge.Service, (events) =>
                events.publish(GenerationEvent, { value }, { location: location(generation) }),
              ),
            ),
          )
        yield* publish("old", instance.generation - 1)
        const stale = yield* Queue.take(reader).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.succeed(false) }),
        )
        expect(stale).toBe(false)

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
