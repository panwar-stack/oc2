import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { ShareNext } from "@/share/share-next"
import { Search } from "@oc2-ai/core/filesystem/search"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Reference } from "@/reference/reference"
import * as EffectLogger from "@oc2-ai/core/effect/logger"

const log = EffectLogger.create({ service: "instance.bootstrap" })

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const reference = yield* Reference.Service
    const search = yield* Search.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    // once we dispose the service - also release all the internal fff resources
    const off = registerDisposer((directory) => Effect.runPromise(search.release(directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping").pipe(Effect.annotateLogs("directory", ctx.directory))
      // everything depends on config so eager load it for nice traces
      yield* log.info("startup stage", { directory: ctx.directory, stage: "config.get", status: "started" })
      yield* config.get()
      yield* log.info("startup stage", { directory: ctx.directory, stage: "config.get", status: "completed" })
      // in 99% of use cases user that is opened opencode at certain directory will
      // conduct a file search in this direcotry, it could be switched later but
      // mostly always we will need a file picker for cwd
      // so synchronously start FFF scan for a cwd so it is ready before first toolcall generated
      yield* log.info("startup stage", { directory: ctx.directory, stage: "search.warm", status: "started" })
      yield* search.warm(ctx.directory).pipe(Effect.ignore)
      yield* log.info("startup stage", { directory: ctx.directory, stage: "search.warm", status: "completed" })
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* log.info("startup stage", { directory: ctx.directory, stage: "plugin.init", status: "started" })
      yield* plugin.init()
      yield* log.info("startup stage", { directory: ctx.directory, stage: "plugin.init", status: "completed" })
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* log.info("startup stage", { directory: ctx.directory, stage: "service.init", status: "started" })
      yield* Effect.forEach(
        [reference, lsp, shareNext, format, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      yield* log.info("startup stage", { directory: ctx.directory, stage: "service.init", status: "completed" })
      yield* log.info("startup stage", { directory: ctx.directory, stage: "bootstrap", status: "completed" })
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    Reference.defaultLayer,
    Search.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export * as InstanceBootstrap from "./bootstrap"
