import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { Runner } from "@/effect/runner"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function notFoundSession(sessionID: SessionID) {
  return ApiError.notFound(`Session not found: ${sessionID}`)
}

export function paused(sessionID: SessionID) {
  return new ApiError.SessionPausedError({
    sessionID,
    message: `Session is paused: ${sessionID}`,
  })
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

/** Keeps a paused session distinct from a busy one instead of reporting both as busy. */
export function mapBusyOrPaused<A, R>(
  sessionID: SessionID,
  self: Effect.Effect<A, Session.BusyError | Runner.Suspended, R>,
) {
  return self.pipe(
    Effect.catchTag("RunnerSuspended", () => Effect.fail(paused(sessionID))),
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

export function mapRootMutation<A, R>(self: Effect.Effect<A, StorageNotFoundError | Session.RootError, R>) {
  return self.pipe(
    Effect.catchTag("NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
    Effect.catchTag("SessionRootError", () => Effect.fail(new HttpApiError.BadRequest({}))),
  )
}
