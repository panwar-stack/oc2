import { Database } from "@oc2-ai/core/database/database"
import { Context, Effect, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { recordMutation } from "./board-outbox"
import { TeamAttentionTable, TeamMemberTable } from "./team.sql"

export type Kind = "permission" | "question"
export type Attention = typeof TeamAttentionTable.$inferSelect

export interface Interface {
  open: (input: {
    sessionID: string
    kind: Kind
    detailID: string
    detail: Record<string, unknown>
  }) => Effect.Effect<Attention | undefined>
  resolve: (kind: Kind, detailID: string, resolution: string) => Effect.Effect<boolean>
  cancel: (kind: Kind, detailID: string, resolution: string) => Effect.Effect<boolean>
  reconcile: (kind: Kind, liveDetailIDs: ReadonlySet<string>) => Effect.Effect<number>
  get: (teamID: string, attentionID: string) => Effect.Effect<Attention | undefined>
  setMutability: (sessionID: string, mutability: "read_only" | "write_allowed" | "unknown") => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamAttention") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const open = Effect.fn("TeamAttention.open")(function* (input: {
      sessionID: string
      kind: Kind
      detailID: string
      detail: Record<string, unknown>
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.session_id, input.sessionID))
                .get()
              if (!member) return undefined
              const existing = yield* tx
                .select()
                .from(TeamAttentionTable)
                .where(
                  and(eq(TeamAttentionTable.kind, input.kind), eq(TeamAttentionTable.detail_id, input.detailID)),
                )
                .get()
              if (existing) return existing
              const now = Date.now()
              const id = crypto.randomUUID()
              yield* tx
                .insert(TeamAttentionTable)
                .values({
                  id,
                  team_id: member.team_id,
                  member_id: member.id,
                  session_id: member.session_id,
                  kind: input.kind,
                  detail_id: input.detailID,
                  detail: input.detail,
                  state: "open",
                  time_created: now,
                  time_updated: now,
                })
                .run()
              yield* recordMutation(tx, member.team_id, [`attention.${input.kind}.open`], now)
              return yield* tx.select().from(TeamAttentionTable).where(eq(TeamAttentionTable.id, id)).get()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const close = Effect.fn("TeamAttention.close")(function* (
      kind: Kind,
      detailID: string,
      state: "resolved" | "cancelled",
      resolution: string,
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(TeamAttentionTable)
                .where(and(eq(TeamAttentionTable.kind, kind), eq(TeamAttentionTable.detail_id, detailID)))
                .get()
              if (!row || row.state !== "open") return false
              const now = Date.now()
              yield* tx
                .update(TeamAttentionTable)
                .set({ state, resolution, time_updated: now })
                .where(and(eq(TeamAttentionTable.id, row.id), eq(TeamAttentionTable.state, "open")))
                .run()
              yield* recordMutation(tx, row.team_id, [`attention.${kind}.${state}`], now)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })
    const resolve = (kind: Kind, detailID: string, resolution: string) => close(kind, detailID, "resolved", resolution)
    const cancel = (kind: Kind, detailID: string, resolution: string) => close(kind, detailID, "cancelled", resolution)

    const reconcile = Effect.fn("TeamAttention.reconcile")(function* (
      kind: Kind,
      liveDetailIDs: ReadonlySet<string>,
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const openRows = yield* tx
                .select()
                .from(TeamAttentionTable)
                .where(and(eq(TeamAttentionTable.kind, kind), eq(TeamAttentionTable.state, "open")))
                .orderBy(asc(TeamAttentionTable.time_created), asc(TeamAttentionTable.id))
                .all()
              const stale = openRows.filter((row) => !liveDetailIDs.has(row.detail_id))
              if (stale.length === 0) return 0
              const now = Date.now()
              for (const row of stale) {
                yield* tx
                  .update(TeamAttentionTable)
                  .set({ state: "cancelled", resolution: "runtime_restarted", time_updated: now })
                  .where(and(eq(TeamAttentionTable.id, row.id), eq(TeamAttentionTable.state, "open")))
                  .run()
              }
              for (const teamID of new Set(stale.map((row) => row.team_id))) {
                yield* recordMutation(tx, teamID, [`attention.${kind}.reconcile`], now)
              }
              return stale.length
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const get = Effect.fn("TeamAttention.get")(function* (teamID: string, attentionID: string) {
      return yield* db
        .select()
        .from(TeamAttentionTable)
        .where(and(eq(TeamAttentionTable.team_id, teamID), eq(TeamAttentionTable.id, attentionID)))
        .get()
        .pipe(Effect.orDie)
    })

    const setMutability = Effect.fn("TeamAttention.setMutability")(function* (
      sessionID: string,
      mutability: "read_only" | "write_allowed" | "unknown",
    ) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.session_id, sessionID))
                .get()
              if (!member || member.mutability === mutability) return false
              const now = Date.now()
              yield* tx
                .update(TeamMemberTable)
                .set({ mutability, time_updated: now })
                .where(eq(TeamMemberTable.id, member.id))
                .run()
              yield* recordMutation(tx, member.team_id, ["member.mutability"], now)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    return Service.of({ open, resolve, cancel, reconcile, get, setMutability })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as TeamAttention from "./attention"
