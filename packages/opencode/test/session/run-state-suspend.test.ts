import { expect } from "bun:test"
import { BackgroundJob } from "@/background/job"
import { Runner } from "@/effect/runner"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { Location } from "@oc2-ai/core/location"
import { ProjectV2 } from "@oc2-ai/core/project"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SessionV2 } from "@oc2-ai/core/session"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionExecution } from "@oc2-ai/core/session/execution"
import { SessionStore } from "@oc2-ai/core/session/store"

import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

import { SessionProjector } from "@oc2-ai/core/session/projector"

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

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const sessions = SessionV2.layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)

const it = testEffect(
  Layer.mergeAll(
    // Self-contained so the run-state layer builds with its stubs and real control/db services.
    SessionRunState.layer.pipe(
      Layer.provide(background),
      Layer.provide(status),
      Layer.provide(SessionControl.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provide(EventV2.defaultLayer),
    ),
    // Exported to the test body so it can drive pause/release and create sessions directly.
    SessionControl.defaultLayer,
    sessions,
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

it.instance(
  "pause persists a durable running resume intent only for the sessions it signals",
  () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const state = yield* SessionRunState.Service
        const control = yield* SessionControl.Service
        const sessions = yield* SessionV2.Service
        const running = yield* sessions.create({ location })
        const idle = yield* sessions.create({ location, parentID: running.id })

        const started = yield* Deferred.make<void>()
        const caller = yield* state
          .ensureRunning(
            running.id,
            Effect.die("suspension must not use cancellation fallback"),
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const paused = yield* control.pause({ rootSessionID: running.id })
        expect([...paused.interruptionSignalledSessionIDs]).toEqual([running.id])
        expect([...paused.affectedSessionIDs].sort()).toEqual([idle.id, running.id].sort())

        // The signalled session carries a durable "running" intent; the idle child does not.
        const released = yield* control.release(running.id)
        expect(released.resumableSessionIDs).toEqual([running.id])
        expect(released.resumeTickets).toEqual([
          { sessionID: running.id, generation: 1, reason: "running" },
        ])
        // The ticket is finishable now that the blocker is gone, exactly like a start schedules it.
        expect(yield* control.finishResume(released.resumeTickets[0]!)).toBe(true)
        expect(yield* control.runnableResumeTickets([running.id, idle.id])).toEqual([])

        // The suspended caller resolves with the typed suspended error.
        const exit = yield* Fiber.await(caller).pipe(Effect.timeout("100 millis"))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
      }),
    ),
)
