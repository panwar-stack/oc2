import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Scope, Context } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ShareNext } from "./share-next"
import * as EffectLogger from "@oc2-ai/core/effect/logger"

const log = EffectLogger.create({ service: "session.share" })

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
      const result = yield* shareNext.create(sessionID)
      yield* session.setShare({ sessionID, share: { url: result.url } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      const started = Date.now()
      yield* log.info("create", { status: "started", hasInput: input !== undefined })
      const result = yield* session.create(input)
      yield* log.info("create", { status: "session-created", sessionID: result.id, duration: Date.now() - started })
      if (result.parentID) {
        yield* log.info("create", { status: "completed", sessionID: result.id, skippedShare: "child-session" })
        return result
      }
      const conf = yield* cfg.get()
      yield* log.info("create", { status: "config-loaded", sessionID: result.id, share: conf.share })
      if (!(flags.autoShare || conf.share === "auto")) {
        yield* log.info("create", { status: "completed", sessionID: result.id, skippedShare: "disabled" })
        return result
      }
      yield* share(result.id).pipe(Effect.ignore, Effect.forkIn(scope))
      yield* log.info("create", { status: "completed", sessionID: result.id, autoShare: true })
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as SessionShare from "./session"
