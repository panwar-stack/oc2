import { describe, expect } from "bun:test"
import { Database } from "@oc2-ai/core/database/database"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { EventV2 } from "@oc2-ai/core/event"
import { EventTable } from "@oc2-ai/core/event/sql"
import { Project } from "@oc2-ai/core/project"
import { ProjectTable } from "@oc2-ai/core/project/sql"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SessionExecution } from "@oc2-ai/core/session/execution"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { SessionInput } from "@oc2-ai/core/session/input"
import { SessionProjector } from "@oc2-ai/core/session/projector"
import { SessionSchema } from "@oc2-ai/core/session/schema"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { TeamDelivery } from "@/team/delivery"
import { Team } from "@/team/team"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const wakeCalls: Array<{ sessionID: SessionSchema.ID; seq?: number }> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: (sessionID, seq) =>
      Effect.sync(() => {
        wakeCalls.push({ sessionID, seq })
      }),
  }),
)
const it = testEffect(
  Layer.mergeAll(
    Team.defaultLayer,
    SessionProjector.defaultLayer,
    Database.defaultLayer,
    EventV2.defaultLayer,
    execution,
    CrossSpawnSpawner.defaultLayer,
  ),
)

const setup = Effect.gen(function* () {
  wakeCalls.length = 0
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of ["ses_delivery_lead", "ses_delivery_member"]) {
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(id),
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
  const team = yield* Team.Service
  const info = yield* team.create({
    name: "delivery-team",
    goal: "Deliver durably",
    leadSessionID: "ses_delivery_lead",
  })
  yield* team.addMember({
    teamID: info.id,
    sessionID: "ses_delivery_member",
    name: "worker",
    agentType: "general",
    rolePrompt: "Work",
  })
  return { team, info, db }
})

const makeDelivery = Effect.gen(function* () {
  const team = yield* Team.Service
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const sessionExecution = yield* SessionExecution.Service
  const context = yield* Layer.build(
    TeamDelivery.layer.pipe(
      Layer.provide(Layer.succeed(Team.Service, team)),
      Layer.provide(Layer.succeed(Database.Service, database)),
      Layer.provide(Layer.succeed(EventV2.Service, events)),
      Layer.provide(Layer.succeed(SessionExecution.Service, sessionExecution)),
    ),
  )
  return Context.get(context, TeamDelivery.Service)
})

describe("TeamDelivery", () => {
  it.live("recovers a pending recipient into one durable activity before waking", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { team, info, db } = yield* setup
        yield* team.sendMessage({
          teamID: info.id,
          sender: "ses_delivery_lead",
          recipients: ["ses_delivery_member"],
          body: "Implement the reviewed change.",
        })
        expect(yield* team.listPendingRecipientDeliveries({ teamID: info.id })).toHaveLength(1)

        const delivery = yield* makeDelivery

        expect(yield* team.listPendingRecipientDeliveries({ teamID: info.id })).toEqual([])
        const admitted = yield* SessionInput.pendingTeamMessages(db, SessionSchema.ID.make("ses_delivery_member"))
        expect(admitted).toMatchObject([
          {
            source: "team_mailbox",
            activity: {
              type: "team_message",
              team_id: info.id,
              sender: "ses_delivery_lead",
              body: "Implement the reviewed change.",
            },
          },
        ])
        expect(wakeCalls).toEqual([
          { sessionID: SessionSchema.ID.make("ses_delivery_member"), seq: admitted[0]!.admittedSeq },
        ])

        wakeCalls.length = 0
        yield* delivery.recover
        expect(wakeCalls).toEqual([
          { sessionID: SessionSchema.ID.make("ses_delivery_member"), seq: admitted[0]!.admittedSeq },
        ])
        expect(
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.TeamMessageLifecycle.Admitted.type, 1)))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(1)
      }),
    ),
  )

  it.live("admits future messages on receipt and tolerates duplicate recovery wakes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { team, info, db } = yield* setup
        const delivery = yield* makeDelivery
        wakeCalls.length = 0

        yield* team.sendMessage({
          teamID: info.id,
          sender: "ses_delivery_lead",
          recipients: ["ses_delivery_member"],
          body: "Handle this while active.",
        })

        const [admitted] = yield* SessionInput.pendingTeamMessages(db, SessionSchema.ID.make("ses_delivery_member"))
        expect(admitted).toBeDefined()
        expect(wakeCalls).toEqual([
          { sessionID: SessionSchema.ID.make("ses_delivery_member"), seq: admitted!.admittedSeq },
        ])
        yield* delivery.wake("ses_delivery_member")
        expect(wakeCalls).toEqual([
          { sessionID: SessionSchema.ID.make("ses_delivery_member"), seq: admitted!.admittedSeq },
          { sessionID: SessionSchema.ID.make("ses_delivery_member"), seq: admitted!.admittedSeq },
        ])
        expect(yield* team.listPendingRecipientDeliveries({ teamID: info.id })).toEqual([])
      }),
    ),
  )

  it.live("keeps delivery pending when the recipient session is not locally available", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { team, info } = yield* setup
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_delivery_missing",
          name: "missing-worker",
          agentType: "general",
          rolePrompt: "Start later",
        })
        yield* makeDelivery

        yield* team.sendMessage({
          teamID: info.id,
          sender: "ses_delivery_lead",
          recipients: ["ses_delivery_missing"],
          body: "Wait until the session is available.",
        })

        expect(
          yield* team.listPendingRecipientDeliveries({
            teamID: info.id,
            recipientSessionID: "ses_delivery_missing",
          }),
        ).toHaveLength(1)
        expect(wakeCalls).toEqual([])
      }),
    ),
  )
})
