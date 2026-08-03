import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { BackgroundJob } from "@/background/job"
import { Runner } from "@/effect/runner"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TeamMessageRecipientTable } from "@/team/team.sql"
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
    // Exported to the test body so it can seed pending mailbox rows directly.
    Database.defaultLayer,
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

it.instance("pause persists a durable running resume intent only for the sessions it signals", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const control = yield* SessionControl.Service
      const sessions = yield* SessionV2.Service
      const running = yield* sessions.create({ location })
      const idle = yield* sessions.create({ location, parentID: running.id })

      const started = yield* Deferred.make<void>()
      const observedSuspension = yield* Deferred.make<SessionControl.PauseProvenance>()
      const caller = yield* state
        .ensureRunning(
          running.id,
          Effect.die("suspension must not use cancellation fallback"),
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Runner.currentSuspension.pipe(
                Effect.flatMap((current) =>
                  current._tag === "Some" && SessionControl.isPauseProvenance(current.value)
                    ? Deferred.succeed(observedSuspension, current.value)
                    : Effect.die("missing pause provenance"),
                ),
              ),
            ),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const paused = yield* control.pause({ rootSessionID: running.id })
      expect([...paused.interruptionSignalledSessionIDs]).toEqual([running.id])
      expect([...paused.affectedSessionIDs].sort()).toEqual([idle.id, running.id].sort())
      expect(yield* Deferred.await(observedSuspension).pipe(Effect.timeout("100 millis"))).toEqual({
        _tag: "SessionControl.PauseProvenance",
        rootSessionID: running.id,
        cascadeID: paused.cascadeID,
        generation: paused.generation,
      })

      // The signalled session carries a durable "running" intent; the idle child does not.
      const released = yield* control.release(running.id)
      expect(released.resumableSessionIDs).toEqual([running.id])
      expect(released.resumeTickets).toEqual([{ sessionID: running.id, generation: 1, reason: "running" }])
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

it.instance("a second pause keeps queued replacement work blocked until its release", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const control = yield* SessionControl.Service
      const sessions = yield* SessionV2.Service
      const running = yield* sessions.create({ location })
      const started = yield* Deferred.make<void>()
      const finalizerStarted = yield* Deferred.make<void>()
      const inspectSuspension = yield* Deferred.make<void>()
      const observedSuspension = yield* Deferred.make<SessionControl.PauseProvenance>()
      const releaseFinalizer = yield* Deferred.make<void>()
      const finalizerFinished = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const caller = yield* state
          .ensureRunning(
            running.id,
            Effect.die("suspension must not use cancellation fallback"),
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Deferred.succeed(finalizerStarted, undefined)
                  yield* Deferred.await(inspectSuspension)
                  yield* Runner.currentSuspension.pipe(
                    Effect.flatMap((current) =>
                      current._tag === "Some" && SessionControl.isPauseProvenance(current.value)
                        ? Deferred.succeed(observedSuspension, current.value)
                        : Effect.die("missing pause provenance"),
                    ),
                  )
                  yield* Deferred.await(releaseFinalizer)
                  yield* Deferred.succeed(finalizerFinished, undefined)
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        const pauseA = yield* control.pause({ rootSessionID: running.id })
        yield* Deferred.await(finalizerStarted)
        const callerExit = yield* Fiber.await(caller)
        expect(Exit.isFailure(callerExit)).toBe(true)
        if (Exit.isFailure(callerExit)) expect(Cause.squash(callerExit.cause)).toBeInstanceOf(Runner.Suspended)

        const releaseA = yield* control.release(running.id)
        expect(releaseA.resumeTickets).toHaveLength(1)
        const ticketA = releaseA.resumeTickets[0]!
        expect(
          yield* state.wake(
            running.id,
            Effect.die("suspension must not use cancellation fallback"),
            control
              .finishResume(ticketA)
              .pipe(
                Effect.ignore,
                Effect.andThen(Deferred.succeed(replacementStarted, undefined)),
                Effect.andThen(Effect.never),
              ),
          ),
        ).toBe(true)

        const pauseB = yield* control.pause({ rootSessionID: running.id })
        expect(pauseB.cascadeID).not.toBe(pauseA.cascadeID)
        expect(pauseB.generation).toBe(pauseA.generation + 1)
        expect(pauseB.interruptionSignalledSessionIDs).toEqual([running.id])

        yield* Deferred.succeed(inspectSuspension, undefined)
        expect(yield* Deferred.await(observedSuspension)).toEqual({
          _tag: "SessionControl.PauseProvenance",
          rootSessionID: running.id,
          cascadeID: pauseB.cascadeID,
          generation: pauseB.generation,
        })
        yield* Deferred.succeed(releaseFinalizer, undefined)
        yield* Deferred.await(finalizerFinished)
        expect(yield* Deferred.isDone(replacementStarted)).toBe(false)
        expect(yield* control.state(running.id)).toMatchObject({ paused: true })

        const releaseB = yield* control.release(running.id)
        expect(releaseB.resumeTickets).toHaveLength(1)
        const ticketB = releaseB.resumeTickets[0]!
        const accepted = yield* state.wake(
          running.id,
          Effect.die("suspension must not use cancellation fallback"),
          Effect.die("the existing queued run must be resumed"),
        )
        expect(accepted).toBe(false)
        expect(yield* control.finishResume(ticketB)).toBe(true)
        yield* Deferred.await(replacementStarted)
      }).pipe(
        Effect.ensuring(
          Effect.all([Deferred.succeed(inspectSuspension, undefined), Deferred.succeed(releaseFinalizer, undefined)], {
            discard: true,
          }).pipe(Effect.ignore, Effect.andThen(state.cancel(running.id))),
        ),
      )
    }),
  ),
)

it.instance("pause persists a durable team-wake resume intent for an idle session with a pending mailbox row", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const control = yield* SessionControl.Service
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const idle = yield* sessions.create({ location })

      const now = Date.now()
      yield* db
        .insert(TeamMessageRecipientTable)
        .values({
          id: "tmr_team_wake",
          message_id: "tmsg_team_wake",
          team_id: "team_wake",
          recipient: idle.id,
          delivery_status: "pending",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      const paused = yield* control.pause({ rootSessionID: idle.id })
      // The idle session was not interruption-signalled; only its durable intent matters.
      expect([...paused.interruptionSignalledSessionIDs]).toEqual([])

      // The mailbox row is still pending — the probe never claims it.
      expect(
        (yield* db
          .select({ status: TeamMessageRecipientTable.delivery_status })
          .from(TeamMessageRecipientTable)
          .where(eq(TeamMessageRecipientTable.id, "tmr_team_wake"))
          .get()
          .pipe(Effect.orDie))?.status,
      ).toBe("pending")

      // The durable team-wake intent lands and release() turns it into a resume ticket.
      const released = yield* control.release(idle.id)
      expect(released.resumableSessionIDs).toEqual([idle.id])
      expect(released.resumeTickets).toEqual([{ sessionID: idle.id, generation: 1, reason: "team-wake" }])
      // The ticket is finishable now that the blocker is gone, exactly like a start schedules it.
      expect(yield* control.finishResume(released.resumeTickets[0]!)).toBe(true)
    }),
  ),
)
