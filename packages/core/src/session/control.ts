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

export type ResumeTicket = ResumeIntent & {
  readonly generation: number
}

export type ResumeRequest = {
  readonly ticket: ResumeTicket
  /** Effective pause state captured in the same transaction that persisted the intent. */
  readonly paused: boolean
}

export type PauseResult = {
  readonly rootSessionID: SessionSchema.ID
  readonly cascadeID: string
  readonly generation: number
  readonly affectedSessionIDs: readonly SessionSchema.ID[]
  /** Sessions that had live work and received a direct interruption signal from this pause. */
  readonly interruptionSignalledSessionIDs: readonly SessionSchema.ID[]
  readonly unchanged: boolean
}

/**
 * Runtime handler that turns a committed pause barrier into an actual interruption.
 * It must return without waiting for interrupted fibers to unwind, and it must answer
 * with the subset of sessions it actually signalled.
 */
export type Interrupter = (sessionIDs: readonly SessionSchema.ID[]) => Effect.Effect<readonly SessionSchema.ID[]>

export type ReleaseResult = {
  readonly rootSessionID: SessionSchema.ID
  readonly cascadeID?: string
  readonly generation?: number
  readonly affectedSessionIDs: readonly SessionSchema.ID[]
  readonly stillBlockedSessionIDs: readonly SessionSchema.ID[]
  readonly resumableSessionIDs: readonly SessionSchema.ID[]
  readonly resumeTickets: readonly ResumeTicket[]
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

export class SessionPausedError extends Schema.TaggedErrorClass<SessionPausedError>()("Session.PausedError", {
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

export function isTicketRunnable(db: DatabaseService, ticket: ResumeTicket) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ sessionID: SessionResumeIntentTable.session_id })
      .from(SessionResumeIntentTable)
      .where(
        and(
          eq(SessionResumeIntentTable.session_id, ticket.sessionID),
          eq(SessionResumeIntentTable.generation, ticket.generation),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return row !== undefined && !(yield* isPaused(db, ticket.sessionID))
  })
}

const upsertResumeIntent = Effect.fn("SessionControl.upsertResumeIntent")(function* (
  db: DatabaseService,
  intent: ResumeIntent,
  preserveRunning = true,
) {
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
        // An active run must not be downgraded by advisory work arriving while it is being paused.
        reason: preserveRunning
          ? sql`CASE
              WHEN ${SessionResumeIntentTable.reason} = 'running' OR ${intent.reason} = 'running' THEN 'running'
              ELSE ${intent.reason}
            END`
          : intent.reason,
      },
    })
    .returning({
      generation: SessionResumeIntentTable.generation,
      reason: SessionResumeIntentTable.reason,
    })
    .get()
    .pipe(Effect.orDie)
  return {
    sessionID: intent.sessionID,
    generation: row.generation,
    reason: row.reason,
  } satisfies ResumeTicket
})

export const requestResumeInTransaction = Effect.fn("SessionControl.requestResumeInTransaction")(function* (
  db: DatabaseService,
  intent: ResumeIntent,
) {
  const paused = (yield* activeBlockers(db, [intent.sessionID])).length > 0
  const existing = yield* db
    .select({ generation: SessionResumeIntentTable.generation, reason: SessionResumeIntentTable.reason })
    .from(SessionResumeIntentTable)
    .where(eq(SessionResumeIntentTable.session_id, intent.sessionID))
    .get()
    .pipe(Effect.orDie)
  const ticket =
    intent.reason === "running" && existing?.reason === "running"
      ? ({ sessionID: intent.sessionID, ...existing } satisfies ResumeTicket)
      : yield* upsertResumeIntent(db, intent, paused)
  return { ticket, paused } satisfies ResumeRequest
})

/** Persists resume demand and captures effective pause state under one immediate transaction. */
export const requestResume = Effect.fn("SessionControl.requestResume")((db: DatabaseService, intent: ResumeIntent) =>
  db
    .transaction(() => requestResumeInTransaction(db, intent), { behavior: "immediate" })
    .pipe(Effect.catch((error) => (error instanceof NotFoundError ? Effect.fail(error) : Effect.die(error)))),
)

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

function loadClosureGraph(db: DatabaseService) {
  return Effect.gen(function* () {
    const sessions = yield* db
      .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
      .from(SessionTable)
      .all()
      .pipe(Effect.orDie)

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
        row.memberStatus !== "cancelled" &&
        row.memberStatus !== "failed"
      ) {
        members.push(SessionSchema.ID.make(row.memberSessionID))
      }
      teams.set(row.leadSessionID, members)
    }

    return { children, teams, storedSessionIDs }
  })
}

function targetClosure(db: DatabaseService, rootSessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const graph = yield* loadClosureGraph(db)
    if (!graph.storedSessionIDs.has(rootSessionID)) {
      return yield* new NotFoundError({ sessionID: rootSessionID })
    }

    const result = new Set<SessionSchema.ID>()
    const pending = [rootSessionID]
    while (pending.length > 0) {
      const sessionID = pending.shift()
      if (!sessionID || result.has(sessionID)) continue
      result.add(sessionID)
      pending.push(...(graph.children.get(sessionID) ?? []), ...(graph.teams.get(sessionID) ?? []))
    }
    return [...result]
  })
}

/**
 * Distance of each session in the root's closure from the root, where the root/lead
 * sits at depth 0 and a direct child or direct team member sits at depth 1.
 */
function closureDepths(db: DatabaseService, rootSessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const graph = yield* loadClosureGraph(db)
    if (!graph.storedSessionIDs.has(rootSessionID)) {
      return yield* new NotFoundError({ sessionID: rootSessionID })
    }

    const depth = new Map<SessionSchema.ID, number>([[rootSessionID, 0]])
    const pending = [rootSessionID]
    while (pending.length > 0) {
      const sessionID = pending.shift()
      if (!sessionID) continue
      const nextDepth = (depth.get(sessionID) ?? 0) + 1
      for (const next of [...(graph.children.get(sessionID) ?? []), ...(graph.teams.get(sessionID) ?? [])]) {
        if (depth.has(next)) continue
        depth.set(next, nextDepth)
        pending.push(next)
      }
    }
    return depth
  })
}

/** Orders tickets deepest-first (descendants before their lead), breaking ties deterministically by sessionID. */
function orderTicketsByDepth(tickets: readonly ResumeTicket[], depth: ReadonlyMap<SessionSchema.ID, number>) {
  return [...tickets].sort((left, right) => {
    const byDepth = (depth.get(right.sessionID) ?? 0) - (depth.get(left.sessionID) ?? 0)
    if (byDepth !== 0) return byDepth
    return left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 : 0
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
  /**
   * Registers a runtime interrupter that `pause` calls directly once the barrier is committed.
   * Returns the effect that removes the registration. Events stay for observers only; interruption
   * must never depend on them.
   */
  readonly registerInterrupter: (interrupter: Interrupter) => Effect.Effect<Effect.Effect<void>>

  readonly requestResume: (intent: ResumeIntent) => Effect.Effect<ResumeRequest, NotFoundError>
  /** Returns durable intents that currently have no active pause blocker. */
  readonly runnableResumeTickets: (sessionIDs?: readonly SessionSchema.ID[]) => Effect.Effect<readonly ResumeTicket[]>
  /** Checks both ticket generation and effective pause state. */
  readonly isResumeTicketRunnable: (ticket: ResumeTicket) => Effect.Effect<boolean>
  /** Clears the exact ticket only when no active blocker exists. */
  readonly finishResume: (ticket: ResumeTicket) => Effect.Effect<boolean>
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

    const setResumeIntent = (intent: ResumeIntent) =>
      upsertResumeIntent(db, intent).pipe(Effect.map((ticket) => ticket.generation))

    const requestResumeIntent = (intent: ResumeIntent) => requestResume(db, intent)

    const runnableResumeTickets = Effect.fn("SessionControl.runnableResumeTickets")(function* (
      sessionIDs?: readonly SessionSchema.ID[],
    ) {
      if (sessionIDs?.length === 0) return []
      const query = db
        .select({
          sessionID: SessionResumeIntentTable.session_id,
          generation: SessionResumeIntentTable.generation,
          reason: SessionResumeIntentTable.reason,
        })
        .from(SessionResumeIntentTable)
      const rows = yield* (
        sessionIDs === undefined
          ? query.all()
          : query.where(inArray(SessionResumeIntentTable.session_id, sessionIDs)).all()
      ).pipe(Effect.orDie)
      const tickets = rows.map(
        (row) =>
          ({
            sessionID: SessionSchema.ID.make(row.sessionID),
            generation: row.generation,
            reason: row.reason,
          }) satisfies ResumeTicket,
      )
      const blocked = yield* pausedSessionIDs(
        db,
        tickets.map((ticket) => ticket.sessionID),
      )
      return tickets.filter((ticket) => !blocked.has(ticket.sessionID))
    })

    const isResumeTicketRunnable = Effect.fn("SessionControl.isResumeTicketRunnable")(function* (ticket: ResumeTicket) {
      return yield* isTicketRunnable(db, ticket)
    })

    const finishResume = Effect.fn("SessionControl.finishResume")((ticket: ResumeTicket) =>
      db
        .transaction(
          () =>
            Effect.gen(function* () {
              if (yield* isPaused(db, ticket.sessionID)) return false
              const rows = yield* db
                .delete(SessionResumeIntentTable)
                .where(
                  and(
                    eq(SessionResumeIntentTable.session_id, ticket.sessionID),
                    eq(SessionResumeIntentTable.generation, ticket.generation),
                  ),
                )
                .returning({ sessionID: SessionResumeIntentTable.session_id })
                .all()
                .pipe(Effect.orDie)
              return rows.length === 1
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie),
    )

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
      for (const sessionID of sessionIDs.toReversed()) {
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

    const interrupters = new Set<Interrupter>()

    const registerInterrupter = (interrupter: Interrupter) =>
      Effect.sync(() => {
        interrupters.add(interrupter)
        return Effect.sync(() => {
          interrupters.delete(interrupter)
        })
      })

    // Descendants are signalled before their root so a parent cannot observe a child as
    // still running, and the whole call returns without awaiting fiber unwinding.
    const signalInterruption = (sessionIDs: readonly SessionSchema.ID[]) =>
      Effect.suspend(() =>
        Effect.forEach([...interrupters], (interrupter) => interrupter(sessionIDs.toReversed()), {
          concurrency: 1,
        }),
      ).pipe(
        Effect.map((batches) => [...new Set(batches.flat())]),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.succeed([] as SessionSchema.ID[]),
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
            // The durable barrier is committed above. Interruption is signalled directly here so it
            // cannot be lost when nothing observes the ControlChanged event.
            Effect.flatMap((result) =>
              signalInterruption(result.affectedSessionIDs).pipe(
                Effect.map(
                  (interruptionSignalledSessionIDs) =>
                    ({ ...result, interruptionSignalledSessionIDs }) satisfies PauseResult,
                ),
              ),
            ),
            Effect.tap((result) => notifyChangedBestEffort(result.affectedSessionIDs)),
          ),
      ),
      registerInterrupter,
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
                // Resume tickets are ordered deepest-first (descendants before their lead).
                const depth = yield* closureDepths(db, rootSessionID)
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
                  const blocked = new Set((yield* activeBlockers(db, affectedSessionIDs)).map((row) => row.sessionID))
                  const resumeTickets = orderTicketsByDepth(
                    yield* runnableResumeTickets(affectedSessionIDs),
                    depth,
                  )
                  return {
                    rootSessionID,
                    affectedSessionIDs,
                    stillBlockedSessionIDs: affectedSessionIDs.filter((sessionID) => blocked.has(sessionID)),
                    resumableSessionIDs: resumeTickets.map((ticket) => ticket.sessionID),
                    resumeTickets,
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
                  .select({
                    sessionID: SessionResumeIntentTable.session_id,
                    generation: SessionResumeIntentTable.generation,
                    reason: SessionResumeIntentTable.reason,
                  })
                  .from(SessionResumeIntentTable)
                  .innerJoin(
                    SessionPauseBlockerTable,
                    eq(SessionPauseBlockerTable.session_id, SessionResumeIntentTable.session_id),
                  )
                  .where(eq(SessionPauseBlockerTable.cascade_id, active.id))
                  .all()
                  .pipe(Effect.orDie)
                const resumeTickets = orderTicketsByDepth(
                  intents
                    .map(
                      (row) =>
                        ({
                          sessionID: SessionSchema.ID.make(row.sessionID),
                          generation: row.generation,
                          reason: row.reason,
                        }) satisfies ResumeTicket,
                    )
                    .filter((ticket) => !blocked.has(ticket.sessionID)),
                  depth,
                )
                return {
                  rootSessionID,
                  cascadeID: active.id,
                  generation: active.generation,
                  affectedSessionIDs,
                  stillBlockedSessionIDs: affectedSessionIDs.filter((sessionID) => blocked.has(sessionID)),
                  resumableSessionIDs: resumeTickets.map((ticket) => ticket.sessionID),
                  resumeTickets,
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
      requestResume: requestResumeIntent,
      runnableResumeTickets,
      isResumeTicketRunnable,
      finishResume,
      setResumeIntent,
      clearResumeIntent: Effect.fn("SessionControl.clearResumeIntent")(function* (input) {
        const row = yield* db
          .select({ reason: SessionResumeIntentTable.reason })
          .from(SessionResumeIntentTable)
          .where(
            and(
              eq(SessionResumeIntentTable.session_id, input.sessionID),
              eq(SessionResumeIntentTable.generation, input.generation),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row
          ? yield* finishResume({
              sessionID: input.sessionID,
              generation: input.generation,
              reason: row.reason,
            })
          : false
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
