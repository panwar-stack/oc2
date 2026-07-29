export * as MutationCoordinator from "./mutation-coordinator"

import { GlobalBus } from "@/bus/global"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceStore } from "@/project/instance-store"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Committed, Rejected } from "./event"
import { canonicalConfigPath, contentDigest, internalWrites, restartRequired } from "./hot-reload"
import type { Config } from "./config"
import { ConfigWriteRejected, configWriteRejection, type ConfigWriteRejectionReason } from "./write-error"

export interface Result {
  readonly status: "committed" | "superseded" | "rejected"
  readonly scope: "project" | "global"
  readonly revision: number
  readonly generation: number
  readonly directories: readonly string[]
  readonly changed: boolean
  readonly restartRequired: readonly string[]
  readonly write?: Config.WriteResult
  readonly reason?: RejectionReason
  readonly message?: string
}

export type RejectionReason = ConfigWriteRejectionReason

interface Request {
  readonly scope: "project" | "global"
  readonly directory?: string
  path: string
  readonly revision: number
  readonly write: Effect.Effect<Config.WriteResult>
  readonly declaredRestart: readonly string[]
  writeResult?: Config.WriteResult
  readonly result: Deferred.Deferred<Result>
  readonly releaseMutation: Effect.Effect<void>
}

export function rejectionDiagnostic(input: unknown): { readonly reason: RejectionReason; readonly message: string } {
  if (input instanceof ConfigWriteRejected) return { reason: input.reason, message: input.publicMessage }
  const known = configWriteRejection(input)
  if (known) return known
  const name = input instanceof Error ? input.name.toLowerCase() : ""
  const tag =
    input && typeof input === "object" && "_tag" in input && typeof input._tag === "string"
      ? input._tag.toLowerCase()
      : ""
  const kind = `${name} ${tag}`
  if (kind.includes("unsupported")) return { reason: "unsupported", message: "This configuration change requires a restart." }
  if (kind.includes("parse") || kind.includes("json"))
    return { reason: "parse", message: "The configuration file could not be parsed." }
  if (kind.includes("invalid") || kind.includes("schema"))
    return { reason: "schema", message: "The configuration did not pass validation." }
  return { reason: "bootstrap", message: "The replacement configuration could not be started." }
}

export interface Interface {
  readonly project: (input: {
    readonly directory: string
    readonly path?: string
    readonly write?: Effect.Effect<Config.WriteResult>
    readonly changed?: boolean
    readonly content?: string | Uint8Array
    readonly restartRequired?: readonly string[]
  }) => Effect.Effect<Result>
  readonly global: (input: {
    readonly path?: string
    readonly write?: Effect.Effect<Config.WriteResult>
    readonly changed?: boolean
    readonly content?: string | Uint8Array
    readonly restartRequired?: readonly string[]
  }) => Effect.Effect<Result>
  readonly native: (input: {
    readonly scope: "project" | "global"
    readonly directory?: string
    readonly path: string
    readonly content: string | Uint8Array
    readonly restartRequired?: readonly string[]
  }) => Effect.Effect<Result>
  readonly shutdown: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigMutationCoordinator") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const serviceScope = yield* Scope.Scope
    const pending = new Map<string, Request[]>()
    const current = new Map<string, Request>()
    const running = new Set<string>()
    const workers = new Map<string, Fiber.Fiber<void>>()
    const followers = new Map<string, Request[]>()
    const fallback = new Map<string, { request: Request; result: Result }>()
    const rejected = new Map<string, Set<string>>()
    const dirtyDigests = new Map<string, Set<string>>()
    let closed = false
    let globalRevision = 0

    const markDirty = (path: string, digest: string) => {
      const values = dirtyDigests.get(path) ?? new Set<string>()
      values.add(digest)
      dirtyDigests.set(path, values)
    }
    const isDirty = (path: string, digest: string) => dirtyDigests.get(path)?.has(digest) === true
    const markActivated = (path: string) => dirtyDigests.delete(path)
    let activeProjectMutations = 0
    let admittedGlobalMutations = 0
    const projectWaiters: Array<Deferred.Deferred<void>> = []
    const globalWaiters: Array<Deferred.Deferred<void>> = []

    const acquireProjectMutation = (): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (admittedGlobalMutations === 0) {
          activeProjectMutations++
          return Effect.void
        }
        const waiter = Deferred.makeUnsafe<void>()
        projectWaiters.push(waiter)
        return Deferred.await(waiter).pipe(Effect.andThen(acquireProjectMutation()))
      })

    const releaseProjectMutation = Effect.fnUntraced(function* () {
      activeProjectMutations--
      if (activeProjectMutations !== 0) return
      const waiters = globalWaiters.splice(0)
      yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), { discard: true })
    })

    const acquireGlobalMutation = Effect.fnUntraced(function* () {
      admittedGlobalMutations++
      if (activeProjectMutations === 0) return
      const waiter = Deferred.makeUnsafe<void>()
      globalWaiters.push(waiter)
      yield* Deferred.await(waiter)
    })

    const releaseGlobalMutation = Effect.fnUntraced(function* () {
      admittedGlobalMutations--
      if (admittedGlobalMutations !== 0) return
      const waiters = projectWaiters.splice(0)
      yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, undefined), { discard: true })
    })

    const keyOf = (scope: "project" | "global", directory?: string) =>
      scope === "global" ? "global" : `project\0${FSUtil.resolve(directory!)}`

    const configOf = (ctx: import("@/project/instance-context").InstanceContext | undefined) => ctx?.effectiveConfig

    const publish = (
      request: Request,
      result: Result,
      error?: { readonly reason: RejectionReason; readonly message: string },
    ) =>
      Effect.sync(() => {
        const definition = error ? Rejected : Committed
        const properties = error
          ? {
              path: request.path,
              revision: request.revision,
              reason: error.reason,
              message: error.message,
            }
          : {
              revision: request.revision,
              generation: result.generation,
              scope: request.scope,
              directories: result.directories,
              restartRequired: result.restartRequired,
            }
        GlobalBus.emit("event", {
          directory: request.directory ?? "global",
          workspace: WorkspaceContext.workspaceID,
          payload: { type: definition.type, properties },
        })
      })

    const evaluate = Effect.fn("MutationCoordinator.evaluate")(function* (request: Request) {
      if (request.scope === "project") {
        const projectActive = yield* store.activeContext(request.directory!)
        const write = yield* request.write
        request.writeResult = write
        request.path = canonicalConfigPath(write.path)
        if (write.fileChanged) markDirty(request.path, write.digest)
        if (!write.fileChanged && !isDirty(request.path, write.digest)) {
          return {
            status: "committed",
            scope: request.scope,
            revision: request.revision,
            generation: 0,
            directories: [],
            changed: false,
            restartRequired: [],
            write,
          } satisfies Result
        }
        const ctx = yield* store.reload({ directory: request.directory!, revision: request.revision })
        markActivated(request.path)
        return {
          status: "committed",
          scope: request.scope,
          revision: request.revision,
          generation: ctx.generation,
          directories: [request.directory!],
          changed: ctx.revision === request.revision,
          restartRequired: [
            ...new Set([
              ...restartRequired(configOf(projectActive), configOf(ctx)),
              ...request.declaredRestart,
              ...(ctx.restartRequired ?? []),
            ]),
          ],
          write,
        } satisfies Result
      }
      const epoch = yield* store.beginGlobalEpoch()
      return yield* Effect.gen(function* () {
        const directories = yield* store.activeDirectories()
        yield* Effect.forEach(directories, (directory) => store.reserveRevision(directory, request.revision), {
          discard: true,
        })
        const globalActive = yield* Effect.forEach(directories, store.activeContext)
        const write = yield* request.write
        request.writeResult = write
        request.path = canonicalConfigPath(write.path)
        if (write.fileChanged) markDirty(request.path, write.digest)
        if (request.revision < globalRevision) {
          yield* store.abortGlobalEpoch(epoch)
          return {
            status: "superseded",
            scope: request.scope,
            revision: request.revision,
            generation: 0,
            directories: [],
            changed: false,
            restartRequired: [],
            write,
          } satisfies Result
        }
        const knownDigest = !isDirty(request.path, write.digest)
        const candidates = write.fileChanged || !knownDigest
          ? yield* Effect.forEach(
              directories,
              (directory) => store.reload({ directory, revision: request.revision, globalEpoch: epoch }),
              { concurrency: "unbounded" },
            )
          : []
        if (request.revision < globalRevision) {
          yield* store.abortGlobalEpoch(epoch)
          return {
            status: "superseded",
            scope: request.scope,
            revision: request.revision,
            generation: 0,
            directories: [],
            changed: false,
            restartRequired: [],
            write,
          } satisfies Result
        }
        const effectiveNoOp =
          knownDigest ||
          (directories.length > 0 &&
            candidates.every(
              (ctx, index) =>
                ctx.fingerprint !== undefined &&
                globalActive[index]?.fingerprint !== undefined &&
                ctx.fingerprint === globalActive[index]?.fingerprint,
            ))
        if (effectiveNoOp) {
          yield* store.abortGlobalEpoch(epoch)
          markActivated(request.path)
          return {
            status: "committed",
            scope: request.scope,
            revision: Math.max(0, ...globalActive.map((ctx) => ctx?.revision ?? 0)),
            generation: yield* store.currentGlobalEpoch(),
            directories: [],
            changed: false,
            restartRequired: [],
            write,
          } satisfies Result
        }
        yield* store.commitGlobalEpoch(epoch, request.revision)
        markActivated(request.path)
        return {
          status: "committed",
          scope: request.scope,
          revision: request.revision,
          generation: epoch,
          directories,
          changed: directories.length === 0 || candidates.some((ctx) => ctx.revision === request.revision),
          restartRequired: [
            ...new Set([
              ...candidates.flatMap((ctx, index) => restartRequired(configOf(globalActive[index]), configOf(ctx))),
              ...request.declaredRestart,
              ...candidates.flatMap((ctx) => ctx.restartRequired ?? []),
            ]),
          ],
          write,
        } satisfies Result
      }).pipe(Effect.onError(() => store.abortGlobalEpoch(epoch).pipe(Effect.ignore)))
    })

    const drain = (key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          if (closed) break
          const queue = pending.get(key)
          const request = queue?.shift()
          if (!request) break
          if (queue?.length === 0) pending.delete(key)
          current.set(key, request)
          const exit = yield* Effect.exit(evaluate(request))
          current.delete(key)
          if (closed) break
          if (pending.has(key)) {
            if (Exit.isSuccess(exit) && exit.value.status === "committed") {
              const retained = fallback.get(key)
              if (exit.value.changed || !retained) fallback.set(key, { request, result: exit.value })
              rejected.delete(request.path)
            }
            const waiting = followers.get(key) ?? []
            waiting.push(request)
            followers.set(key, waiting)
            continue
          }
          if (Exit.isSuccess(exit)) {
            const retained = fallback.get(key)
            if (exit.value.status === "committed") rejected.delete(request.path)
            if (exit.value.changed) {
              yield* publish(request, exit.value)
            } else if (retained?.result.changed) {
              yield* publish(retained.request, retained.result)
            }
            yield* Deferred.succeed(request.result, exit.value)
            yield* Effect.forEach(followers.get(key) ?? [], (follower) => Deferred.succeed(follower.result, exit.value), {
              discard: true,
            })
            yield* request.releaseMutation
            yield* Effect.forEach(followers.get(key) ?? [], (follower) => follower.releaseMutation, { discard: true })
            followers.delete(key)
            fallback.delete(key)
            continue
          }
          const error = rejectionDiagnostic(Cause.squash(exit.cause))
          const failure = Cause.squash(exit.cause)
          const result: Result = {
            status: "rejected",
            scope: request.scope,
            revision: request.revision,
            generation: 0,
            directories: [],
            changed: false,
            restartRequired: [],
            reason: error.reason,
            message: error.message,
          }
          if (failure instanceof ConfigWriteRejected) request.path = failure.path
          if (failure instanceof ConfigWriteRejected) markDirty(failure.path, failure.digest)
          const digest =
            request.writeResult?.digest ??
            (failure instanceof ConfigWriteRejected
              ? failure.digest
              : contentDigest(`${request.path}\0${request.revision}\0${crypto.randomUUID()}`))
          const dedupe = `${digest}\0${error.reason}`
          const seen = rejected.get(request.path) ?? new Set<string>()
          const retained = fallback.get(key)
          if (retained?.result.changed) yield* publish(retained.request, retained.result)
          if (!seen.has(dedupe)) {
            seen.add(dedupe)
            rejected.set(request.path, seen)
            yield* publish(request, result, error)
          }
          yield* Deferred.succeed(request.result, result)
          yield* Effect.forEach(
            followers.get(key) ?? [],
            (follower) => Deferred.succeed(follower.result, retained?.result ?? result),
            { discard: true },
          )
          yield* request.releaseMutation
          yield* Effect.forEach(followers.get(key) ?? [], (follower) => follower.releaseMutation, { discard: true })
          followers.delete(key)
          fallback.delete(key)
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running.delete(key)
            workers.delete(key)
          }),
        ),
      )

    const submit = Effect.fn("MutationCoordinator.submit")(function* (
      scope: "project" | "global",
      input: {
        readonly directory?: string
        readonly path?: string
        readonly write?: Effect.Effect<Config.WriteResult>
        readonly changed?: boolean
        readonly content?: string | Uint8Array
        readonly restartRequired?: readonly string[]
      },
    ) {
      if (closed) {
        return {
          status: "superseded",
          scope,
          revision: 0,
          generation: 0,
          directories: [],
          changed: false,
          restartRequired: [],
        } satisfies Result
      }
      const admitted = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (scope === "global") yield* acquireGlobalMutation()
          else yield* acquireProjectMutation()
          const releaseMutation = scope === "global" ? releaseGlobalMutation() : releaseProjectMutation()
          if (closed) {
            yield* releaseMutation
            return undefined
          }
          const key = keyOf(scope, input.directory)
          const directories = scope === "project" ? [input.directory!] : []
          const revision =
            scope === "global" ? yield* store.allocateGlobalRevision() : yield* store.allocateRevision(directories)
          if (scope === "global") globalRevision = revision
          const result = yield* Deferred.make<Result>()
          const request: Request = {
            scope,
            directory: input.directory === undefined ? undefined : FSUtil.resolve(input.directory),
            path: canonicalConfigPath(input.path ?? (input.directory ? `${input.directory}/oc2.json` : "global")),
            revision,
            declaredRestart: input.restartRequired ?? [],
            write:
              input.write ??
              Effect.succeed({
                fileChanged: input.changed ?? true,
                path: input.path ?? (input.directory ? `${input.directory}/oc2.json` : "global"),
                content:
                  typeof input.content === "string"
                    ? input.content
                    : input.content
                      ? new TextDecoder().decode(input.content)
                      : "",
                digest: contentDigest(input.content ?? ""),
              }),
            result,
            releaseMutation,
          }
          const queue = pending.get(key) ?? []
          queue.push(request)
          pending.set(key, queue)
          if (!running.has(key)) {
            running.add(key)
            const fiber = yield* drain(key).pipe(Effect.forkIn(serviceScope))
            workers.set(key, fiber)
          }
          return result
        }),
      )
      if (!admitted) {
        return {
          status: "superseded",
          scope,
          revision: 0,
          generation: 0,
          directories: [],
          changed: false,
          restartRequired: [],
        } satisfies Result
      }
      return yield* Deferred.await(admitted)
    })

    const shutdown = Effect.fn("MutationCoordinator.shutdown")(function* () {
      if (closed) return
      closed = true
      for (const request of new Set(
        [...pending.values()]
          .flatMap((queue) => queue)
          .concat([...current.values()], ...[...followers.values()]),
      )) {
        yield* Deferred.succeed(request.result, {
          status: "superseded",
          scope: request.scope,
          revision: request.revision,
          generation: 0,
          directories: [],
          changed: false,
          restartRequired: [],
        })
        yield* request.releaseMutation
      }
      yield* Effect.forEach(projectWaiters.splice(0), (waiter) => Deferred.succeed(waiter, undefined), { discard: true })
      yield* Effect.forEach(globalWaiters.splice(0), (waiter) => Deferred.succeed(waiter, undefined), { discard: true })
      pending.clear()
      current.clear()
      followers.clear()
      yield* Effect.forEach(workers.values(), Fiber.interrupt, { concurrency: "unbounded", discard: true })
      workers.clear()
      running.clear()
      rejected.clear()
      internalWrites.clear()
      dirtyDigests.clear()
      fallback.clear()
      globalRevision = 0
    })

    yield* Effect.addFinalizer(shutdown)
    return Service.of({
      project: (input) => submit("project", input),
      global: (input) => submit("global", input),
      native: (input) =>
        Effect.gen(function* () {
          if (internalWrites.consume(input.path, input.content)) {
            return {
              status: "superseded",
              scope: input.scope,
              revision: 0,
              generation: 0,
              directories: [],
              changed: false,
              restartRequired: [],
            } satisfies Result
          }
          markDirty(canonicalConfigPath(input.path), contentDigest(input.content))
          return yield* submit(input.scope, {
            directory: input.directory,
            path: input.path,
            write: Effect.succeed({
              fileChanged: true,
              path: input.path,
              content: typeof input.content === "string" ? input.content : new TextDecoder().decode(input.content),
              digest: contentDigest(input.content),
            }),
          })
        }),
      shutdown,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(InstanceStore.defaultLayer))

export async function write(input: {
  readonly scope: "project" | "global"
  readonly directory: string
  readonly path?: string
  readonly config: import("./config").Info
}) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { Config } = await import("./config")
  const effect = Effect.gen(function* () {
    const config = yield* Config.Service
    const coordinator = yield* Service
    if (input.scope === "global") {
      const validate = (write: Config.WriteResult) =>
        config.getGlobal().pipe(
          Effect.as(write),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            const diagnostic = rejectionDiagnostic(error)
            return Effect.die(
              new ConfigWriteRejected({
                path: write.path,
                digest: write.digest,
                reason: diagnostic.reason,
                message: diagnostic.message,
              }),
            )
          }),
        )
      const mutation = yield* coordinator.global({
        path: input.path,
        write: input.path
          ? config.updateAt(input.path, input.config, true).pipe(
              Effect.tap((result) => (result.fileChanged ? config.invalidate() : Effect.void)),
              Effect.flatMap(validate),
            )
          : config.updateGlobal(input.config).pipe(Effect.flatMap(validate)),
      })
      if (mutation.status === "rejected") {
        return yield* Effect.fail(new Error(mutation.message ?? "Configuration update was rejected."))
      }
      return { path: mutation.write?.path ?? input.path ?? "", mutation }
    }
    const mutation = yield* coordinator.project({
      directory: input.directory,
      path: input.path,
      write: input.path ? config.updateAt(input.path, input.config) : config.update(input.config),
    })
    if (mutation.status === "rejected") {
      return yield* Effect.fail(new Error(mutation.message ?? "Configuration update was rejected."))
    }
    return { path: mutation.write?.path ?? input.path ?? "", mutation }
  })
  return AppRuntime.runPromise(
    input.scope === "project"
      ? InstanceStore.Service.use((store) => store.provide({ directory: input.directory }, effect))
      : effect,
  )
}
