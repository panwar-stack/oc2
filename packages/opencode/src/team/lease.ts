import { Database } from "@oc2-ai/core/database/database"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { recordMutation } from "./board-outbox"
import { TeamMemberTable } from "./team.sql"

const liveOwners = new Set<string>()

export interface Interface {
  registerOwner: (ownerID: string) => Effect.Effect<void>
  unregisterOwner: (ownerID: string) => Effect.Effect<void>
  begin: (input: {
    memberID: string
    ownerID: string
    state?: "starting" | "busy" | "retry"
    ttlMs?: number
  }) => Effect.Effect<{ epoch: number; expiresAt: number } | undefined>
  heartbeat: (input: {
    memberID: string
    ownerID: string
    epoch: number
    state?: "starting" | "busy" | "retry"
    ttlMs?: number
  }) => Effect.Effect<boolean>
  finish: (input: {
    memberID: string
    ownerID: string
    epoch: number
    outcome: "succeeded" | "failed" | "cancelled" | "interrupted" | "idle"
    result?: string
    cause?: string
  }) => Effect.Effect<boolean>
  reconcile: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TeamLease") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const registerOwner = Effect.fn("TeamLease.registerOwner")((ownerID: string) =>
      Effect.sync(() => {
        liveOwners.add(ownerID)
      }),
    )
    const unregisterOwner = Effect.fn("TeamLease.unregisterOwner")((ownerID: string) =>
      Effect.sync(() => {
        liveOwners.delete(ownerID)
      }),
    )

    const begin = Effect.fn("TeamLease.begin")(function* (input: {
      memberID: string
      ownerID: string
      state?: "starting" | "busy" | "retry"
      ttlMs?: number
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, input.memberID)).get()
              if (!member) return undefined
              const now = Date.now()
              const epoch = member.execution_epoch + 1
              const expiresAt = now + (input.ttlMs ?? 30_000)
              yield* tx
                .update(TeamMemberTable)
                .set({
                  status: "active",
                  execution_epoch: epoch,
                  execution_state: input.state ?? "busy",
                  lease_owner_id: input.ownerID,
                  lease_expires_at: expiresAt,
                  work_started_at: now,
                  outcome_type: null,
                  outcome_label: null,
                  outcome_cause: null,
                  outcome_at: null,
                  time_updated: now,
                })
                .where(eq(TeamMemberTable.id, member.id))
                .run()
              yield* recordMutation(tx, member.team_id, ["member.lease.begin"], now)
              return { epoch, expiresAt }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const heartbeat = Effect.fn("TeamLease.heartbeat")(function* (input: {
      memberID: string
      ownerID: string
      epoch: number
      state?: "starting" | "busy" | "retry"
      ttlMs?: number
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(
                  and(
                    eq(TeamMemberTable.id, input.memberID),
                    eq(TeamMemberTable.execution_epoch, input.epoch),
                    eq(TeamMemberTable.lease_owner_id, input.ownerID),
                  ),
                )
                .get()
              if (!member) return false
              const now = Date.now()
              const expiresAt = now + (input.ttlMs ?? 30_000)
              const state = input.state ?? member.execution_state
              yield* tx
                .update(TeamMemberTable)
                .set({ execution_state: state, lease_expires_at: expiresAt, time_updated: now })
                .where(eq(TeamMemberTable.id, member.id))
                .run()
              yield* recordMutation(tx, member.team_id, ["member.lease.heartbeat"], now)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const finish = Effect.fn("TeamLease.finish")(function* (input: {
      memberID: string
      ownerID: string
      epoch: number
      outcome: "succeeded" | "failed" | "cancelled" | "interrupted" | "idle"
      result?: string
      cause?: string
    }) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(
                  and(
                    eq(TeamMemberTable.id, input.memberID),
                    eq(TeamMemberTable.execution_epoch, input.epoch),
                    eq(TeamMemberTable.lease_owner_id, input.ownerID),
                  ),
                )
                .get()
              if (!member) return false
              const now = Date.now()
              const idle = input.outcome === "idle"
              const outcome = input.outcome === "idle" ? null : input.outcome
              const status = idle
                ? ("idle" as const)
                : input.outcome === "succeeded"
                  ? ("completed" as const)
                  : ("cancelled" as const)
              const label =
                input.outcome === "succeeded"
                  ? ("completed" as const)
                  : input.outcome === "failed"
                    ? ("failed" as const)
                    : input.outcome === "cancelled"
                      ? ("cancelled" as const)
                      : ("interrupted" as const)
              yield* tx
                .update(TeamMemberTable)
                .set({
                  status,
                  execution_state: "idle",
                  lease_owner_id: null,
                  lease_expires_at: null,
                  outcome_type: outcome,
                  outcome_label: idle ? null : label,
                  outcome_cause: idle ? null : (input.cause ?? "cause_unknown"),
                  outcome_at: idle ? null : now,
                  ...(input.result === undefined ? {} : { result: input.result }),
                  time_updated: now,
                })
                .where(eq(TeamMemberTable.id, member.id))
                .run()
              yield* recordMutation(tx, member.team_id, [idle ? "member.lease.idle" : "member.outcome"], now)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const reconcile = Effect.fn("TeamLease.reconcile")(function* () {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const leased = (yield* tx
                .select()
                .from(TeamMemberTable)
                .orderBy(asc(TeamMemberTable.team_id), asc(TeamMemberTable.time_created), asc(TeamMemberTable.id))
                .all()).filter(
                (member): member is typeof member & { lease_owner_id: string; lease_expires_at: number } =>
                  member.lease_owner_id !== null && member.lease_expires_at !== null,
              )
              const now = Date.now()
              const stale = leased.filter(
                (member) =>
                  member.lease_expires_at <= now || !liveOwners.has(member.lease_owner_id),
              )
              if (stale.length === 0) return 0
              for (const member of stale) {
                const cause = member.lease_expires_at <= now ? "lease_expired" : "ownerless"
                yield* tx
                  .update(TeamMemberTable)
                  .set({
                    status: "cancelled",
                    execution_state: "idle",
                    lease_owner_id: null,
                    lease_expires_at: null,
                    outcome_type: "interrupted",
                    outcome_label: "interrupted",
                    outcome_cause: cause,
                    outcome_at: now,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(TeamMemberTable.id, member.id),
                      eq(TeamMemberTable.execution_epoch, member.execution_epoch),
                    ),
                  )
                  .run()
              }
              for (const teamID of new Set(stale.map((member) => member.team_id))) {
                yield* recordMutation(tx, teamID, ["member.lease.reconciled"], now)
              }
              return stale.length
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    yield* reconcile()
    yield* reconcile().pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced(Duration.seconds(5))),
      Effect.delay(Duration.seconds(5)),
      Effect.forkScoped,
    )

    return Service.of({ registerOwner, unregisterOwner, begin, heartbeat, finish, reconcile })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as TeamLease from "./lease"
