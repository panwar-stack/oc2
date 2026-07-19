import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { LocationServiceMap } from "@oc2-ai/core/location-layer"
import { SessionExecution } from "@oc2-ai/core/session/execution"
import * as SessionExecutionLocal from "@oc2-ai/core/session/execution/local"
import { SessionInput } from "@oc2-ai/core/session/input"
import { SessionMessage } from "@oc2-ai/core/session/message"
import { SessionProjector } from "@oc2-ai/core/session/projector"
import { SessionSchema } from "@oc2-ai/core/session/schema"
import { SessionStore } from "@oc2-ai/core/session/store"
import { Hash } from "@oc2-ai/core/util/hash"
import { Context, Effect, Layer } from "effect"
import { Team } from "./team"

export interface Interface {
  readonly admit: (delivery: Team.RecipientDelivery) => Effect.Effect<SessionInput.ActivityAdmission>
  readonly deliverPending: (input?: {
    readonly teamID?: string
    readonly recipientSessionID?: string
  }) => Effect.Effect<SessionInput.ActivityAdmission[]>
  readonly wake: (recipientSessionID: string) => Effect.Effect<void>
  readonly recover: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamDelivery") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const team = yield* Team.Service

    const admit = Effect.fn("TeamDelivery.admit")(function* (delivery: Team.RecipientDelivery) {
      const sessionID = SessionSchema.ID.make(delivery.recipientSessionID)
      const admitted = yield* SessionInput.admitActivity(db, events, {
        id: SessionMessage.ID.make(`msg_${Hash.sha256(`team-recipient:${delivery.recipientID}`)}`),
        sessionID,
        activity: new SessionInput.TeamMessageActivity({
          type: "team_message",
          team_id: delivery.teamID,
          recipient_row_id: delivery.recipientID,
          sender: delivery.sender,
          body: delivery.body,
        }),
        delivery: "steer",
        commit: () =>
          team.commitRecipientDelivery(delivery.recipientID).pipe(
            Effect.flatMap((changed) =>
              changed ? Effect.void : Effect.die(`Recipient delivery is no longer pending: ${delivery.recipientID}`),
            ),
          ),
      })
      yield* execution.wake(sessionID, admitted.admittedSeq).pipe(Effect.ignore)
      return admitted
    })

    const deliverPending = Effect.fn("TeamDelivery.deliverPending")(function* (input?: {
      readonly teamID?: string
      readonly recipientSessionID?: string
    }) {
      return yield* Effect.forEach(yield* team.listPendingRecipientDeliveries(input), admit)
    })

    const deliverPendingBestEffort = Effect.fnUntraced(function* (input?: {
      readonly teamID?: string
      readonly recipientSessionID?: string
    }) {
      const admitted = yield* Effect.forEach(yield* team.listPendingRecipientDeliveries(input), (recipient) =>
        admit(recipient).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Team recipient admission deferred").pipe(
              Effect.annotateLogs({
                teamID: recipient.teamID,
                recipientID: recipient.recipientID,
                recipientSessionID: recipient.recipientSessionID,
                cause,
              }),
              Effect.as(undefined),
            ),
          ),
        ),
      )
      return admitted.filter((item): item is SessionInput.ActivityAdmission => item !== undefined)
    })

    const wake = Effect.fn("TeamDelivery.wake")(function* (recipientSessionID: string) {
      const sessionID = SessionSchema.ID.make(recipientSessionID)
      for (const admitted of yield* SessionInput.pendingTeamMessages(db, sessionID)) {
        yield* execution.wake(sessionID, admitted.admittedSeq).pipe(Effect.ignore)
      }
      yield* deliverPendingBestEffort({ recipientSessionID })
    })

    const recover = Effect.gen(function* () {
      for (const admitted of yield* SessionInput.pendingTeamMessages(db)) {
        yield* execution.wake(admitted.sessionID, admitted.admittedSeq).pipe(Effect.ignore)
      }
      yield* deliverPendingBestEffort()
    }).pipe(Effect.asVoid)

    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== "team.message.received") return Effect.void
      const teamID = (event.data as Record<string, unknown>).teamID
      return deliverPendingBestEffort(typeof teamID === "string" ? { teamID } : undefined).pipe(Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* recover

    return Service.of({ admit, deliverPending, wake, recover })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Team.defaultLayer),
  Layer.provide(SessionExecutionLocal.defaultLayer),
  Layer.provide(SessionProjector.layer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

export * as TeamDelivery from "./delivery"
