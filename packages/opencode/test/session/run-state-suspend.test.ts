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
import { SessionV1 } from "@oc2-ai/core/v1/session"

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { provideInstanceEffect, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
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

it.instance("wake signals the current park and duplicate wakes do not run replacement work", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_state_park_wake")
    const signal = yield* Deferred.make<void>()
    const park = yield* state.registerPark(sessionID, signal, Effect.die("unexpected park continuation"))
    yield* Effect.addFinalizer(() => park.unregister)
    let workRuns = 0
    const replacement = Effect.sync(() => {
      workRuns += 1
    }).pipe(Effect.andThen(Effect.die("park wake must not schedule replacement work")))

    expect(yield* state.wake(sessionID, Effect.die("unexpected interrupt fallback"), replacement)).toBe(false)
    expect(yield* Deferred.isDone(signal)).toBe(true)
    expect(yield* state.wake(sessionID, Effect.die("unexpected interrupt fallback"), replacement)).toBe(false)
    expect(workRuns).toBe(0)
  }),
)

it.instance("park handoff rearms a completed match before removing an idle registration", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_state_park_handoff")
    const first = yield* Deferred.make<void>()
    const firstPark = yield* state.registerPark(sessionID, first, Effect.die("unexpected park continuation"))
    yield* Effect.addFinalizer(() => firstPark.unregister)

    expect(yield* state.signalPark(sessionID)).toBe(true)
    expect(yield* state.signalPark(sessionID)).toBe(true)
    const replacement = yield* Deferred.make<void>()
    expect(yield* state.handoffPark(sessionID, first, replacement)).toBe(false)
    // The identity-bound handle was atomically rearmed and now notifies the replacement.
    expect(firstPark.notify()).toBe(true)
    expect(yield* Deferred.isDone(replacement)).toBe(true)

    const stable = yield* Deferred.make<void>()
    expect(yield* state.handoffPark(sessionID, replacement, stable)).toBe(false)
    const unused = yield* Deferred.make<void>()
    expect(yield* state.handoffPark(sessionID, stable, unused)).toBe(true)
    expect(yield* state.signalPark(sessionID)).toBe(false)

    // After the exact registration is removed, wake falls through to normal runner scheduling.
    const started = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => state.cancel(sessionID))
    expect(
      yield* state.wake(
        sessionID,
        Effect.die("unexpected interrupt fallback"),
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ),
    ).toBe(true)
    yield* Deferred.await(started)
  }),
)

it.instance("park cleanup is identity-safe after registration replacement", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_state_park_replace")
    const first = yield* Deferred.make<void>()
    const second = yield* Deferred.make<void>()
    const firstPark = yield* state.registerPark(sessionID, first, Effect.die("unexpected park continuation"))
    const secondPark = yield* state.registerPark(sessionID, second, Effect.die("unexpected park continuation"))
    yield* Effect.addFinalizer(() => secondPark.unregister)

    yield* firstPark.unregister
    expect(yield* state.signalPark(sessionID)).toBe(true)
    expect(yield* Deferred.isDone(first)).toBe(false)
    expect(yield* Deferred.isDone(second)).toBe(true)

    yield* secondPark.unregister
    expect(yield* state.signalPark(sessionID)).toBe(false)
  }),
)

it.instance("park registrations are isolated by instance", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const otherInstance = yield* tmpdirScoped()
    const sessionID = SessionID.make("ses_run_state_park_isolation")
    const currentSignal = yield* Deferred.make<void>()
    const otherSignal = yield* Deferred.make<void>()
    const currentPark = yield* state.registerPark(sessionID, currentSignal, Effect.die("unexpected park continuation"))
    const otherPark = yield* state
      .registerPark(sessionID, otherSignal, Effect.die("unexpected park continuation"))
      .pipe(provideInstanceEffect(otherInstance))
    yield* Effect.addFinalizer(() => Effect.all([currentPark.unregister, otherPark.unregister], { discard: true }))

    expect(yield* state.signalPark(sessionID).pipe(provideInstanceEffect(otherInstance))).toBe(true)
    expect(yield* Deferred.isDone(otherSignal)).toBe(true)
    expect(yield* Deferred.isDone(currentSignal)).toBe(false)

    expect(yield* state.signalPark(sessionID)).toBe(true)
    expect(yield* Deferred.isDone(currentSignal)).toBe(true)
  }),
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

it.instance("pause invalidates an active park before release queues its replacement run", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const state = yield* SessionRunState.Service
      const control = yield* SessionControl.Service
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const signal = yield* Deferred.make<void>()
      const parked = yield* Deferred.make<void>()
      const finalizerStarted = yield* Deferred.make<void>()
      const releaseFinalizer = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        yield* state
          .ensureRunning(
            session.id,
            Effect.die("suspension must not use cancellation fallback"),
            Effect.gen(function* () {
              yield* state.registerPark(session.id, signal, Effect.die("stale park must not continue"))
              yield* Deferred.succeed(parked, undefined)
              yield* Deferred.await(signal)
              return undefined as unknown as SessionV1.WithParts
            }).pipe(
              Effect.ensuring(
                Deferred.succeed(finalizerStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFinalizer))),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(parked)

        const paused = yield* control.pause({ rootSessionID: session.id })
        expect(paused.interruptionSignalledSessionIDs).toEqual([session.id])
        yield* Deferred.await(finalizerStarted)
        expect(yield* Deferred.isDone(signal)).toBe(false)
        expect(yield* state.signalPark(session.id)).toBe(false)

        const released = yield* control.release(session.id)
        expect(released.resumeTickets).toEqual([{ sessionID: session.id, generation: 1, reason: "running" }])
        const ticket = released.resumeTickets[0]!
        const accepted = yield* state.wake(
          session.id,
          Effect.die("suspension must not use cancellation fallback"),
          Effect.gen(function* () {
            expect(yield* control.finishResume(ticket)).toBe(true)
            yield* Deferred.succeed(replacementStarted, undefined)
            return yield* Effect.never
          }),
        )
        expect(accepted).toBe(true)
        expect(yield* control.runnableResumeTickets([session.id])).toEqual([ticket])
        expect(yield* Deferred.isDone(replacementStarted)).toBe(false)

        yield* Deferred.succeed(releaseFinalizer, undefined)
        yield* Deferred.await(replacementStarted)
        expect(yield* control.runnableResumeTickets([session.id])).toEqual([])
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(releaseFinalizer, undefined).pipe(Effect.ignore, Effect.andThen(state.cancel(session.id))),
        ),
      )
    }),
  ),
)

it.instance("a retiring park coalesces signals and continues only after its current run settles", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_state_retiring_park")
    const signal = yield* Deferred.make<void>()
    const handoffDone = yield* Deferred.make<void>()
    const releaseCurrent = yield* Deferred.make<void>()
    const continuationStarted = yield* Deferred.make<void>()
    const continuationRuns = yield* Ref.make(0)
    const continuation = Effect.gen(function* () {
      yield* Ref.update(continuationRuns, (count) => count + 1)
      yield* Deferred.succeed(continuationStarted, undefined)
      return yield* Effect.never
    })
    const current = yield* state
      .ensureRunning(
        sessionID,
        Effect.die("unexpected interrupt fallback"),
        Effect.gen(function* () {
          const park = yield* state.registerPark(sessionID, signal, continuation)
          const replacement = yield* Deferred.make<void>()
          expect(yield* state.handoffPark(sessionID, signal, replacement)).toBe(true)
          yield* Deferred.succeed(handoffDone, undefined)
          yield* Deferred.await(releaseCurrent)
          yield* park.unregister
          return undefined as unknown as SessionV1.WithParts
        }),
      )
      .pipe(Effect.forkChild)
    yield* Effect.addFinalizer(() => state.cancel(sessionID))
    yield* Deferred.await(handoffDone)

    expect(yield* state.signalPark(sessionID)).toBe(true)
    expect(yield* state.signalPark(sessionID)).toBe(true)
    expect(yield* Deferred.isDone(continuationStarted)).toBe(false)

    yield* Deferred.succeed(releaseCurrent, undefined)
    yield* Fiber.join(current)
    yield* Deferred.await(continuationStarted)
    expect(yield* Ref.get(continuationRuns)).toBe(1)

    yield* state.cancel(sessionID)
    expect(yield* state.signalPark(sessionID)).toBe(false)
    expect(yield* Ref.get(continuationRuns)).toBe(1)
  }),
)

it.instance("a rejected retiring signal falls through to the queued runner wake", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_state_rejected_retirement")
    const signal = yield* Deferred.make<void>()
    const handoffDone = yield* Deferred.make<void>()
    const finalizerStarted = yield* Deferred.make<void>()
    const releaseFinalizer = yield* Deferred.make<void>()
    const replacementStarted = yield* Deferred.make<void>()
    const continuationStarted = yield* Deferred.make<void>()

    yield* Effect.gen(function* () {
      const current = yield* state
        .ensureRunning(
          sessionID,
          Effect.die("suspension must not use cancellation fallback"),
          Effect.gen(function* () {
            const park = yield* state.registerPark(
              sessionID,
              signal,
              Deferred.succeed(continuationStarted, undefined).pipe(
                Effect.andThen(Effect.die("cancelled retirement must not continue")),
              ),
            )
            const replacement = yield* Deferred.make<void>()
            expect(yield* state.handoffPark(sessionID, signal, replacement)).toBe(true)
            yield* Deferred.succeed(handoffDone, undefined)
            yield* Effect.never
            yield* park.unregister
            return undefined as unknown as SessionV1.WithParts
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(finalizerStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFinalizer))),
            ),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(handoffDone)

      expect(yield* state.suspend(sessionID)).toBe(true)
      yield* Deferred.await(finalizerStarted)
      expect(
        yield* state.wake(
          sessionID,
          Effect.die("unexpected interrupt fallback"),
          Deferred.succeed(replacementStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ).toBe(true)
      expect(yield* Deferred.isDone(replacementStarted)).toBe(false)
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)

      yield* Deferred.succeed(releaseFinalizer, undefined)
      expect(Exit.isFailure(yield* Fiber.await(current))).toBe(true)
      yield* Deferred.await(replacementStarted)
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(releaseFinalizer, undefined).pipe(Effect.ignore, Effect.andThen(state.cancel(sessionID))),
      ),
    )
  }),
)

it.instance("a registered direct wake starts fresh work after retirement settles", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_state_settled_direct_wake")
    const handoffDone = yield* Deferred.make<void>()
    const replacementStarted = yield* Deferred.make<void>()
    const unregisterWakeTarget = yield* state.registerWakeTarget(() => ({
      onInterrupt: Effect.die("unexpected interrupt fallback"),
      work: Deferred.succeed(replacementStarted, undefined).pipe(Effect.andThen(Effect.never)),
    }))
    yield* Effect.addFinalizer(() => unregisterWakeTarget)

    const current = yield* state
      .ensureRunning(
        sessionID,
        Effect.die("unexpected interrupt fallback"),
        Effect.gen(function* () {
          const signal = yield* Deferred.make<void>()
          const park = yield* state.registerPark(sessionID, signal, Effect.die("unnotified retirement must not run"))
          const replacement = yield* Deferred.make<void>()
          expect(yield* state.handoffPark(sessionID, signal, replacement)).toBe(true)
          yield* Deferred.succeed(handoffDone, undefined)
          yield* park.unregister
          return undefined as unknown as SessionV1.WithParts
        }),
      )
      .pipe(Effect.forkChild)
    yield* Effect.addFinalizer(() => state.cancel(sessionID))

    yield* Deferred.await(handoffDone)
    yield* Fiber.join(current)
    expect(yield* state.signalPark(sessionID)).toBe(false)

    expect(yield* state.wakeRegistered(sessionID)).toBe(true)
    yield* Deferred.await(replacementStarted)
  }),
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
