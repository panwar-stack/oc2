import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { internalWrites } from "../../src/config/hot-reload"
import { MutationCoordinator, rejectionDiagnostic } from "../../src/config/mutation-coordinator"
import { ConfigWriteRejected } from "../../src/config/write-error"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceStore } from "../../src/project/instance-store"
import {
  activateAdapters,
  getAdapter,
  registerAdapter,
  releaseAdapters,
  retainRemovedAdapters,
} from "../../src/control-plane/adapters"
import { key as instanceKey } from "../../src/project/instance-context"
import { testEffect } from "../lib/effect"
import { ProjectV2 } from "@oc2-ai/core/project"

const state: {
  allocate: (directories: readonly string[]) => Effect.Effect<number>
  allocateGlobal: () => Effect.Effect<number>
  reload: (input: InstanceStore.LoadInput) => Effect.Effect<InstanceContext>
  activeDirectories: () => Effect.Effect<readonly string[]>
  beginGlobalEpoch: (directories: readonly string[]) => Effect.Effect<number>
  commitGlobalEpoch: (epoch: number, revision?: number) => Effect.Effect<void>
  abortGlobalEpoch: (epoch: number) => Effect.Effect<void>
  activeContext: (directory: string) => Effect.Effect<InstanceContext | undefined>
} = {
  allocate: () => Effect.succeed(1),
  allocateGlobal: () => state.allocate([]),
  reload: (input) => Effect.succeed({ revision: input.revision, globalEpoch: input.globalEpoch ?? 0 } as InstanceContext),
  activeDirectories: () => Effect.succeed([]),
  beginGlobalEpoch: () => Effect.succeed(1),
  commitGlobalEpoch: () => Effect.void,
  abortGlobalEpoch: () => Effect.void,
  activeContext: () => Effect.succeed(undefined),
}

const store = Layer.mock(InstanceStore.Service, {
  currentGlobalEpoch: () => Effect.succeed(0),
  activeDirectories: () => state.activeDirectories(),
  reserveRevision: () => Effect.void,
  allocateRevision: (directories) => state.allocate(directories),
  allocateGlobalRevision: () => state.allocateGlobal(),
  reload: (input) => state.reload(input),
  beginGlobalEpoch: (directories) => state.beginGlobalEpoch(directories ?? []),
  commitGlobalEpoch: (epoch, revision) => state.commitGlobalEpoch(epoch, revision),
  abortGlobalEpoch: (epoch) => state.abortGlobalEpoch(epoch),
  activeContext: (directory) => state.activeContext(directory),
})
const it = testEffect(MutationCoordinator.layer.pipe(Layer.provide(store)))

function events() {
  const values: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => {
    if (event.payload.type.startsWith("config.reload.")) values.push(event)
  }
  GlobalBus.on("event", listener)
  return {
    values,
    close: Effect.sync(() => GlobalBus.off("event", listener)),
  }
}

describe("config mutation coordinator", () => {
  it.effect("serializes concurrent read-modify-writes without losing fields", () =>
    Effect.gen(function* () {
      let revision = 0
      let evaluations = 0
      let content = "{}"
      const firstRead = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      state.allocate = () => Effect.sync(() => ++revision)
      state.reload = (input) => {
        evaluations += 1
        return Effect.succeed({ revision: input.revision, generation: input.revision } as InstanceContext)
      }
      const write = (field: string, wait: boolean) =>
        Effect.gen(function* () {
          const parsed = JSON.parse(content) as Record<string, unknown>
          if (wait) {
            yield* Deferred.succeed(firstRead, undefined)
            yield* Deferred.await(releaseFirst)
          }
          content = JSON.stringify({ ...parsed, [field]: true })
          return { fileChanged: true, path: "/a/oc2.json", content, digest: field }
        })
      const coordinator = yield* MutationCoordinator.Service
      const first = yield* coordinator.project({ directory: "/a", write: write("first", true) }).pipe(Effect.forkChild)
      yield* Deferred.await(firstRead)
      const second = yield* coordinator.project({ directory: "/a", write: write("second", false) }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      expect(JSON.parse(content)).toEqual({ first: true, second: true })
      expect(evaluations).toBe(2)
    }),
  )

  it.effect("uses typed secret-safe diagnostics for every rejection class", () =>
    Effect.sync(() => {
      const secret = '{"token":"raw","environment":{"KEY":"value"},"plugin":{"options":{"secret":"x"}}}'
      const cases = [
        ["JsonParseError", "parse"],
        ["InvalidError", "schema"],
        ["PluginBootstrapError", "bootstrap"],
        ["UnsupportedConfigError", "unsupported"],
      ] as const
      for (const [name, reason] of cases) {
        const diagnostic = rejectionDiagnostic(Object.assign(new Error(secret), { name }))
        expect(diagnostic.reason).toBe(reason)
        expect(JSON.stringify(diagnostic)).not.toContain("raw")
        expect(JSON.stringify(diagnostic)).not.toContain("value")
      }
    }),
  )

  it.effect("A to B to C preserves writes and commits the newest evaluation", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondSubmitted = yield* Deferred.make<void>()
      const thirdSubmitted = yield* Deferred.make<void>()
      const evaluated: number[] = []
      let latest = 0
      state.allocate = () =>
        Effect.gen(function* () {
          latest += 1
          if (latest === 2) yield* Deferred.succeed(secondSubmitted, undefined)
          if (latest === 3) yield* Deferred.succeed(thirdSubmitted, undefined)
          return latest
        })
      state.reload = (input) =>
        Effect.gen(function* () {
          const revision = input.revision ?? 0
          evaluated.push(revision)
          if (revision === 1) {
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          }
          if (revision !== latest) return yield* Effect.die(new Error("stale candidate"))
          return { revision, globalEpoch: 0 } as InstanceContext
        })
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service

      const a = yield* coordinator.project({ directory: "/a", changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const b = yield* coordinator.project({ directory: "/a", changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(secondSubmitted)
      yield* Effect.yieldNow
      const c = yield* coordinator.project({ directory: "/a", changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(thirdSubmitted)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseFirst, undefined)

      expect(yield* Fiber.join(a)).toMatchObject({ status: "committed", revision: 3 })
      expect(yield* Fiber.join(b)).toMatchObject({ status: "committed", revision: 3 })
      expect(yield* Fiber.join(c)).toMatchObject({ status: "committed", revision: 3 })
      expect(evaluated).toEqual([1, 2, 3])
      expect(published.values.map((event) => event.payload.properties.revision)).toEqual([3])
    }),
  )

  it.effect("publishes the latest valid fallback when the newer queued candidate rejects", () =>
    Effect.gen(function* () {
      const aEvaluating = yield* Deferred.make<void>()
      const releaseA = yield* Deferred.make<void>()
      let revision = 0
      state.allocate = () => Effect.sync(() => ++revision)
      state.activeContext = () => Effect.succeed(undefined)
      state.reload = (input) =>
        Effect.gen(function* () {
          if (input.revision === 1) {
            yield* Deferred.succeed(aEvaluating, undefined)
            yield* Deferred.await(releaseA)
            return { revision: 1, generation: 1 } as InstanceContext
          }
          return yield* Effect.die(Object.assign(new Error("invalid"), { name: "InvalidError" }))
        })
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      const a = yield* coordinator.project({ directory: "/a", changed: true, content: "a" }).pipe(Effect.forkChild)
      yield* Deferred.await(aEvaluating)
      const b = yield* coordinator.project({ directory: "/a", changed: true, content: "b" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseA, undefined)

      expect(yield* Fiber.join(a)).toMatchObject({ status: "committed", revision: 1 })
      expect(yield* Fiber.join(b)).toMatchObject({ status: "rejected", revision: 2 })
      expect(published.values.map((event) => [event.payload.type, event.payload.properties.revision])).toEqual([
        ["config.reload.committed", 1],
        ["config.reload.rejected", 2],
      ])
    }),
  )

  it.effect("publishes changed A when queued B finishes as a committed no-op", () =>
    Effect.gen(function* () {
      const aEvaluating = yield* Deferred.make<void>()
      const releaseA = yield* Deferred.make<void>()
      let revision = 0
      state.allocate = () => Effect.sync(() => ++revision)
      state.activeContext = () => Effect.succeed(undefined)
      state.reload = (input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(aEvaluating, undefined)
          yield* Deferred.await(releaseA)
          return { revision: input.revision, generation: input.revision } as InstanceContext
        })
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      const a = yield* coordinator.project({ directory: "/a", changed: true, content: "a" }).pipe(Effect.forkChild)
      yield* Deferred.await(aEvaluating)
      const b = yield* coordinator.project({ directory: "/a", changed: false, content: "b" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseA, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(published.values.map((event) => event.payload.properties.revision)).toEqual([1])
    }),
  )

  it.effect("retains committed fallback across superseded B and rejected C", () =>
    Effect.gen(function* () {
      const aCommitted = yield* Deferred.make<void>()
      const releaseA = yield* Deferred.make<void>()
      let revision = 0
      state.allocateGlobal = () => Effect.sync(() => ++revision)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.succeed(revision)
      state.abortGlobalEpoch = () => Effect.void
      state.commitGlobalEpoch = (_epoch, current) =>
        current === 1
          ? Effect.gen(function* () {
              yield* Deferred.succeed(aCommitted, undefined)
              yield* Deferred.await(releaseA)
            })
          : Effect.die(Object.assign(new Error("invalid"), { name: "InvalidError" }))
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      const a = yield* coordinator.global({ changed: true, content: "a" }).pipe(Effect.forkChild)
      yield* Deferred.await(aCommitted)
      const b = yield* coordinator.global({ changed: true, content: "b" }).pipe(Effect.forkChild)
      const c = yield* coordinator.global({ changed: true, content: "c" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseA, undefined)

      expect(yield* Fiber.join(a)).toMatchObject({ status: "committed", revision: 1 })
      expect(yield* Fiber.join(b)).toMatchObject({ status: "committed", revision: 1 })
      expect(yield* Fiber.join(c)).toMatchObject({ status: "rejected", revision: 3 })
      expect(published.values.map((event) => [event.payload.type, event.payload.properties.revision])).toEqual([
        ["config.reload.committed", 1],
        ["config.reload.rejected", 3],
      ])
    }),
  )

  it.effect("re-evaluates identical uncommitted bytes until they activate", () =>
    Effect.gen(function* () {
      let revision = 0
      let evaluations = 0
      let valid = false
      state.allocate = () => Effect.sync(() => ++revision)
      state.activeContext = () => Effect.succeed(undefined)
      state.reload = (input) => {
        evaluations++
        return valid
          ? Effect.succeed({ revision: input.revision, generation: input.revision } as InstanceContext)
          : Effect.die(Object.assign(new Error("dependency missing"), { name: "PluginBootstrapError" }))
      }
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      const write = (fileChanged: boolean) =>
        coordinator.project({
          directory: "/a",
          write: Effect.succeed({ fileChanged, path: "/a/oc2.json", content: "same", digest: "same" }),
        })

      expect((yield* write(true)).status).toBe("rejected")
      expect((yield* write(false)).status).toBe("rejected")
      valid = true
      expect(yield* write(false)).toMatchObject({ status: "committed", changed: true })
      expect((yield* write(false)).changed).toBe(false)
      expect(evaluations).toBe(3)
      expect(published.values.filter((event) => event.payload.type === "config.reload.committed")).toHaveLength(1)
    }),
  )

  it.effect("committed effective no-op resets rejection dedupe for identical dirty bytes", () =>
    Effect.gen(function* () {
      let revision = 0
      let valid = false
      state.allocate = () => Effect.sync(() => ++revision)
      state.activeContext = () => Effect.succeed(undefined)
      state.reload = () =>
        valid
          ? Effect.succeed({ revision: 0, generation: 1 } as InstanceContext)
          : Effect.die(Object.assign(new Error("invalid"), { name: "InvalidError" }))
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      const write = (fileChanged: boolean) =>
        coordinator.project({
          directory: "/a",
          write: Effect.succeed({ fileChanged, path: "/a/oc2.json", content: "x", digest: "x" }),
        })

      expect((yield* write(true)).status).toBe("rejected")
      valid = true
      expect(yield* write(false)).toMatchObject({ status: "committed", changed: false })
      valid = false
      expect((yield* write(true)).status).toBe("rejected")
      expect(published.values.filter((event) => event.payload.type === "config.reload.rejected")).toHaveLength(2)
      expect(published.values.filter((event) => event.payload.type === "config.reload.committed")).toHaveLength(0)
    }),
  )

  it.effect("empty global first no-op skips evaluation and does not commit an epoch", () =>
    Effect.gen(function* () {
      let reloads = 0
      let commits = 0
      state.allocateGlobal = () => Effect.succeed(1)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.succeed(1)
      state.reload = () => (reloads++, Effect.die(new Error("unexpected reload")))
      state.commitGlobalEpoch = () => Effect.sync(() => commits++)
      state.abortGlobalEpoch = () => Effect.void
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const result = yield* (yield* MutationCoordinator.Service).global({ changed: false, content: "same" })
      expect(result).toMatchObject({ status: "committed", changed: false })
      expect({ reloads, commits }).toEqual({ reloads: 0, commits: 0 })
      expect(published.values).toEqual([])
    }),
  )

  it.effect("global dirty same-byte recovery commits and emits despite fileChanged false", () =>
    Effect.gen(function* () {
      let revision = 0
      let fail = true
      state.allocateGlobal = () => Effect.sync(() => ++revision)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.succeed(revision)
      state.commitGlobalEpoch = () => (fail ? Effect.die(new Error("activation failed")) : Effect.void)
      state.abortGlobalEpoch = () => Effect.void
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      expect((yield* coordinator.global({ changed: true, content: "same" })).status).toBe("rejected")
      fail = false
      expect(yield* coordinator.global({ changed: false, content: "same" })).toMatchObject({
        status: "committed",
        changed: true,
      })
      expect(published.values.filter((event) => event.payload.type === "config.reload.committed")).toHaveLength(1)
    }),
  )

  it.effect("empty global A to B to C preserves every write and commits only C", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      let revision = 0
      let epochs = 0
      let content = "{}"
      state.allocate = () => Effect.sync(() => ++revision)
      state.allocateGlobal = () => state.allocate([])
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.sync(() => ++epochs)
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const write = (field: string, wait = false) =>
        Effect.gen(function* () {
          const parsed = JSON.parse(content) as Record<string, unknown>
          if (wait) {
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          }
          content = JSON.stringify({ ...parsed, [field]: true })
          return { fileChanged: true, path: "/global/oc2.json", content, digest: field }
        })
      const coordinator = yield* MutationCoordinator.Service
      const a = yield* coordinator.global({ write: write("a", true) }).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const b = yield* coordinator.global({ write: write("b") }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const c = yield* coordinator.global({ write: write("c") }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseFirst, undefined)

      expect(yield* Fiber.join(a)).toMatchObject({ status: "committed", revision: 3 })
      expect(yield* Fiber.join(b)).toMatchObject({ status: "committed", revision: 3 })
      expect(yield* Fiber.join(c)).toMatchObject({ status: "committed", revision: 3 })
      expect(JSON.parse(content)).toEqual({ a: true, b: true, c: true })
      expect(published.values.map((event) => event.payload.properties.revision)).toEqual([3])
    }),
  )

  it.effect("global admission fences before enumeration and write and aborts write failure", () =>
    Effect.gen(function* () {
      const order: string[] = []
      state.allocate = () => Effect.succeed(1)
      state.beginGlobalEpoch = () => Effect.sync(() => (order.push("begin"), 7))
      state.activeDirectories = () => Effect.sync(() => (order.push("directories"), []))
      state.abortGlobalEpoch = () => Effect.sync(() => order.push("abort"))
      const coordinator = yield* MutationCoordinator.Service

      const result = yield* coordinator.global({
        path: "/global/oc2.json",
        write: Effect.sync(() => {
          order.push("write")
          throw Object.assign(new Error("invalid"), { name: "InvalidError" })
        }),
      })

      expect(result).toMatchObject({ status: "rejected", reason: "schema" })
      expect(order).toEqual(["begin", "directories", "write", "abort"])
    }),
  )

  it.effect("different project targets evaluate concurrently", () =>
    Effect.gen(function* () {
      const aStarted = yield* Deferred.make<void>()
      const bStarted = yield* Deferred.make<void>()
      const releaseA = yield* Deferred.make<void>()
      const revisions = new Map<string, number>()
      state.allocate = ([directory]) =>
        Effect.sync(() => {
          const revision = (revisions.get(directory!) ?? 0) + 1
          revisions.set(directory!, revision)
          return revision
        })
      state.reload = (input) =>
        Effect.gen(function* () {
          if (input.directory === "/a") {
            yield* Deferred.succeed(aStarted, undefined)
            yield* Deferred.await(releaseA)
          } else yield* Deferred.succeed(bStarted, undefined)
          return { revision: input.revision, globalEpoch: 0 } as InstanceContext
        })
      const coordinator = yield* MutationCoordinator.Service
      const a = yield* coordinator.project({ directory: "/a", changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(aStarted)
      const b = yield* coordinator.project({ directory: "/b", changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(bStarted)
      yield* Deferred.succeed(releaseA, undefined)
      expect((yield* Fiber.join(a)).status).toBe("committed")
      expect((yield* Fiber.join(b)).status).toBe("committed")
    }),
  )

  it.effect("global mutation waits for an in-flight project write critical section", () =>
    Effect.gen(function* () {
      const projectStarted = yield* Deferred.make<void>()
      const releaseProject = yield* Deferred.make<void>()
      let revision = 0
      const order: string[] = []
      state.allocate = () => Effect.sync(() => ++revision)
      state.allocateGlobal = () => Effect.sync(() => ++revision)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.succeed(1)
      state.commitGlobalEpoch = () => Effect.void
      state.reload = (input) => Effect.succeed({ revision: input.revision } as InstanceContext)
      const coordinator = yield* MutationCoordinator.Service
      const project = yield* coordinator
        .project({
          directory: "/a",
          write: Effect.gen(function* () {
            order.push("project-write")
            yield* Deferred.succeed(projectStarted, undefined)
            yield* Deferred.await(releaseProject)
            return { fileChanged: true, path: "/a/oc2.json", content: "project", digest: "project" }
          }),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(projectStarted)
      const global = yield* coordinator
        .global({
          write: Effect.sync(() => {
            order.push("global-write")
            return { fileChanged: true, path: "/global/oc2.json", content: "global", digest: "global" }
          }),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(order).toEqual(["project-write"])
      yield* Deferred.succeed(releaseProject, undefined)
      yield* Fiber.join(project)
      yield* Fiber.join(global)
      expect(order).toEqual(["project-write", "global-write"])
    }),
  )

  it.effect("project mutation waits before allocation and write while global is open", () =>
    Effect.gen(function* () {
      const globalStarted = yield* Deferred.make<void>()
      const releaseGlobal = yield* Deferred.make<void>()
      const order: string[] = []
      let revision = 0
      state.allocate = () => Effect.sync(() => (order.push("project-allocate"), ++revision))
      state.allocateGlobal = () => Effect.sync(() => ++revision)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.succeed(1)
      state.commitGlobalEpoch = () => Effect.void
      state.reload = (input) => Effect.succeed({ revision: input.revision } as InstanceContext)
      const coordinator = yield* MutationCoordinator.Service
      const global = yield* coordinator
        .global({
          write: Effect.gen(function* () {
            order.push("global-write")
            yield* Deferred.succeed(globalStarted, undefined)
            yield* Deferred.await(releaseGlobal)
            return { fileChanged: true, path: "/global/oc2.json", content: "global", digest: "global" }
          }),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(globalStarted)
      const project = yield* coordinator
        .project({ directory: "/a", changed: true, content: "project" })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(order).toEqual(["global-write"])
      yield* Deferred.succeed(releaseGlobal, undefined)
      yield* Fiber.join(global)
      yield* Fiber.join(project)
      expect(order).toEqual(["global-write", "project-allocate"])
    }),
  )

  it.effect("caller interruption does not release a current request mutation gate", () =>
    Effect.gen(function* () {
      const projectStarted = yield* Deferred.make<void>()
      const releaseProject = yield* Deferred.make<void>()
      let globalWrites = 0
      let revision = 0
      state.allocate = () => Effect.sync(() => ++revision)
      state.allocateGlobal = () => Effect.sync(() => ++revision)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.succeed(1)
      state.commitGlobalEpoch = () => Effect.void
      state.reload = (input) => Effect.succeed({ revision: input.revision } as InstanceContext)
      const coordinator = yield* MutationCoordinator.Service
      const caller = yield* coordinator
        .project({
          directory: "/a",
          write: Effect.gen(function* () {
            yield* Deferred.succeed(projectStarted, undefined)
            yield* Deferred.await(releaseProject)
            return { fileChanged: true, path: "/a/oc2.json", content: "project", digest: "project" }
          }),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(projectStarted)
      yield* Fiber.interrupt(caller)
      const global = yield* coordinator
        .global({
          write: Effect.sync(() => {
            globalWrites++
            return { fileChanged: true, path: "/global/oc2.json", content: "global", digest: "global" }
          }),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(globalWrites).toBe(0)
      yield* Deferred.succeed(releaseProject, undefined)
      yield* Fiber.join(global)
      expect(globalWrites).toBe(1)
    }),
  )

  it.effect("global response waits until the fenced epoch commits", () =>
    Effect.gen(function* () {
      const commitEntered = yield* Deferred.make<void>()
      const releaseCommit = yield* Deferred.make<void>()
      state.activeDirectories = () => Effect.succeed(["/a", "/b"])
      state.allocate = () => Effect.succeed(4)
      state.beginGlobalEpoch = () => Effect.succeed(9)
      state.reload = (input) => Effect.succeed({ revision: input.revision, globalEpoch: input.globalEpoch } as InstanceContext)
      state.commitGlobalEpoch = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(commitEntered, undefined)
          yield* Deferred.await(releaseCommit)
        })
      const coordinator = yield* MutationCoordinator.Service
      const fiber = yield* coordinator.global({ changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(commitEntered)
      const completed = yield* Deferred.make<void>()
      yield* Fiber.await(fiber).pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.forkChild)
      expect(yield* Deferred.isDone(completed)).toBe(false)
      yield* Deferred.succeed(releaseCommit, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result).toMatchObject({ status: "committed", generation: 9, scope: "global" })
    }),
  )

  it.effect("global commit guard rejects A when B is admitted before atomic activation", () =>
    Effect.gen(function* () {
      const commitEntered = yield* Deferred.make<void>()
      const releaseCommit = yield* Deferred.make<void>()
      let highest = 0
      let epoch = 0
      let activeEpoch = 0
      let activeRevision = 0
      const commits: number[] = []
      state.allocateGlobal = () => Effect.sync(() => ++highest)
      state.activeDirectories = () => Effect.succeed([])
      state.beginGlobalEpoch = () => Effect.sync(() => ++epoch)
      state.commitGlobalEpoch = (nextEpoch, revision) =>
        Effect.gen(function* () {
          if (revision === 1) {
            yield* Deferred.succeed(commitEntered, undefined)
            yield* Deferred.await(releaseCommit)
          }
          if (revision !== highest) return yield* Effect.die(new Error("stale global revision"))
          activeEpoch = nextEpoch
          activeRevision = revision
          commits.push(revision)
        })
      state.abortGlobalEpoch = () => Effect.void
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service

      const a = yield* coordinator.global({ changed: true, content: "a" }).pipe(Effect.forkChild)
      yield* Deferred.await(commitEntered)
      const b = yield* coordinator.global({ changed: true, content: "b" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCommit, undefined)

      expect(yield* Fiber.join(a)).toMatchObject({ status: "committed", revision: 2 })
      expect(yield* Fiber.join(b)).toMatchObject({ status: "committed", revision: 2 })
      expect(commits).toEqual([2])
      expect({ activeEpoch, activeRevision }).toEqual({ activeEpoch: 2, activeRevision: 2 })
      expect(published.values.map((event) => event.payload.properties.revision)).toEqual([2])
    }),
  )

  it.effect("global effective no-op aborts the proposed epoch and retains committed revision", () =>
    Effect.gen(function* () {
      let committed = 0
      let aborted = 0
      state.allocate = () => Effect.succeed(8)
      state.activeDirectories = () => Effect.succeed(["/a"])
      state.beginGlobalEpoch = () => Effect.succeed(9)
      state.activeContext = () =>
        Effect.succeed({ revision: 7, generation: 3, globalEpoch: 4, fingerprint: "same" } as InstanceContext)
      state.reload = () =>
        Effect.succeed({ revision: 8, generation: 4, globalEpoch: 9, fingerprint: "same" } as InstanceContext)
      state.commitGlobalEpoch = () => Effect.sync(() => committed++)
      state.abortGlobalEpoch = () => Effect.sync(() => aborted++)
      const published = events()
      yield* Effect.addFinalizer(() => published.close)

      const result = yield* (yield* MutationCoordinator.Service).global({
        write: Effect.succeed({
          fileChanged: true,
          path: "/global/oc2.json",
          content: "{ /* reformatted */ }",
          digest: "same-effective-config",
        }),
      })

      expect(result).toMatchObject({ status: "committed", revision: 7, changed: false })
      expect(committed).toBe(0)
      expect(aborted).toBe(1)
      expect(published.values).toEqual([])
    }),
  )

  it.effect("no-op performs zero replacements and emits no event", () =>
    Effect.gen(function* () {
      let replacements = 0
      state.allocate = () => Effect.succeed(1)
      state.reload = () => {
        replacements += 1
        return Effect.die(new Error("unexpected replacement"))
      }
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const result = yield* (yield* MutationCoordinator.Service).project({ directory: "/a", changed: false })
      expect(result.status).toBe("committed")
      expect(replacements).toBe(0)
      expect(published.values).toEqual([])
    }),
  )

  it.effect("effective fingerprint no-op trusts the coordinator exit and emits nothing", () =>
    Effect.gen(function* () {
      let replacements = 0
      state.allocate = () => Effect.succeed(8)
      state.reload = () => {
        replacements += 1
        return Effect.succeed({ revision: 7, generation: 3, globalEpoch: 0 } as InstanceContext)
      }
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const result = yield* (yield* MutationCoordinator.Service).project({ directory: "/a", changed: true })
      expect(result.changed).toBe(false)
      expect(replacements).toBe(1)
      expect(published.values).toEqual([])
    }),
  )

  it.effect("committed events expose exact restart field names", () =>
    Effect.gen(function* () {
      state.allocate = () => Effect.succeed(1)
      state.reload = (input) =>
        Effect.succeed({ revision: input.revision, generation: 7, globalEpoch: 0 } as InstanceContext)
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      yield* (yield* MutationCoordinator.Service).project({
        directory: "/a",
        changed: true,
        restartRequired: ["port", "autoupdate"],
      })
      expect(published.values[0]?.payload.properties).toEqual({
        revision: 1,
        generation: 7,
        scope: "project",
        directories: ["/a"],
        restartRequired: ["port", "autoupdate"],
      })
    }),
  )

  it.effect("plugin workspace-adapter removals require restart", () =>
    Effect.gen(function* () {
      const project = {
        id: ProjectV2.ID.make("project"),
        worktree: "/a",
        time: { created: 0, updated: 0 },
        sandboxes: [],
      } as InstanceContext["project"]
      const old = {
        directory: "/a",
        generation: 1,
        state: "active",
        worktree: "/a",
        project,
      } as InstanceContext
      const next = {
        directory: "/a",
        generation: 2,
        revision: 1,
        state: "active",
        worktree: "/a",
        restartRequired: ["plugin"],
        project,
      } as InstanceContext
      const adapter = {
        name: "custom",
        description: "custom",
        configure: (info: never) => info,
        create: async () => {},
        remove: async () => {},
        target: () => ({ type: "local" as const, directory: "/a" }),
      }
      registerAdapter(old.project.id, "custom", adapter, instanceKey(old))
      activateAdapters(old.project.id, instanceKey(old))
      expect(retainRemovedAdapters(old.project.id, instanceKey(old), instanceKey(next))).toEqual(["custom"])
      activateAdapters(next.project.id, instanceKey(next))
      releaseAdapters(old.project.id, instanceKey(old))
      expect(getAdapter(next.project.id, "custom", instanceKey(next))).toBe(adapter)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releaseAdapters(next.project.id, instanceKey(next))
        }),
      )
      state.activeContext = () => Effect.succeed(old)
      state.allocate = () => Effect.succeed(1)
      state.reload = () => Effect.succeed(next)
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      yield* (yield* MutationCoordinator.Service).project({ directory: "/a", changed: true })
      expect(published.values[0]?.payload.properties.restartRequired).toEqual(["plugin"])
    }),
  )

  it.effect("ordinary plugin additions and updates do not require restart", () =>
    Effect.gen(function* () {
      const project = {
        id: ProjectV2.ID.make("plugin-change-project"),
        worktree: "/a",
        time: { created: 0, updated: 0 },
        sandboxes: [],
      } as InstanceContext["project"]
      const active = {
        directory: "/a",
        generation: 1,
        revision: 1,
        fingerprint: "old",
        effectiveConfig: { plugin: ["plugin@1"] },
        state: "active",
        worktree: "/a",
        project,
      } as InstanceContext
      state.activeContext = () => Effect.succeed(active)
      state.allocate = () => Effect.succeed(2)
      const coordinator = yield* MutationCoordinator.Service

      for (const plugin of [["plugin@1", "added@1"], ["plugin@2"]]) {
        state.reload = () =>
          Effect.succeed({
            ...active,
            generation: active.generation + 1,
            revision: 2,
            fingerprint: plugin.join(","),
            effectiveConfig: { plugin },
          } as InstanceContext)
        const result = yield* coordinator.project({ directory: "/a", changed: true })
        expect(result.restartRequired).toEqual([])
      }
    }),
  )

  it.effect("attributes an explicit write once and treats mismatched native content as newer", () =>
    Effect.gen(function* () {
      let revision = 0
      let replacements = 0
      state.allocate = () => Effect.sync(() => ++revision)
      state.reload = (input) => {
        replacements += 1
        return Effect.succeed({ revision: input.revision, globalEpoch: 0 } as InstanceContext)
      }
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      internalWrites.record("/a/oc2.json", "expected")
      yield* coordinator.project({ directory: "/a", changed: true })
      yield* coordinator.native({ scope: "project", directory: "/a", path: "/a/oc2.json", content: "expected" })
      expect(replacements).toBe(1)
      expect(published.values).toHaveLength(1)

      const result = yield* coordinator.native({
        scope: "project",
        directory: "/a",
        path: "/a/oc2.json",
        content: "newer",
      })
      expect(result.revision).toBe(2)
      expect(replacements).toBe(2)
      expect(published.values).toHaveLength(2)
    }),
  )

  it.effect("redacts rejected diagnostics, deduplicates, and resets after success", () =>
    Effect.gen(function* () {
      let revision = 0
      let fail = true
      state.allocate = () => Effect.sync(() => ++revision)
      state.reload = (input) =>
        fail
          ? Effect.die(Object.assign(new Error('{"token":"raw-secret","plugin":{"options":{"key":"x"}}}'), { name: "InvalidError" }))
          : Effect.succeed({ revision: input.revision, globalEpoch: 0 } as InstanceContext)
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      yield* coordinator.project({ directory: "/a", path: "/a/oc2.json", content: "invalid-a", changed: true })
      yield* coordinator.project({ directory: "/a", path: "/a/oc2.json", content: "invalid-a", changed: true })
      expect(published.values).toHaveLength(1)
      expect(published.values[0]?.payload.properties).toEqual({
        path: "/a/oc2.json",
        revision: 1,
        reason: "schema",
        message: "The configuration did not pass validation.",
      })
      expect(JSON.stringify(published.values)).not.toContain("raw-secret")
      yield* coordinator.project({ directory: "/a", path: "/a/oc2.json", content: "invalid-b", changed: true })
      yield* coordinator.project({ directory: "/a", path: "/a/oc2.json", content: "invalid-b", changed: true })
      expect(published.values.filter((event) => event.payload.type === "config.reload.rejected")).toHaveLength(2)
      fail = false
      yield* coordinator.project({ directory: "/a", path: "/a/oc2.json", content: "valid", changed: true })
      fail = true
      yield* coordinator.project({ directory: "/a", path: "/a/oc2.json", content: "invalid-a", changed: true })
      expect(published.values.filter((event) => event.payload.type === "config.reload.rejected")).toHaveLength(3)
    }),
  )

  it.effect("deduplicates typed pre-write rejection identity and resets after success", () =>
    Effect.gen(function* () {
      let revision = 0
      state.allocate = () => Effect.sync(() => ++revision)
      state.activeContext = () => Effect.succeed(undefined)
      state.reload = (input) => Effect.succeed({ revision: input.revision, globalEpoch: 0 } as InstanceContext)
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      const coordinator = yield* MutationCoordinator.Service
      const reject = (digest: string) =>
        coordinator.project({
          directory: "/a",
          path: "/a/../a/oc2.json",
          write: Effect.die(
            new ConfigWriteRejected({
              path: "/a/oc2.json",
              digest,
              reason: "schema",
              message: "The configuration did not pass validation.",
            }),
          ),
        })

      yield* reject("private-a")
      yield* reject("private-a")
      yield* reject("private-b")
      expect(published.values).toHaveLength(2)
      expect(JSON.stringify(published.values)).not.toContain("private-a")
      expect(JSON.stringify(published.values)).not.toContain("private-b")

      yield* coordinator.project({ directory: "/a", changed: true, content: "valid" })
      yield* reject("private-a")
      expect(published.values.filter((event) => event.payload.type === "config.reload.rejected")).toHaveLength(3)
    }),
  )

  it.effect("shutdown interrupts the worker, closes queued requests, and cannot resurrect", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let revision = 0
      state.allocate = () => Effect.sync(() => ++revision)
      state.reload = () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)))
      const published = events()
      yield* Effect.addFinalizer(() => published.close)
      internalWrites.record("/a/oc2.json", "pending")
      const coordinator = yield* MutationCoordinator.Service
      const current = yield* coordinator.project({ directory: "/a", changed: true }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const queued = yield* coordinator.project({ directory: "/a", changed: true }).pipe(Effect.forkChild)
      const waitingGlobal = yield* coordinator.global({ changed: true }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* coordinator.shutdown()
      expect((yield* Fiber.join(current)).status).toBe("superseded")
      expect((yield* Fiber.join(queued)).status).toBe("superseded")
      expect((yield* Fiber.join(waitingGlobal)).status).toBe("superseded")
      yield* Deferred.await(interrupted)
      const after = yield* coordinator.project({ directory: "/a", changed: true })
      expect(after.status).toBe("superseded")
      expect(revision).toBe(2)
      expect(published.values).toEqual([])
      expect(internalWrites.consume("/a/oc2.json", "pending")).toBe(false)
    }),
  )
})
