import { SessionID } from "@/session/schema"
import { Duration, Effect, Option } from "effect"
import type { TaskPromptOps } from "./task"
import { SessionControl } from "@oc2-ai/core/session/control"

export const LEAD_WAKE_TIMEOUT = "1 second"

export function wakeTeamSession(ops: TaskPromptOps, sessionID: string): Effect.Effect<void> {
  const id = SessionID.make(sessionID)
  const wake = Effect.gen(function* () {
    const control = yield* SessionControl.Service
    const request = yield* control.requestResume({ sessionID: id, reason: "team-wake" }).pipe(Effect.orDie)
    if (request.paused) return
    // The first wake can attach a blocked session to the current turn; the second
    // gives sessions that became idle during attach a chance to consume mailbox input.
    // The ticket travels with the first woken run and is consumed at run start (or cleared when
    // that wake attaches to a run already in flight), so a re-suspended run keeps its demand.
    yield* ops.wake(id, request.ticket).pipe(Effect.ignore)
    yield* ops.wake(id).pipe(Effect.ignore)
  })
  // Building SessionControl.defaultLayer opens its own database connection, so reuse the ambient
  // service whenever the caller already has one and only fall back for contexts without it.
  return Effect.serviceOption(SessionControl.Service).pipe(
    Effect.flatMap((control) =>
      Option.isSome(control)
        ? wake.pipe(Effect.provideService(SessionControl.Service, control.value))
        : wake.pipe(Effect.provide(SessionControl.defaultLayer)),
    ),
  )
}

export function wakeTeamSessionBounded(
  ops: TaskPromptOps,
  sessionID: string,
  duration: Duration.Input = LEAD_WAKE_TIMEOUT,
): Effect.Effect<void> {
  return wakeTeamSession(ops, sessionID).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.void,
    }),
  )
}
