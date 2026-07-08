import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Location } from "@oc2-ai/core/location"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Global } from "@oc2-ai/core/global"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SystemContext } from "@oc2-ai/core/system-context"
import { SystemContextBuiltIns } from "@oc2-ai/core/system-context/builtins"
import { SystemContextRegistry } from "@oc2-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const instructionFile = FSUtil.resolve("/repo/AGENTS.md")
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const localDate = (time: number) => new Date(time).toDateString()
const locationLayerFor = (directory: AbsolutePath) =>
  Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory },
        { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
      ),
    ),
  )
const locationLayer = locationLayerFor(directory)
const builtInsLayerFor = (providedLocation: ReturnType<typeof locationLayerFor>, fsLayer = FSUtil.defaultLayer) =>
  SystemContextBuiltIns.locationLayer.pipe(
    Layer.provide(fsLayer),
    Layer.provide(Global.layerWith({ config: "/global" })),
    Layer.provide(providedLocation),
  )
const it = testEffect(builtInsLayerFor(locationLayer))
const instructionFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({
        ...fs,
        up: () => Effect.succeed([instructionFile]),
        readFileStringSafe: (path) => Effect.succeed(path === instructionFile ? "Be precise." : undefined),
      }),
    ),
  ),
).pipe(Layer.provide(FSUtil.defaultLayer))
const itWithInstructions = testEffect(builtInsLayerFor(locationLayer, instructionFS))

describe("SystemContextBuiltIns", () => {
  it.effect("loads location-scoped environment and host-local date context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
        ].join("\n"),
      )
    }),
  )

  itWithInstructions.effect("keeps date and environment out of the stable baseline", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const loaded = yield* context.load()
      const stable = yield* SystemContext.initialize(SystemContext.stable(loaded))
      const variable = yield* SystemContext.render(SystemContext.variable(loaded))

      expect(stable.baseline).toBe(`Instructions from: ${instructionFile}\nBe precise.`)
      expect(stable.baseline).not.toContain("Working directory")
      expect(stable.baseline).not.toContain("Today's date")
      expect(variable).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
        ].join("\n"),
      )
    }),
  )

  it.effect("reconciles the date without repeating unchanged environment context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: `Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`,
      })
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect(yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  itWithInstructions.effect("composes ambient instructions after built-in context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service

      expect((yield* SystemContext.initialize(yield* context.load())).baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          `Instructions from: ${instructionFile}\nBe precise.`,
        ].join("\n"),
      )
    }),
  )
})
