import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Context, Duration, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { TeamBoardOutboxTable, TeamTable } from "./team.sql"

type DatabaseClient = Database.Interface["db"]
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export const Updated = EventV2.define({
  type: "team.board.updated",
  schema: {
    teamID: Schema.String,
    revision: Schema.Number,
    reasons: Schema.Array(Schema.String),
  },
})

export function recordMutation(
  tx: Transaction,
  teamID: string,
  reasons: readonly string[],
  now: number,
  expectedRevision?: number,
) {
  return Effect.gen(function* () {
    const uniqueReasons = [...new Set(reasons)].sort()
    const row = yield* tx
      .update(TeamTable)
      .set({ board_revision: sql`${TeamTable.board_revision} + 1`, time_updated: now })
      .where(
        expectedRevision === undefined
          ? eq(TeamTable.id, teamID)
          : and(eq(TeamTable.id, teamID), eq(TeamTable.board_revision, expectedRevision)),
      )
      .returning({ revision: TeamTable.board_revision })
      .get()
    if (!row) return undefined
    yield* tx
      .insert(TeamBoardOutboxTable)
      .values({
        id: crypto.randomUUID(),
        team_id: teamID,
        revision: row.revision,
        reasons: uniqueReasons,
        published_at: null,
        time_created: now,
        time_updated: now,
      })
      .run()
    return row.revision
  })
}

export interface Interface {
  drain: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamBoardOutbox") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    const lock = Semaphore.makeUnsafe(1)
    const drain = Effect.fn("TeamBoardOutbox.drain")(function* () {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(TeamBoardOutboxTable)
            .where(isNull(TeamBoardOutboxTable.published_at))
            .orderBy(
              asc(TeamBoardOutboxTable.time_created),
              asc(TeamBoardOutboxTable.team_id),
              asc(TeamBoardOutboxTable.revision),
            )
            .all()
            .pipe(Effect.orDie)
          for (const row of rows) {
            yield* events.publish(Updated, {
              teamID: row.team_id,
              revision: row.revision,
              reasons: row.reasons,
            })
            const now = Date.now()
            yield* db
              .update(TeamBoardOutboxTable)
              .set({ published_at: now, time_updated: now })
              .where(and(eq(TeamBoardOutboxTable.id, row.id), isNull(TeamBoardOutboxTable.published_at)))
              .run()
              .pipe(Effect.orDie)
          }
          return rows.length
        }),
      )
    })
    yield* drain()
    yield* drain().pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced(Duration.seconds(5))),
      Effect.delay(Duration.seconds(5)),
      Effect.forkScoped,
    )
    return Service.of({ drain })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export * as TeamBoardOutbox from "./board-outbox"
