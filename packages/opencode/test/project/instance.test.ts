import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceState } from "../../src/effect/instance-state"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { matches as matchesInstance } from "../../src/project/instance-context"
import { dependencyIndex } from "../../src/config/hot-reload"
import { ProjectV2 } from "@oc2-ai/core/project"
import { TestClock } from "effect/testing"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void, never, Scope.Scope> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(noopBootstrap)),
)

const setBootstrap = (run: Effect.Effect<void, never, Scope.Scope>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer((ctx) => disposer(ctx.directory))),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  test("does not match late lifecycle events from an older generation", () => {
    const active = { directory: "/project", generation: 2 }
    expect(matchesInstance(active, { directory: "/project", generation: 1 })).toBe(false)
    expect(matchesInstance(active, { directory: "/project", generation: 2 })).toBe(true)
  })

  test("layer shutdown awaits disposer and generation scope finalizers", async () => {
    const disposerStarted = Promise.withResolvers<void>()
    const releaseDisposer = Promise.withResolvers<void>()
    const scopeStarted = Promise.withResolvers<void>()
    const releaseScope = Promise.withResolvers<void>()
    const off = registerDisposer(async () => {
      disposerStarted.resolve()
      await releaseDisposer.promise
    })
    bootstrapRun = Effect.addFinalizer(() =>
      Effect.promise(async () => {
        scopeStarted.resolve()
        await releaseScope.promise
      }),
    )
    const project = {
      id: ProjectV2.ID.make(`shutdown-${crypto.randomUUID()}`),
      worktree: "/shutdown",
      time: { created: 0, updated: 0 },
      sandboxes: ["/shutdown"],
    }
    let completed = false
    const layer = Layer.mergeAll(InstanceStore.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(
      Layer.provide(noopBootstrap),
    )
    const task = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(layer)
          const store = Context.get(services, InstanceStore.Service)
          yield* store.load({ directory: "/shutdown", worktree: "/shutdown", project })
        }),
      ),
    ).finally(() => {
      completed = true
    })

    try {
      await disposerStarted.promise
      expect(completed).toBe(false)
      releaseDisposer.resolve()
      await scopeStarted.promise
      expect(completed).toBe(false)
      releaseScope.resolve()
      await task
      expect(completed).toBe(true)
    } finally {
      off()
      bootstrapRun = Effect.void
      releaseDisposer.resolve()
      releaseScope.resolve()
    }
  })

  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
      expect(ctx.generation).toBe(1)
      expect(ctx.state).toBe("active")
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(second.generation).toBe(first.generation + 1)
      expect(first.state).toBe("draining")
      expect(cached).toBe(second)
      yield* store.dispose(first)
      expect(first.state).toBe("closed")
    }),
  )

  it.live("keeps the active generation when candidate bootstrap fails", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: number[] = []
      let scopeClosed = 0
      yield* Effect.acquireRelease(
        Effect.sync(() => registerDisposer(async (ctx) => void disposed.push(ctx.generation))),
        (off) => Effect.sync(off),
      )
      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              scopeClosed++
            }),
          )
          return yield* Effect.die(new Error("candidate failed"))
        }),
      )

      const failed = yield* store.reload({ directory: dir }).pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* store.load({ directory: dir })).toBe(first)
      expect(first.state).toBe("active")
      expect(disposed).toEqual([2])
      expect(scopeClosed).toBe(1)
    }),
  )

  it.live("admits new work only to the generation active at admission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const admitted = yield* Deferred.make<number>()
      const release = yield* Deferred.make<void>()
      const booting = yield* Deferred.make<void>()
      const finishBoot = yield* Deferred.make<void>()
      const first = yield* store.load({ directory: dir })
      const oldWork = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(admitted, (yield* InstanceRef)?.generation ?? -1)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkScoped)
      expect(yield* Deferred.await(admitted)).toBe(first.generation)
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(booting, undefined)
          yield* Deferred.await(finishBoot)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(booting)
      expect((yield* store.load({ directory: dir })).generation).toBe(first.generation)
      yield* Deferred.succeed(finishBoot, undefined)
      const second = yield* Fiber.join(reload)
      expect(second.generation).toBe(first.generation + 1)
      expect(first.state).toBe("draining")
      const next = yield* store.provide(
        { directory: dir },
        Effect.map(InstanceRef, (ctx) => ctx?.generation),
      )
      expect(next).toBe(second.generation)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(oldWork)
      yield* store.dispose(first)
      expect(first.state).toBe("closed")
    }),
  )

  it.live("commits only the newest ready candidate", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const firstCandidateStarted = yield* Deferred.make<void>()
      const releaseFirstCandidate = yield* Deferred.make<void>()
      let attempts = 0
      yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          attempts++
          if (attempts !== 1) return
          yield* Deferred.succeed(firstCandidateStarted, undefined)
          yield* Deferred.await(releaseFirstCandidate)
        }),
      )

      const older = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(firstCandidateStarted)
      const newest = yield* store.reload({ directory: dir })
      yield* Deferred.succeed(releaseFirstCandidate, undefined)
      const olderExit = yield* Fiber.await(older)

      expect(Exit.isFailure(olderExit)).toBe(true)
      expect((yield* store.load({ directory: dir })).generation).toBe(newest.generation)
      expect(newest.generation).toBe(3)
    }),
  )

  it.live("uses target revision rather than later generation allocation for admission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const newestStarted = yield* Deferred.make<void>()
      const releaseNewest = yield* Deferred.make<void>()
      yield* store.load({ directory: dir, revision: 1 })
      yield* setBootstrap(
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (ctx?.revision !== 3) return
          yield* Deferred.succeed(newestStarted, undefined)
          yield* Deferred.await(releaseNewest)
        }),
      )

      const newest = yield* store.reload({ directory: dir, revision: 3 }).pipe(Effect.forkScoped)
      yield* Deferred.await(newestStarted)
      const stale = yield* store.reload({ directory: dir, revision: 2 }).pipe(Effect.exit)
      yield* Deferred.succeed(releaseNewest, undefined)
      const committed = yield* Fiber.join(newest)

      expect(Exit.isFailure(stale)).toBe(true)
      expect(committed.revision).toBe(3)
      expect(committed.generation).toBe(2)
      expect((yield* store.load({ directory: dir })).revision).toBe(3)
    }),
  )

  it.live("replaces dependency index membership atomically at cutover", () =>
    Effect.gen(function* () {
      dependencyIndex.clear()
      yield* Effect.addFinalizer(() => Effect.sync(() => dependencyIndex.clear()))
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const oldPath = `${dir}/old/oc2.json`
      const nextPath = `${dir}/next/oc2.json`
      yield* setBootstrap(
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) return
          ctx.fingerprint = `revision-${ctx.revision}`
          ctx.configDependencies = ctx.revision === 1 ? [oldPath] : [nextPath]
        }),
      )
      const first = yield* store.load({ directory: dir, revision: 1 })
      expect(dependencyIndex.consumers(oldPath)).toEqual([
        { directory: dir, generation: first.generation },
      ])

      const second = yield* store.reload({ directory: dir, revision: 2 })
      expect(first.state).toBe("draining")
      expect(dependencyIndex.consumers(oldPath)).toEqual([])
      expect(dependencyIndex.consumers(nextPath)).toEqual([
        { directory: dir, generation: second.generation },
      ])
    }),
  )

  it.live("does not mutate dependencies for failed or effective no-op candidates", () =>
    Effect.gen(function* () {
      dependencyIndex.clear()
      yield* Effect.addFinalizer(() => Effect.sync(() => dependencyIndex.clear()))
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const activePath = `${dir}/active/oc2.json`
      const rejectedPath = `${dir}/rejected/oc2.json`
      yield* setBootstrap(
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) return
          ctx.fingerprint = "same"
          ctx.configDependencies = ctx.revision === 1 ? [activePath] : [rejectedPath]
        }),
      )
      const first = yield* store.load({ directory: dir, revision: 1 })
      expect(yield* store.reload({ directory: dir, revision: 2 })).toBe(first)
      expect(dependencyIndex.consumers(activePath)).toEqual([
        { directory: dir, generation: first.generation },
      ])
      expect(dependencyIndex.consumers(rejectedPath)).toEqual([])

      yield* setBootstrap(Effect.die(new Error("rejected")))
      expect(Exit.isFailure(yield* store.reload({ directory: dir, revision: 3 }).pipe(Effect.exit))).toBe(true)
      expect(dependencyIndex.consumers(activePath)).toHaveLength(1)
      expect(dependencyIndex.consumers(rejectedPath)).toEqual([])
    }),
  )

  it.effect("commits a global epoch only after every project candidate is ready", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const project = (directory: string) => ({
        id: ProjectV2.ID.make(directory.slice(1)),
        worktree: directory,
        time: { created: 0, updated: 0 },
        sandboxes: [directory],
      })
      const left = { directory: "/epoch-left", worktree: "/epoch-left", project: project("/epoch-left") }
      const right = { directory: "/epoch-right", worktree: "/epoch-right", project: project("/epoch-right") }
      const leftV0 = yield* store.load(left)
      const rightV0 = yield* store.load(right)

      const epoch = yield* store.beginGlobalEpoch([left.directory, right.directory])
      const leftV1 = yield* store.reload({ ...left, globalEpoch: epoch })
      const rightV1 = yield* store.reload({ ...right, globalEpoch: epoch })
      const admitted = yield* store
        .provide(left, Effect.map(InstanceRef, (ctx) => ctx?.globalEpoch))
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow

      expect(yield* store.currentGlobalEpoch()).toBe(0)
      expect((yield* store.load(left)).globalEpoch).toBe(0)
      expect((yield* store.load(right)).globalEpoch).toBe(0)
      expect(leftV1.state).toBe("booting")
      expect(rightV1.state).toBe("booting")

      yield* store.commitGlobalEpoch(epoch)

      expect(yield* store.currentGlobalEpoch()).toBe(epoch)
      expect(yield* Fiber.join(admitted)).toBe(epoch)
      expect((yield* store.load(left)).generation).toBe(leftV1.generation)
      expect((yield* store.load(right)).generation).toBe(rightV1.generation)
      expect(leftV0.state).toBe("draining")
      expect(rightV0.state).toBe("draining")
    }),
  )

  it.effect("aborts a rejected global epoch without advancing the committed epoch", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const directory = "/epoch-rollback"
      const project = {
        id: ProjectV2.ID.make("epoch-rollback"),
        worktree: directory,
        time: { created: 0, updated: 0 },
        sandboxes: [directory],
      }
      const input = { directory, worktree: directory, project }
      const active = yield* store.load(input)
      const epoch = yield* store.beginGlobalEpoch([directory])
      yield* setBootstrap(Effect.die(new Error("candidate rejected")))
      expect(Exit.isFailure(yield* store.reload({ ...input, globalEpoch: epoch }).pipe(Effect.exit))).toBe(true)

      yield* store.abortGlobalEpoch(epoch)

      expect(yield* store.currentGlobalEpoch()).toBe(0)
      expect((yield* store.load(input)).generation).toBe(active.generation)
      expect(yield* store.provide(input, Effect.map(InstanceRef, (ctx) => ctx?.globalEpoch))).toBe(0)
      expect(active.state).toBe("active")
    }),
  )

  it.effect("rejects stale global epoch tokens and concurrent transactions", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const stale = yield* store.beginGlobalEpoch([])
      expect(Exit.isFailure(yield* store.beginGlobalEpoch([]).pipe(Effect.exit))).toBe(true)
      yield* store.abortGlobalEpoch(stale)
      const current = yield* store.beginGlobalEpoch([])

      expect(current).toBeGreaterThan(stale)
      expect(Exit.isFailure(yield* store.commitGlobalEpoch(stale).pipe(Effect.exit))).toBe(true)
      expect(Exit.isSuccess(yield* store.abortGlobalEpoch(stale).pipe(Effect.exit))).toBe(true)
      expect(yield* store.currentGlobalEpoch()).toBe(0)

      yield* store.abortGlobalEpoch(current)
      expect(yield* store.currentGlobalEpoch()).toBe(0)
    }),
  )

  it.live("disposeDirectory cancels a booting candidate and prevents resurrection", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const booting = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(booting, undefined)
          yield* Deferred.await(never)
        }),
      )
      const candidate = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(booting)

      yield* store.disposeDirectory(dir)

      expect(Exit.isFailure(yield* Fiber.await(candidate))).toBe(true)
      yield* setBootstrap(Effect.void)
      const next = yield* store.load({ directory: dir })
      expect(next.generation).toBe(4)
      expect(next.state).toBe("active")
    }),
  )

  it.effect("bounds draining and interrupts generation-owned work", () =>
    Effect.gen(function* () {
      const directory = "/bounded-retirement"
      const project = {
        id: ProjectV2.ID.make("bounded-retirement"),
        worktree: directory,
        time: { created: 0, updated: 0 },
        sandboxes: [directory],
      }
      const store = yield* InstanceStore.Service
      const admitted = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const input = { directory, worktree: directory, project }
      const first = yield* store.load(input)
      const work = yield* store
        .provide(
          input,
          Effect.gen(function* () {
            yield* Deferred.succeed(admitted, undefined)
            yield* Deferred.await(never)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(admitted)

      const second = yield* store.reload(input)
      expect(second.generation).toBe(2)
      expect(first.state).toBe("draining")
      yield* TestClock.adjust("5 seconds")

      expect(Exit.isFailure(yield* Fiber.await(work))).toBe(true)
      expect(first.state).toBe("closed")
    }),
  )

  it.live("lets admitted work use its draining generation while rejecting new stale access", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const admitted = yield* Deferred.make<void>()
      const continueWork = yield* Deferred.make<void>()
      const state = yield* InstanceState.make((ctx) => Effect.succeed(ctx.generation))
      const first = yield* store.load({ directory: dir })

      const work = yield* store
        .provide(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(admitted, undefined)
            yield* Deferred.await(continueWork)
            return yield* InstanceState.get(state)
          }),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(admitted)
      const second = yield* store.reload({ directory: dir })
      expect(first.state).toBe("draining")

      const stale = yield* InstanceState.get(state).pipe(Effect.provideService(InstanceRef, first), Effect.exit)
      expect(Exit.isFailure(stale)).toBe(true)
      yield* Deferred.succeed(continueWork, undefined)
      expect(yield* Fiber.join(work)).toBe(first.generation)
      expect(second.generation).toBe(first.generation + 1)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("shares close completion across concurrent disposal paths", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      let disposed = 0
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer(() => {
            disposed++
            Deferred.doneUnsafe(disposing, Effect.void)
            return new Promise<void>((resolve) => Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve)))
          }),
        ),
        (off) => Effect.sync(off),
      )
      const ctx = yield* store.load({ directory: dir })
      const direct = yield* store.dispose(ctx).pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const directory = yield* store.disposeDirectory(dir).pipe(Effect.forkScoped)
      expect(disposed).toBe(1)
      expect(ctx.state).toBe("draining")

      yield* Effect.sync(yield* Deferred.await(releaseDispose))
      yield* Effect.all([Fiber.join(direct), Fiber.join(directory)])

      expect(disposed).toBe(1)
      expect(ctx.state).toBe("closed")
    }),
  )

  it.live("fences admission until concurrent directory disposal completes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer(() => {
            Deferred.doneUnsafe(disposing, Effect.void)
            return new Promise<void>((resolve) => Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve)))
          }),
        ),
        (off) => Effect.sync(off),
      )
      yield* store.load({ directory: dir })
      const disposal = yield* store.disposeDirectory(dir).pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)

      expect(Exit.isFailure(yield* store.load({ directory: dir }).pipe(Effect.exit))).toBe(true)

      yield* Effect.sync(yield* Deferred.await(releaseDispose))
      yield* Fiber.join(disposal)
      expect((yield* store.load({ directory: dir })).state).toBe("active")
    }),
  )

  it.live("shares one directory fence across concurrent callers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      yield* registerDisposerScoped(() => {
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve)))
      })
      yield* store.load({ directory: dir })

      const first = yield* store.disposeDirectory(dir).pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const second = yield* store.disposeDirectory(dir).pipe(Effect.forkScoped)
      expect(Exit.isFailure(yield* store.load({ directory: dir }).pipe(Effect.exit))).toBe(true)

      yield* Effect.sync(yield* Deferred.await(releaseDispose))
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect((yield* store.load({ directory: dir })).state).toBe("active")
    }),
  )

  it.live("disposeAll awaits cleanup already retiring outside active maps", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((ctx) => {
            if (ctx.generation !== 1) return Promise.resolve()
            Deferred.doneUnsafe(disposing, Effect.void)
            return new Promise<void>((resolve) => Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve)))
          }),
        ),
        (off) => Effect.sync(off),
      )
      yield* store.load({ directory: dir })
      yield* store.reload({ directory: dir })
      yield* Deferred.await(disposing)

      const all = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      expect(Exit.isFailure(yield* store.load({ directory: dir }).pipe(Effect.exit))).toBe(true)

      yield* Effect.sync(yield* Deferred.await(releaseDispose))
      yield* Fiber.join(all)
    }),
  )

  it.live("run interruption disposes only its captured generation and closes owned work", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const disposed: number[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() => registerDisposer(async (ctx) => void disposed.push(ctx.generation))),
        (off) => Effect.sync(off),
      )

      const running = yield* store
        .run(
          { directory: dir },
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(never)
          }).pipe(Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.ignore))),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(running)
      yield* Deferred.await(closed)

      const replacement = yield* store.load({ directory: dir })
      expect(disposed).toEqual([1])
      expect(replacement.generation).toBe(2)
      expect(replacement.state).toBe("active")
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )
})
