export * as SessionControl from "./control"

import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Identifier } from "../util/identifier"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionPauseBlockerTable, SessionPauseCascadeTable, SessionResumeIntentTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export const ResumeReason = Schema.Literals(["running", "queued-input", "team-wake", "background-result"])
export type ResumeReason = typeof ResumeReason.Type

export type ResumeIntent = {
  readonly sessionID: SessionSchema.ID
  readonly reason: ResumeReason
}

export type PauseResult = {
  readonly rootSessionID: SessionSchema.ID
  readonly cascadeID: string
  readonly generation: number
  readonly affectedSessionIDs: readonly SessionSchema.ID[]
  readonly unchanged: boolean
}

export type ReleaseResult = {
  readonly rootSessionID: SessionSchema.ID
  readonly cascadeID?: string
  readonly generation?: number
  readonly affectedSessionIDs: readonly SessionSchema.ID[]
  readonly stillBlockedSessionIDs: readonly SessionSchema.ID[]
  readonly resumableSessionIDs: readonly SessionSchema.ID[]
  readonly unchanged: boolean
}

export type State = {
  readonly paused: boolean
  readonly owned: boolean
  readonly blockerCascadeIDs: readonly string[]
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionControl.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

function cascadeID() {
  return `pause_${Identifier.ascending()}`
}

export function pausedSessionIDs(db: DatabaseService, sessionIDs: readonly SessionSchema.ID[]) {
  if (sessionIDs.length === 0) return Effect.succeed(new Set<SessionSchema.ID>())
  return Effect.forEach(chunk(sessionIDs), (ids) =>
    db
      .select({ sessionID: SessionPauseBlockerTable.session_id })
      .from(SessionPauseBlockerTable)
      .innerJoin(SessionPauseCascadeTable, eq(SessionPauseCascadeTable.id, SessionPauseBlockerTable.cascade_id))
      .where(and(inArray(SessionPauseBlockerTable.session_id, ids), isNull(SessionPauseCascadeTable.time_released)))
      .all()
      .pipe(Effect.orDie),
  ).pipe(Effect.map((batches) => new Set(batches.flat().map((row) => SessionSchema.ID.make(row.sessionID)))))
}

function chunk<A>(items: readonly A[], size = 500): A[][] {
  const chunks: A[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

export function isPaused(db: DatabaseService, sessionID: SessionSchema.ID) {
  return pausedSessionIDs(db, [sessionID]).pipe(Effect.map((sessionIDs) => sessionIDs.has(sessionID)))
}

export function inheritActiveBlockers(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  parentID: SessionSchema.ID | undefined,
) {
  if (!parentID) return Effect.void
  return db
    .run(
      sql`
      WITH RECURSIVE ancestor(id) AS (
        SELECT ${parentID}
        UNION
        SELECT ${SessionTable.parent_id}
        FROM ${SessionTable}
        INNER JOIN ancestor ON ${SessionTable.id} = ancestor.id
        WHERE ${SessionTable.parent_id} IS NOT NULL
      )
      INSERT OR IGNORE INTO ${SessionPauseBlockerTable} (session_id, cascade_id)
      SELECT ${sessionID}, ${SessionPauseBlockerTable.cascade_id}
      FROM ancestor
      INNER JOIN ${SessionPauseBlockerTable} ON ${SessionPauseBlockerTable.session_id} = ancestor.id
      INNER JOIN ${SessionPauseCascadeTable}
        ON ${SessionPauseCascadeTable.id} = ${SessionPauseBlockerTable.cascade_id}
      WHERE ${SessionPauseCascadeTable.time_released} IS NULL
    `,
    )
    .pipe(Effect.orDie, Effect.asVoid)
}

type TeamRow = {
  readonly teamID: string
  readonly leadSessionID: string
  readonly memberSessionID: string | null
  readonly memberStatus: string | null
}

function targetClosure(db: DatabaseService, rootSessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const sessions = yield* db
      .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
      .from(SessionTable)
      .all()
      .pipe(Effect.orDie)
    if (!sessions.some((session) => session.id === rootSessionID)) {
      return yield* new NotFoundError({ sessionID: rootSessionID })
    }

    const children = new Map<string, SessionSchema.ID[]>()
    const storedSessionIDs = new Set<string>(sessions.map((session) => session.id))
    for (const session of sessions) {
      if (!session.parentID) continue
      const list = children.get(session.parentID) ?? []
      list.push(SessionSchema.ID.make(session.id))
      children.set(session.parentID, list)
    }

    const teamRows = yield* db
      .all<TeamRow>(
        sql`
        SELECT
          team.id AS teamID,
          team.lead_session_id AS leadSessionID,
          team_member.session_id AS memberSessionID,
          team_member.status AS memberStatus
        FROM team
        LEFT JOIN team_member ON team_member.team_id = team.id
        WHERE team.status = 'active'
      `,
      )
      .pipe(Effect.orDie)
    const teams = new Map<string, SessionSchema.ID[]>()
    for (const row of teamRows) {
      const members = teams.get(row.leadSessionID) ?? []
      if (
        row.memberSessionID &&
        storedSessionIDs.has(row.memberSessionID) &&
        row.memberStatus !== "completed" &&
        row.memberStatus !== "cancelled"
      ) {
        members.push(SessionSchema.ID.make(row.memberSessionID))
      }
      teams.set(row.leadSessionID, members)
    }

    const result = new Set<SessionSchema.ID>()
    const pending = [rootSessionID]
    while (pending.length > 0) {
      const sessionID = pending.shift()
      if (!sessionID || result.has(sessionID)) continue
      result.add(sessionID)
      pending.push(...(children.get(sessionID) ?? []), ...(teams.get(sessionID) ?? []))
    }
    return [...result]
  })
}

function activeBlockers(db: DatabaseService, sessionIDs: readonly SessionSchema.ID[]) {
  if (sessionIDs.length === 0) return Effect.succeed([] as { sessionID: SessionSchema.ID; cascadeID: string }[])
  return Effect.forEach(chunk(sessionIDs), (ids) =>
    db
      .select({ sessionID: SessionPauseBlockerTable.session_id, cascadeID: SessionPauseBlockerTable.cascade_id })
      .from(SessionPauseBlockerTable)
      .innerJoin(SessionPauseCascadeTable, eq(SessionPauseCascadeTable.id, SessionPauseBlockerTable.cascade_id))
      .where(and(inArray(SessionPauseBlockerTable.session_id, ids), isNull(SessionPauseCascadeTable.time_released)))
      .all()
      .pipe(Effect.orDie),
  ).pipe(
    Effect.map((batches) =>
      batches.flat().map((row) => ({ sessionID: SessionSchema.ID.make(row.sessionID), cascadeID: row.cascadeID })),
    ),
  )
}

export interface Interface {
  readonly state: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly pause: (input: {
    readonly rootSessionID: SessionSchema.ID
    readonly resumeIntents?: readonly ResumeIntent[]
  }) => Effect.Effect<PauseResult, NotFoundError>
  readonly release: (rootSessionID: SessionSchema.ID) => Effect.Effect<ReleaseResult, NotFoundError>
  readonly setResumeIntent: (intent: ResumeIntent) => Effect.Effect<number, NotFoundError>
  readonly clearResumeIntent: (input: {
    readonly sessionID: SessionSchema.ID
    readonly generation: number
  }) => Effect.Effect<boolean>
  readonly isCascadeActive: (input: {
    readonly cascadeID: string
    readonly generation: number
  }) => Effect.Effect<boolean>
  readonly isResumeIntentCurrent: (input: {
    readonly sessionID: SessionSchema.ID
    readonly generation: number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionControl") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const setResumeIntent = Effect.fn("SessionControl.setResumeIntent")(function* (intent: ResumeIntent) {
      const session = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, intent.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return yield* new NotFoundError({ sessionID: intent.sessionID })
      const row = yield* db
        .insert(SessionResumeIntentTable)
        .values({ session_id: intent.sessionID, generation: 1, reason: intent.reason })
        .onConflictDoUpdate({
          target: SessionResumeIntentTable.session_id,
          set: {
            generation: sql`${SessionResumeIntentTable.generation} + 1`,
            reason: intent.reason,
          },
        })
        .returning({ generation: SessionResumeIntentTable.generation })
        .get()
        .pipe(Effect.orDie)
      return row.generation
    })

    const mergeResumeIntents = Effect.fn("SessionControl.mergeResumeIntents")(function* (
      affectedSessionIDs: readonly SessionSchema.ID[],
      intents: readonly ResumeIntent[],
    ) {
      const affected = new Set(affectedSessionIDs)
      for (const intent of intents) {
        if (affected.has(intent.sessionID)) yield* setResumeIntent(intent)
      }
    })

    const notifyChanged = Effect.fn("SessionControl.notifyChanged")(function* (
      sessionIDs: readonly SessionSchema.ID[],
    ) {
      for (const sessionID of sessionIDs) {
        yield* events.publish(SessionEvent.ControlChanged, { sessionID, timestamp: yield* DateTime.now })
      }
    })

    const notifyChangedBestEffort = (sessionIDs: readonly SessionSchema.ID[]) =>
      notifyChanged(sessionIDs).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.void,
        ),
      )

    return Service.of({
      state: Effect.fn("SessionControl.state")(function* (sessionID) {
        const session = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!session) return yield* new NotFoundError({ sessionID })
        const blockers = yield* activeBlockers(db, [sessionID])
        const owned = yield* db
          .select({ id: SessionPauseCascadeTable.id })
          .from(SessionPauseCascadeTable)
          .where(
            and(
              eq(SessionPauseCascadeTable.root_session_id, sessionID),
              isNull(SessionPauseCascadeTable.time_released),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return {
          paused: blockers.length > 0,
          owned: owned !== undefined,
          blockerCascadeIDs: blockers.map((x) => x.cascadeID),
        }
      }),
      pause: Effect.fn("SessionControl.pause")((input) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const affectedSessionIDs = yield* targetClosure(db, input.rootSessionID)
                const active = yield* db
                  .select()
                  .from(SessionPauseCascadeTable)
                  .where(
                    and(
                      eq(SessionPauseCascadeTable.root_session_id, input.rootSessionID),
                      isNull(SessionPauseCascadeTable.time_released),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (active) {
                  const blockers = yield* db
                    .select({ sessionID: SessionPauseBlockerTable.session_id })
                    .from(SessionPauseBlockerTable)
                    .where(eq(SessionPauseBlockerTable.cascade_id, active.id))
                    .all()
                    .pipe(Effect.orDie)
                  const activeSessionIDs = blockers.map((row) => SessionSchema.ID.make(row.sessionID))
                  yield* mergeResumeIntents(activeSessionIDs, input.resumeIntents ?? [])
                  return {
                    rootSessionID: input.rootSessionID,
                    cascadeID: active.id,
                    generation: active.generation,
                    affectedSessionIDs: activeSessionIDs,
                    unchanged: true,
                  }
                }
                const previous = yield* db
                  .select({ generation: max(SessionPauseCascadeTable.generation) })
                  .from(SessionPauseCascadeTable)
                  .where(eq(SessionPauseCascadeTable.root_session_id, input.rootSessionID))
                  .get()
                  .pipe(Effect.orDie)
                const generation = (previous?.generation ?? 0) + 1
                const id = cascadeID()
                yield* db
                  .insert(SessionPauseCascadeTable)
                  .values({
                    id,
                    root_session_id: input.rootSessionID,
                    generation,
                    time_created: Date.now(),
                  })
                  .run()
                  .pipe(Effect.orDie)
                yield* db
                  .insert(SessionPauseBlockerTable)
                  .values(affectedSessionIDs.map((sessionID) => ({ session_id: sessionID, cascade_id: id })))
                  .run()
                  .pipe(Effect.orDie)
                yield* mergeResumeIntents(affectedSessionIDs, input.resumeIntents ?? [])
                return {
                  rootSessionID: input.rootSessionID,
                  cascadeID: id,
                  generation,
                  affectedSessionIDs,
                  unchanged: false,
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error))),
            Effect.tap((result) => notifyChangedBestEffort(result.affectedSessionIDs)),
          ),
      ),
      release: Effect.fn("SessionControl.release")((rootSessionID) =>
        db
          .transaction(
            () =>
              Effect.gen(function* () {
                const session = yield* db
                  .select({ id: SessionTable.id })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, rootSessionID))
                  .get()
                  .pipe(Effect.orDie)
                if (!session) return yield* new NotFoundError({ sessionID: rootSessionID })
                const active = yield* db
                  .select()
                  .from(SessionPauseCascadeTable)
                  .where(
                    and(
                      eq(SessionPauseCascadeTable.root_session_id, rootSessionID),
                      isNull(SessionPauseCascadeTable.time_released),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (!active) {
                  const previous = yield* db
                    .select({ id: SessionPauseCascadeTable.id })
                    .from(SessionPauseCascadeTable)
                    .where(eq(SessionPauseCascadeTable.root_session_id, rootSessionID))
                    .orderBy(desc(SessionPauseCascadeTable.generation))
                    .get()
                    .pipe(Effect.orDie)
                  const affectedSessionIDs = previous
                    ? (yield* db
                        .select({ sessionID: SessionPauseBlockerTable.session_id })
                        .from(SessionPauseBlockerTable)
                        .where(eq(SessionPauseBlockerTable.cascade_id, previous.id))
                        .all()
                        .pipe(Effect.orDie)).map((row) => SessionSchema.ID.make(row.sessionID))
                    : []
                  return {
                    rootSessionID,
                    affectedSessionIDs,
                    stillBlockedSessionIDs: [],
                    resumableSessionIDs: [],
                    unchanged: true,
                  }
                }
                const affectedSessionIDs = (yield* db
                  .select({ sessionID: SessionPauseBlockerTable.session_id })
                  .from(SessionPauseBlockerTable)
                  .where(eq(SessionPauseBlockerTable.cascade_id, active.id))
                  .all()
                  .pipe(Effect.orDie)).map((row) => SessionSchema.ID.make(row.sessionID))
                yield* db
                  .update(SessionPauseCascadeTable)
                  .set({ time_released: Date.now() })
                  .where(
                    and(eq(SessionPauseCascadeTable.id, active.id), isNull(SessionPauseCascadeTable.time_released)),
                  )
                  .run()
                  .pipe(Effect.orDie)
                const blocked = new Set((yield* activeBlockers(db, affectedSessionIDs)).map((row) => row.sessionID))
                const intents = yield* db
                  .select({ sessionID: SessionResumeIntentTable.session_id })
                  .from(SessionResumeIntentTable)
                  .innerJoin(
                    SessionPauseBlockerTable,
                    eq(SessionPauseBlockerTable.session_id, SessionResumeIntentTable.session_id),
                  )
                  .where(eq(SessionPauseBlockerTable.cascade_id, active.id))
                  .all()
                  .pipe(Effect.orDie)
                return {
                  rootSessionID,
                  cascadeID: active.id,
                  generation: active.generation,
                  affectedSessionIDs,
                  stillBlockedSessionIDs: affectedSessionIDs.filter((sessionID) => blocked.has(sessionID)),
                  resumableSessionIDs: intents
                    .map((row) => SessionSchema.ID.make(row.sessionID))
                    .filter((sessionID) => !blocked.has(sessionID)),
                  unchanged: false,
                }
              }),
            { behavior: "immediate" },
          )
          .pipe(
            Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error))),
            Effect.tap((result) => notifyChangedBestEffort(result.affectedSessionIDs)),
          ),
      ),
      setResumeIntent,
      clearResumeIntent: Effect.fn("SessionControl.clearResumeIntent")(function* (input) {
        const rows = yield* db
          .delete(SessionResumeIntentTable)
          .where(
            and(
              eq(SessionResumeIntentTable.session_id, input.sessionID),
              eq(SessionResumeIntentTable.generation, input.generation),
            ),
          )
          .returning({ sessionID: SessionResumeIntentTable.session_id })
          .all()
          .pipe(Effect.orDie)
        return rows.length === 1
      }),
      isCascadeActive: Effect.fn("SessionControl.isCascadeActive")(function* (input) {
        const row = yield* db
          .select({ id: SessionPauseCascadeTable.id })
          .from(SessionPauseCascadeTable)
          .where(
            and(
              eq(SessionPauseCascadeTable.id, input.cascadeID),
              eq(SessionPauseCascadeTable.generation, input.generation),
              isNull(SessionPauseCascadeTable.time_released),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
      isResumeIntentCurrent: Effect.fn("SessionControl.isResumeIntentCurrent")(function* (input) {
        const row = yield* db
          .select({ sessionID: SessionResumeIntentTable.session_id })
          .from(SessionResumeIntentTable)
          .where(
            and(
              eq(SessionResumeIntentTable.session_id, input.sessionID),
              eq(SessionResumeIntentTable.generation, input.generation),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
