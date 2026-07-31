import { Cause, Effect, Layer, Option, Schema } from "effect"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-layer"
import { SessionControl } from "../control"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { logFailure } from "../logging"
import { SessionEvent } from "../event"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap
    const control = yield* SessionControl.Service
    const events = yield* EventV2.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode, ownership) {
        const ticket = (yield* control.runnableResumeTickets([sessionID]))[0]
        if (!ticket) {
          if ((yield* control.state(sessionID).pipe(Effect.orDie)).paused)
            return yield* new SessionControl.SessionPausedError({ sessionID })
          return
        }
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        yield* SessionRunner.Service.use((runner) =>
          runner.run({
            sessionID,
            ticket,
            force: mode === "run" || ticket.reason === "running",
            isSuspended: ownership.isSuspended,
          }),
        ).pipe(Effect.provide(locations.get(session.location)))
        yield* control.finishResume(ticket)
      }),
      onFailure: (sessionID, cause) =>
        Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof SessionControl.SessionPausedError
          ? Effect.void
          : logFailure("Failed to drain Session", sessionID, cause),
    })
    const isControlChanged = Schema.is(SessionEvent.ControlChanged)
    const unsubscribe = yield* events.listen((event) => {
      if (!isControlChanged(event)) return Effect.void
      return control.state(event.data.sessionID).pipe(
        Effect.orDie,
        Effect.flatMap((state) => (state.paused ? coordinator.suspend(event.data.sessionID) : Effect.void)),
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    return SessionExecution.Service.of({
      interrupt: coordinator.interrupt,
      suspend: coordinator.suspend,
      resume: Effect.fn("SessionExecution.resume")(function* (sessionID) {
        const request = yield* control.requestResume({ sessionID, reason: "running" }).pipe(Effect.orDie)
        if (request.paused) return yield* new SessionControl.SessionPausedError({ sessionID })
        yield* coordinator.run(sessionID)
      }),
      wake: Effect.fn("SessionExecution.wake")(function* (sessionID, seq, suppliedTicket) {
        const request = suppliedTicket
          ? { ticket: suppliedTicket, paused: !(yield* control.isResumeTicketRunnable(suppliedTicket)) }
          : yield* control.requestResume({ sessionID, reason: "queued-input" }).pipe(Effect.orDie)
        if (request.paused) return
        yield* coordinator.wake(sessionID, seq)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionControl.defaultLayer),
)
