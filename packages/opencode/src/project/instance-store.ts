import { GlobalBus } from "@/bus/global"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { activateAdapters, releaseAdapters, retainRemovedAdapters } from "@/control-plane/adapters"
import { InstanceRef } from "@/effect/instance-ref"
import { LeaseRef } from "@/effect/instance-state"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { serviceUse } from "@oc2-ai/core/effect/service-use"
import * as EffectLogger from "@oc2-ai/core/effect/logger"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Scope, Semaphore } from "effect"
import { key as instanceKey, type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"
import { dependencyIndex } from "@/config/hot-reload"
import { Config as CoreConfig } from "@oc2-ai/core/config"

const log = EffectLogger.create({ service: "instance.store" })
export const retirementGrace = Duration.seconds(5)
class InstanceAdmissionSuperseded extends Error {}

export interface LoadInput {
  directory: string
  generation?: number
  worktree?: string
  project?: Project.Info
  /** Monotonic logical mutation revision. Defaults to the next revision for this directory. */
  revision?: number
  /** Epoch assigned by a global cutover fence. Omit for ordinary project reloads. */
  globalEpoch?: number
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly run: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly beginGlobalEpoch: (directories?: readonly string[]) => Effect.Effect<number>
  readonly commitGlobalEpoch: (epoch: number, revision?: number) => Effect.Effect<void>
  readonly abortGlobalEpoch: (epoch: number) => Effect.Effect<void>
  readonly currentGlobalEpoch: () => Effect.Effect<number>
  readonly activeDirectories: () => Effect.Effect<readonly string[]>
  readonly reserveRevision: (directory: string, revision: number) => Effect.Effect<void>
  readonly allocateGlobalRevision: () => Effect.Effect<number>
  readonly allocateRevision: (directories: readonly string[]) => Effect.Effect<number>
  readonly activeContext: (directory: string) => Effect.Effect<InstanceContext | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}
export const use = serviceUse(Service)

interface Entry {
  readonly generation: number
  readonly deferred: Deferred.Deferred<InstanceContext>
  readonly drained: Deferred.Deferred<void>
  readonly scope: Scope.Closeable
  readonly closed: Deferred.Deferred<void>
  readonly admission: { readonly directory: number; readonly global: number }
  readonly revision: number
  readonly candidate: boolean
  ctx?: InstanceContext
  leases: number
  activated: boolean
  closing: boolean
  readonly committedRevisions: Set<number>
}

interface GlobalParticipant {
  readonly entry: Entry
  readonly noOp: boolean
}

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const storeScope = yield* Scope.Scope
    const active = new Map<string, Entry>()
    const initial = new Map<string, Entry>()
    const candidates = new Map<string, Set<Entry>>()
    const newest = new Map<string, number>()
    const newestRevision = new Map<string, number>()
    const newestGenerationForRevision = new Map<string, number>()
    const directoryEpoch = new Map<string, number>()
    const directoryDisposals = new Map<string, Deferred.Deferred<void>>()
    const retiring = new Set<Entry>()
    const entriesByKey = new Map<string, Entry>()
    let globalEpoch = 0
    let newestGlobalRevision = 0
    const activationLock = Semaphore.makeUnsafe(1)
    let nextGlobalEpoch = 0
    let globalDisposal: Deferred.Deferred<void> | undefined
    let globalTransaction:
      | {
          readonly epoch: number
          readonly admission: Deferred.Deferred<void>
          readonly expected: ReadonlySet<string>
          readonly participants: Map<string, GlobalParticipant>
          state: "open" | "committing" | "aborting"
        }
      | undefined
    const closedGlobalTransactions = new Map<number, "committed" | "aborted">()

    const nextGeneration = (directory: string) => {
      const generation = (newest.get(directory) ?? 0) + 1
      newest.set(directory, generation)
      return generation
    }

    const makeEntry = Effect.fnUntraced(function* (directory: string, input: LoadInput, candidate: boolean) {
      const transaction = globalTransaction
      if (transaction && input.globalEpoch !== transaction.epoch) yield* Deferred.await(transaction.admission)
      if (globalDisposal || directoryDisposals.has(directory)) {
        return yield* Effect.die(new Error(`instance admission fenced during disposal: ${directory}`))
      }
      const entry: Entry = {
        generation: nextGeneration(directory),
        deferred: yield* Deferred.make<InstanceContext>(),
        drained: yield* Deferred.make<void>(),
        scope: yield* Scope.make(),
        closed: yield* Deferred.make<void>(),
        admission: { directory: directoryEpoch.get(directory) ?? 0, global: input.globalEpoch ?? globalEpoch },
        revision: input.revision ?? (newestRevision.get(directory) ?? 0) + 1,
        candidate,
        leases: 0,
        activated: false,
        closing: false,
        committedRevisions: new Set(),
      }
      const previousRevision = newestRevision.get(directory) ?? 0
      if (entry.revision >= previousRevision) {
        newestRevision.set(directory, entry.revision)
        newestGenerationForRevision.set(directory, entry.generation)
      }
      const pending = candidates.get(directory) ?? new Set<Entry>()
      pending.add(entry)
      candidates.set(directory, pending)
      return entry
    })

    const removeCandidate = (directory: string, entry: Entry) => {
      const pending = candidates.get(directory)
      pending?.delete(entry)
      if (pending?.size === 0) candidates.delete(directory)
    }

    const emitDisposed = (ctx: InstanceContext) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: ctx.directory,
          project: ctx.project.id,
          workspace: WorkspaceContext.workspaceID,
          generation: ctx.generation,
          payload: {
            type: "server.instance.disposed",
            properties: { directory: ctx.directory, generation: ctx.generation },
          },
        }),
      )

    const close = Effect.fn("InstanceStore.close")((entry: Entry) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (entry.closing) {
            yield* Deferred.await(entry.closed)
            return
          }
          entry.closing = true
          retiring.add(entry)
          yield* Effect.gen(function* () {
          const ctx = entry.ctx
          if (ctx) {
            yield* Effect.promise(() => runDisposers(ctx, { activated: entry.activated }))
            releaseAdapters(ctx.project.id, instanceKey(ctx))
          }
          yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
          if (ctx) {
            ctx.state = "closed"
            dependencyIndex.remove({ directory: ctx.directory, generation: ctx.generation })
            for (const revision of entry.committedRevisions) {
              CoreConfig.removeCommitted(ctx.directory, ctx.generation, revision)
            }
            if (entry.activated) yield* emitDisposed(ctx)
          }
          }).pipe(
          Effect.ensuring(
            Deferred.succeed(entry.closed, undefined).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  retiring.delete(entry)
                  if (entry.ctx) entriesByKey.delete(instanceKey(entry.ctx))
                }),
              ),
              Effect.ignore,
            ),
          ),
          )
        }),
      ),
    )

    const transitionToRetiring = Effect.fnUntraced(function* (entry: Entry) {
      const ctx = entry.ctx
      if (ctx && ctx.state !== "closed") ctx.state = "draining"
      if (entry.leases === 0) yield* Deferred.succeed(entry.drained, undefined).pipe(Effect.ignore)
    })

    const retire = Effect.fnUntraced(function* (entry: Entry) {
      yield* transitionToRetiring(entry)
      if (entry.leases !== 0) yield* Deferred.await(entry.drained).pipe(Effect.timeout(retirementGrace), Effect.ignore)
      yield* close(entry)
    })

    const boot = Effect.fn("InstanceStore.boot")(function* (
      input: LoadInput & { directory: string },
      entry: Entry,
    ) {
      const started = Date.now()
      const resolved =
        input.project && input.worktree
          ? { project: input.project, sandbox: input.worktree }
          : yield* project.fromDirectory(input.directory)
      const ctx: InstanceContext = {
        directory: input.directory,
        generation: entry.generation,
        state: "booting",
        globalEpoch: entry.admission.global,
        revision: entry.revision,
        fingerprint: "",
        configDependencies: [],
        coreConfigEntries: [],
        candidate: entry.candidate,
        worktree: resolved.sandbox,
        project: resolved.project,
      }
      entry.ctx = ctx
      entriesByKey.set(instanceKey(ctx), entry)
      yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(Scope.Scope, entry.scope))
      yield* log.info("startup stage", {
        directory: input.directory,
        generation: entry.generation,
        projectID: ctx.project.id,
        stage: "boot",
        status: "completed",
        duration: Date.now() - started,
      })
      return ctx
    })

    const runBoot = (input: LoadInput & { directory: string }, entry: Entry) =>
      boot(input, entry).pipe(Effect.forkIn(entry.scope, { startImmediately: true }), Effect.flatMap(Fiber.join))

    const canActivate = (directory: string, entry: Entry) =>
      !entry.closing &&
      !globalTransaction &&
      !globalDisposal &&
      !directoryDisposals.has(directory) &&
      entry.admission.global === globalEpoch &&
      entry.admission.directory === (directoryEpoch.get(directory) ?? 0) &&
      entry.revision === newestRevision.get(directory) &&
      entry.generation === newestGenerationForRevision.get(directory)

    const commitDependencies = (previous: InstanceContext | undefined, ctx: InstanceContext) =>
      Effect.sync(() => {
        dependencyIndex.replace(
          previous ? { directory: previous.directory, generation: previous.generation } : undefined,
          { directory: ctx.directory, generation: ctx.generation },
          ctx.configDependencies ?? [],
        )
        CoreConfig.commit(
          ctx.directory,
          ctx.generation,
          ctx.revision ?? 0,
          ctx.coreConfigEntries ?? [],
        )
        entriesByKey.get(instanceKey(ctx))?.committedRevisions.add(ctx.revision ?? 0)
      })

    const canStage = (directory: string, entry: Entry) =>
      !entry.closing &&
      !globalDisposal &&
      !directoryDisposals.has(directory) &&
      entry.admission.global === globalTransaction?.epoch &&
      entry.admission.directory === (directoryEpoch.get(directory) ?? 0) &&
      entry.revision === newestRevision.get(directory) &&
      entry.generation === newestGenerationForRevision.get(directory)

    const waitForGlobalAdmission = () =>
      globalTransaction ? Deferred.await(globalTransaction.admission) : Effect.void

    const abortTransaction = Effect.fnUntraced(function* (
      transaction: NonNullable<typeof globalTransaction>,
      extra?: Entry,
    ) {
      if (globalTransaction !== transaction || transaction.state !== "open") return
      transaction.state = "aborting"
      yield* Effect.forEach(
        new Set([...transaction.participants.values()].map((item) => item.entry).concat(extra ? [extra] : [])),
        close,
        { concurrency: "unbounded", discard: true },
      )
      if (globalTransaction === transaction) globalTransaction = undefined
      closedGlobalTransactions.set(transaction.epoch, "aborted")
      yield* Deferred.succeed(transaction.admission, undefined).pipe(Effect.ignore)
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = active.get(directory)
          if (current) {
            if (input.generation !== undefined && current.generation !== input.generation) {
              return yield* Effect.die(new Error(`instance generation mismatch: expected ${input.generation}`))
            }
            return yield* restore(Deferred.await(current.deferred))
          }
          if (input.generation !== undefined) {
            return yield* Effect.die(new Error(`instance generation is no longer active: ${input.generation}`))
          }
          const pending = initial.get(directory)
          if (pending) return yield* restore(Deferred.await(pending.deferred))

          if (globalTransaction) yield* restore(waitForGlobalAdmission())
          const entry = yield* makeEntry(directory, input, false)
          initial.set(directory, entry)
          yield* Effect.gen(function* () {
            const exit = yield* Effect.exit(runBoot({ ...input, directory }, entry))
            if (initial.get(directory) === entry) initial.delete(directory)
            removeCandidate(directory, entry)
            if (
              Exit.isSuccess(exit) &&
              canActivate(directory, entry) &&
              !active.has(directory)
            ) {
              entry.activated = true
              exit.value.state = "active"
              active.set(directory, entry)
              yield* commitDependencies(undefined, exit.value)
              activateAdapters(exit.value.project.id, instanceKey(exit.value))
              yield* Deferred.succeed(entry.deferred, exit.value)
            } else {
              yield* close(entry)
              if (Exit.isFailure(exit)) yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
              else yield* Deferred.die(entry.deferred, new InstanceAdmissionSuperseded())
            }
          }).pipe(Effect.forkIn(storeScope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(
        Effect.catchDefect((error) =>
          error instanceof InstanceAdmissionSuperseded ? load(input) : Effect.die(error),
        ),
        Effect.withSpan("InstanceStore.load"),
      )
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (globalTransaction && input.globalEpoch !== globalTransaction.epoch) {
            return yield* Effect.die(new Error("global config epoch is fenced"))
          }
          const entry = yield* makeEntry(directory, input, true)
          yield* Effect.gen(function* () {
            const exit = yield* Effect.exit(runBoot({ ...input, directory }, entry))
            removeCandidate(directory, entry)
            const transaction = globalTransaction
            const staged = input.globalEpoch !== undefined && input.globalEpoch === transaction?.epoch
            if (Exit.isFailure(exit) || !(staged ? canStage(directory, entry) : canActivate(directory, entry))) {
              if (staged) yield* abortTransaction(transaction, entry)
              else yield* close(entry)
              if (Exit.isFailure(exit)) yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
              else yield* Deferred.die(entry.deferred, new Error("instance candidate superseded"))
              return
            }
            const previous = active.get(directory)
            const noOp =
              previous?.ctx?.fingerprint &&
              exit.value.fingerprint &&
              previous.ctx.fingerprint === exit.value.fingerprint
            if (staged) {
              const replaced = transaction.participants.get(directory)
              transaction.participants.set(directory, { entry, noOp: Boolean(noOp) })
              if (replaced) yield* close(replaced.entry)
              yield* Deferred.succeed(entry.deferred, exit.value)
              return
            }
            if (noOp) {
              yield* close(entry)
              yield* Deferred.succeed(entry.deferred, previous!.ctx!)
              return
            }
            entry.activated = true
            exit.value.state = "active"
            active.set(directory, entry)
            yield* commitDependencies(previous?.ctx, exit.value)
            if (previous?.ctx) {
              const removed = retainRemovedAdapters(
                exit.value.project.id,
                instanceKey(previous.ctx),
                instanceKey(exit.value),
              )
              if (removed.length) exit.value.restartRequired = [...new Set([...(exit.value.restartRequired ?? []), "plugin"])]
            }
            activateAdapters(exit.value.project.id, instanceKey(exit.value))
            if (previous) {
              // Complete the admission transition before publishing readiness;
              // draining and finalization continue asynchronously.
              yield* transitionToRetiring(previous)
              yield* retire(previous).pipe(Effect.forkIn(storeScope, { startImmediately: true }))
            }
            yield* Deferred.succeed(entry.deferred, exit.value)
          }).pipe(Effect.forkIn(storeScope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const release = Effect.fnUntraced(function* (entry: Entry) {
      entry.leases--
      if (entry.leases === 0 && entry.ctx?.state === "draining") {
        yield* Deferred.succeed(entry.drained, undefined).pipe(Effect.ignore)
      }
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (globalTransaction) yield* restore(waitForGlobalAdmission())
          const ctx = yield* restore(load(input))
          const entry = active.get(ctx.directory)
          if (!entry || entry.ctx !== ctx || ctx.state !== "active") return yield* restore(provide(input, effect))
          entry.leases++
          const fiber = yield* effect.pipe(
            Effect.provideService(InstanceRef, ctx),
            Effect.provideService(LeaseRef, instanceKey(ctx)),
            Effect.forkIn(entry.scope, { startImmediately: true }),
          )
          return yield* restore(Fiber.join(fiber)).pipe(Effect.ensuring(release(entry)))
        }),
      )

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const current = active.get(ctx.directory)
      const entry = current?.ctx === ctx ? current : entriesByKey.get(instanceKey(ctx))
      if (!entry) return
      if (current === entry) active.delete(ctx.directory)
      yield* retire(entry)
    })

    const run = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (globalTransaction) yield* restore(waitForGlobalAdmission())
          const ctx = yield* restore(load(input))
          const entry = active.get(ctx.directory)
          if (!entry || entry.ctx !== ctx || ctx.state !== "active") return yield* restore(run(input, effect))
          entry.leases++
          const fiber = yield* effect.pipe(
            Effect.provideService(InstanceRef, ctx),
            Effect.provideService(LeaseRef, instanceKey(ctx)),
            Effect.forkIn(entry.scope, { startImmediately: true }),
          )
          return yield* restore(Fiber.join(fiber)).pipe(
            Effect.ensuring(Fiber.interrupt(fiber).pipe(Effect.andThen(release(entry)), Effect.andThen(dispose(ctx)))),
          )
        }),
      )

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")((input: string) => activationLock.withPermit(Effect.gen(function* () {
      const directory = FSUtil.resolve(input)
      const existing = directoryDisposals.get(directory)
      if (existing) return yield* Deferred.await(existing)
      if (globalDisposal) return yield* Deferred.await(globalDisposal)
      const fence = yield* Deferred.make<void>()
      directoryDisposals.set(directory, fence)
      const transaction = globalTransaction
      if (transaction?.expected.has(directory)) yield* abortTransaction(transaction)
      directoryEpoch.set(directory, (directoryEpoch.get(directory) ?? 0) + 1)
      newest.set(directory, (newest.get(directory) ?? 0) + 1)
      const pending = [...(candidates.get(directory) ?? [])]
      candidates.delete(directory)
      initial.delete(directory)
      const entry = active.get(directory)
      if (entry) active.delete(directory)
      const exact = new Set([
        ...pending,
        ...(entry ? [entry] : []),
        ...[...retiring].filter((item) => item.ctx?.directory === directory),
        ...[...entriesByKey.values()].filter((item) => item.ctx?.directory === directory),
      ])
      yield* Effect.forEach(exact, retire, { concurrency: "unbounded", discard: true }).pipe(
        Effect.ensuring(
          Effect.sync(() => directoryDisposals.delete(directory)).pipe(
            Effect.andThen(Deferred.succeed(fence, undefined)),
            Effect.ignore,
          ),
        ),
      )
      return yield* Deferred.await(fence)
    })))

    const disposeAllOnce = Effect.fnUntraced(function* () {
      const callerLease = yield* LeaseRef
      if (globalDisposal) {
        if (callerLease) return
        return yield* Deferred.await(globalDisposal)
      }
      const transaction = globalTransaction
      if (transaction) {
        yield* Effect.forEach(transaction.participants.values(), (item) => close(item.entry), {
          concurrency: "unbounded",
          discard: true,
        })
        globalTransaction = undefined
        closedGlobalTransactions.set(transaction.epoch, "aborted")
        yield* Deferred.succeed(transaction.admission, undefined).pipe(Effect.ignore)
      }
      const fence = yield* Deferred.make<void>()
      globalDisposal = fence
      globalEpoch++
      nextGlobalEpoch = Math.max(nextGlobalEpoch, globalEpoch)
      for (const directory of new Set([...active.keys(), ...candidates.keys()])) {
        newest.set(directory, (newest.get(directory) ?? 0) + 1)
      }
      const pending = [...candidates.values()].flatMap((entries) => [...entries])
      candidates.clear()
      initial.clear()
      const entries = [...active.values()]
      active.clear()
      const exact = new Set([...pending, ...entries, ...retiring, ...entriesByKey.values()])
      const directoryFences = [...directoryDisposals.values()]
      const cleanup = Effect.all([
        Effect.forEach(exact, retire, { concurrency: "unbounded", discard: true }),
        Effect.forEach(directoryFences, Deferred.await, { concurrency: "unbounded", discard: true }),
      ]).pipe(
        Effect.ensuring(
          Effect.sync(() => (globalDisposal = undefined)).pipe(
            Effect.andThen(Deferred.succeed(fence, undefined)),
            Effect.ignore,
          ),
        ),
      )
      // A disposal requested from admitted work cannot await retirement of its own lease. Schedule the
      // process-wide cleanup; the store finalizer (outside the lease) still awaits the same fence.
      if (callerLease) {
        yield* cleanup.pipe(Effect.forkIn(storeScope, { startImmediately: true }))
        return
      }
      yield* cleanup
      return yield* Deferred.await(fence)
    })
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      yield* activationLock.withPermit(disposeAllOnce())
    })

    const beginGlobalEpoch = Effect.fn("InstanceStore.beginGlobalEpoch")((inputs?: readonly string[]) => activationLock.withPermit(Effect.gen(function* () {
      if (globalTransaction) return yield* Effect.die(new Error("global config epoch is already fenced"))
      if (globalDisposal) return yield* Effect.die(new Error("global config epoch is fenced during disposal"))
      const participants = inputs ?? [...new Set([...active.keys(), ...initial.keys(), ...candidates.keys()])]
      const expected = new Set(participants.map(FSUtil.resolve))
      if (expected.size !== participants.length) return yield* Effect.die(new Error("global config epoch contains duplicate participants"))
      const epoch = Math.max(nextGlobalEpoch, globalEpoch) + 1
      nextGlobalEpoch = epoch
      globalTransaction = {
        epoch,
        admission: yield* Deferred.make<void>(),
        expected,
        participants: new Map(),
        state: "open",
      }
      return epoch
    })))

    const transactionFor = (epoch: number) => {
      const transaction = globalTransaction
      if (!transaction || transaction.epoch !== epoch) {
        return Effect.die(new Error(`stale global config epoch: ${epoch}`))
      }
      return Effect.succeed(transaction)
    }

    const commitGlobalEpoch = Effect.fn("InstanceStore.commitGlobalEpoch")((epoch: number, revision?: number) => activationLock.withPermit(Effect.uninterruptible(Effect.gen(function* () {
      const terminal = closedGlobalTransactions.get(epoch)
      if (terminal === "committed") return
      if (terminal === "aborted") return yield* Effect.die(new Error(`global config epoch was aborted: ${epoch}`))
      const transaction = yield* transactionFor(epoch)
      if (transaction.state !== "open") return yield* Effect.die(new Error(`global config epoch is ${transaction.state}`))
      transaction.state = "committing"
      const missing = [...transaction.expected].filter((directory) => !transaction.participants.has(directory))
      const unexpected = [...transaction.participants.keys()].filter((directory) => !transaction.expected.has(directory))
      if (missing.length || unexpected.length) {
        transaction.state = "open"
        return yield* Effect.die(new Error(`global config epoch participants are incomplete`))
      }
      for (const [directory, participant] of transaction.participants) {
        if (!canStage(directory, participant.entry)) {
          transaction.state = "open"
          return yield* Effect.die(new Error(`global config epoch participant is stale: ${directory}`))
        }
      }
      if (revision !== undefined && revision !== newestGlobalRevision) {
        transaction.state = "aborting"
        yield* Effect.forEach(transaction.participants.values(), (item) => close(item.entry), {
          concurrency: "unbounded",
          discard: true,
        })
        globalTransaction = undefined
        closedGlobalTransactions.set(epoch, "aborted")
        yield* Deferred.succeed(transaction.admission, undefined).pipe(Effect.ignore)
        return yield* Effect.die(new Error(`global config revision is stale: ${revision}`))
      }
      globalEpoch = epoch
      for (const [directory, participant] of transaction.participants) {
        const entry = participant.entry
        const previous = active.get(directory)
        if (participant.noOp && previous?.ctx && entry.ctx) {
          CoreConfig.commit(directory, previous.generation, entry.revision, entry.ctx.coreConfigEntries ?? [])
          previous.committedRevisions.add(entry.revision)
          dependencyIndex.replace(
            { directory, generation: previous.generation },
            { directory, generation: previous.generation },
            entry.ctx.configDependencies ?? [],
          )
          previous.ctx.globalEpoch = epoch
          previous.ctx.revision = entry.revision
          previous.ctx.configDependencies = entry.ctx.configDependencies
          previous.ctx.coreConfigEntries = entry.ctx.coreConfigEntries
          previous.ctx.effectiveConfig = entry.ctx.effectiveConfig
          yield* close(entry)
          continue
        }
        entry.activated = true
        if (entry.ctx) entry.ctx.state = "active"
        active.set(directory, entry)
        if (entry.ctx) {
          yield* commitDependencies(previous?.ctx, entry.ctx)
          if (previous?.ctx) {
            const removed = retainRemovedAdapters(
              entry.ctx.project.id,
              instanceKey(previous.ctx),
              instanceKey(entry.ctx),
            )
            if (removed.length) entry.ctx.restartRequired = [...new Set([...(entry.ctx.restartRequired ?? []), "plugin"])]
          }
          activateAdapters(entry.ctx.project.id, instanceKey(entry.ctx))
        }
        if (previous) {
          yield* transitionToRetiring(previous)
          yield* retire(previous).pipe(Effect.forkIn(storeScope, { startImmediately: true }))
        }
      }
      globalTransaction = undefined
      closedGlobalTransactions.set(epoch, "committed")
      yield* Deferred.succeed(transaction.admission, undefined).pipe(Effect.ignore)
    }))))

    const abortGlobalEpoch = Effect.fn("InstanceStore.abortGlobalEpoch")((epoch: number) => Effect.uninterruptible(Effect.gen(function* () {
      const terminal = closedGlobalTransactions.get(epoch)
      if (terminal === "aborted") return
      if (terminal === "committed") return yield* Effect.die(new Error(`global config epoch was committed: ${epoch}`))
      const transaction = yield* transactionFor(epoch)
      if (transaction.state !== "open") return yield* Effect.die(new Error(`global config epoch is ${transaction.state}`))
      transaction.state = "aborting"
      yield* Effect.forEach(transaction.participants.values(), (item) => close(item.entry), {
        concurrency: "unbounded",
        discard: true,
      })
      globalTransaction = undefined
      closedGlobalTransactions.set(epoch, "aborted")
      yield* Deferred.succeed(transaction.admission, undefined).pipe(Effect.ignore)
    })))

    const currentGlobalEpoch = Effect.fn("InstanceStore.currentGlobalEpoch")(function* () {
      return globalEpoch
    })

    const activeDirectories = Effect.fn("InstanceStore.activeDirectories")(function* () {
      return [...(globalTransaction?.expected ?? active.keys())].sort()
    })

    const reserveRevision = Effect.fn("InstanceStore.reserveRevision")(function* (input: string, revision: number) {
      const directory = FSUtil.resolve(input)
      if (revision > (newestRevision.get(directory) ?? 0)) newestRevision.set(directory, revision)
    })

    const allocateGlobalRevision = Effect.fn("InstanceStore.allocateGlobalRevision")(function* () {
      const directories = [...new Set([...active.keys(), ...initial.keys(), ...candidates.keys()])]
      newestGlobalRevision = Math.max(
        newestGlobalRevision,
        ...directories.map((directory) => newestRevision.get(directory) ?? active.get(directory)?.ctx?.revision ?? 0),
      ) + 1
      for (const directory of directories) newestRevision.set(directory, newestGlobalRevision)
      return newestGlobalRevision
    })

    const allocateRevision = Effect.fn("InstanceStore.allocateRevision")(function* (inputs: readonly string[]) {
      const directories = inputs.map(FSUtil.resolve)
      const revision = Math.max(0, ...directories.map((directory) => newestRevision.get(directory) ?? 0)) + 1
      for (const directory of directories) newestRevision.set(directory, revision)
      return revision
    })

    const activeContext = Effect.fn("InstanceStore.activeContext")(function* (input: string) {
      return active.get(FSUtil.resolve(input))?.ctx
    })

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))
    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
      run,
      beginGlobalEpoch,
      commitGlobalEpoch,
      abortGlobalEpoch,
      currentGlobalEpoch,
      activeDirectories,
      reserveRevision,
      allocateGlobalRevision,
      allocateRevision,
      activeContext,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))
export * as InstanceStore from "./instance-store"
