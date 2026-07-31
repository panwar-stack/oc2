import { expect } from "bun:test"
import { BackgroundJob } from "@/background/job"
import { Runner } from "@/effect/runner"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { SessionControl } from "@oc2-ai/core/session/control"

import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let backgroundLists = 0
let backgroundCancels = 0

const background = Layer.succeed(
  BackgroundJob.Service,
  BackgroundJob.Service.of({
    list: () =>
      Effect.sync(() => {
        backgroundLists++
        return []
      }),
    get: () => Effect.succeed(undefined),
    start: () => Effect.die("unexpected background start"),
    extend: () => Effect.die("unexpected background extend"),
    wait: () => Effect.die("unexpected background wait"),
    waitForPromotion: () => Effect.die("unexpected background promotion wait"),
    promote: () => Effect.die("unexpected background promotion"),
    cancel: () =>
      Effect.sync(() => {
        backgroundCancels++
        return undefined
      }),
  }),
)

const status = Layer.succeed(
  SessionStatus.Service,
  SessionStatus.Service.of({
    get: () => Effect.succeed({ type: "idle" }),
    list: () => Effect.succeed(new Map()),
    set: () => Effect.void,
  }),
)

const it = testEffect(
  SessionRunState.layer.pipe(
    Layer.provide(background),
    Layer.provide(status),
    Layer.provide(SessionControl.defaultLayer),
    Layer.provide(Database.defaultLayer),
    Layer.provide(EventV2.defaultLayer),
  ),
)

it.instance("suspend signals the runner without cancelling background jobs", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      backgroundLists = 0
      backgroundCancels = 0
      const state = yield* SessionRunState.Service
      const sessionID = SessionID.make("ses_run_state_suspend")
      const started = yield* Deferred.make<void>()
      const caller = yield* state
        .ensureRunning(
          sessionID,
          Effect.die("suspension must not use cancellation fallback"),
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      yield* state.suspend(sessionID).pipe(Effect.timeout("100 millis"))

      const exit = yield* Fiber.await(caller).pipe(Effect.timeout("100 millis"))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
      expect(backgroundLists).toBe(0)
      expect(backgroundCancels).toBe(0)
    }),
  ),
)
