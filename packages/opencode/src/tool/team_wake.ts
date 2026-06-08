import { SessionID } from "@/session/schema"
import { Duration, Effect } from "effect"
import type { TaskPromptOps } from "./task"

export const LEAD_WAKE_TIMEOUT = "1 second"

export function wakeTeamSession(ops: TaskPromptOps, sessionID: string): Effect.Effect<void> {
  const id = SessionID.make(sessionID)
  return Effect.gen(function* () {
    // The first wake can attach a blocked session to the current turn; the second
    // gives sessions that became idle during attach a chance to consume mailbox input.
    yield* ops.wake(id).pipe(Effect.ignore)
    yield* ops.wake(id).pipe(Effect.ignore)
  })
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
