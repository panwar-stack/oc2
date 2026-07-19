import { TeamDelivery } from "@/team/delivery"
import { Duration, Effect } from "effect"

export const LEAD_WAKE_TIMEOUT = "1 second"

type DeliveryWake = Pick<TeamDelivery.Interface, "wake">

export function wakeTeamSession(delivery: DeliveryWake, sessionID: string) {
  return delivery.wake(sessionID)
}

export function wakeTeamSessionBounded(
  delivery: DeliveryWake,
  sessionID: string,
  duration: Duration.Input = LEAD_WAKE_TIMEOUT,
): Effect.Effect<void> {
  return wakeTeamSession(delivery, sessionID).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.void,
    }),
  )
}
