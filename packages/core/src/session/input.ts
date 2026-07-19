export * as SessionInput from "./input"

import { and, asc, eq, isNull, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { EventSequenceTable } from "../event/sql"
import { NonNegativeInt } from "../schema"
import { V2Schema } from "../v2-schema"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export const Delivery = Schema.Literals(["steer", "queue"])
export type Delivery = typeof Delivery.Type

export const Source = Schema.Literals(["prompt", "team_mailbox"])
export type Source = typeof Source.Type

export class PromptActivity extends Schema.Class<PromptActivity>("SessionInput.Activity.Prompt")({
  type: Schema.Literal("prompt"),
  prompt: Prompt,
}) {}

export class TeamMessageActivity extends Schema.Class<TeamMessageActivity>("SessionInput.Activity.TeamMessage")({
  type: Schema.Literal("team_message"),
  team_id: Schema.String,
  recipient_row_id: Schema.String,
  sender: Schema.String,
  body: Schema.String,
}) {}

export const Activity = Schema.Union([PromptActivity, TeamMessageActivity]).pipe(Schema.toTaggedUnion("type"))
export type Activity = typeof Activity.Type

export class ActivityAdmission extends Schema.Class<ActivityAdmission>("SessionInput.ActivityAdmission")({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionSchema.ID,
  activity: Activity,
  source: Source,
  delivery: Delivery,
  timeCreated: V2Schema.DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Admitted extends Schema.Class<Admitted>("SessionInput.Admitted")({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionSchema.ID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: V2Schema.DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(Schema.optional),
}) {}

export class PendingSessionInput extends Schema.Class<PendingSessionInput>("PendingSessionInput")({
  id: SessionMessage.ID,
  sequence: NonNegativeInt,
  delivery: Schema.Literal("queue"),
  prompt: Prompt,
  time_created: NonNegativeInt,
}) {}

export class PendingSessionInputs extends Schema.Class<PendingSessionInputs>("PendingSessionInputs")({
  revision: NonNegativeInt,
  inputs: Schema.Array(PendingSessionInput),
}) {}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const decodeActivity = Schema.decodeUnknownSync(Activity)
const encodeActivity = Schema.encodeSync(Activity)

const fromRow = (row: typeof SessionInputTable.$inferSelect): ActivityAdmission =>
  new ActivityAdmission({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    activity: decodeActivity(row.activity),
    source: row.source,
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })

export const findActivity = Effect.fn("SessionInput.findActivity")(function* (
  db: DatabaseService,
  id: SessionMessage.ID,
) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const stored = yield* findActivity(db, id)
  if (stored === undefined || stored.activity.type !== "prompt") return undefined
  return new Admitted({
    admittedSeq: stored.admittedSeq,
    id: stored.id,
    sessionID: stored.sessionID,
    prompt: stored.activity.prompt,
    delivery: stored.delivery,
    timeCreated: stored.timeCreated,
    ...(stored.promotedSeq === undefined ? {} : { promotedSeq: stored.promotedSeq }),
  })
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admitActivity = Effect.fn("SessionInput.admitActivity")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly activity: Activity
    readonly delivery: Delivery
    readonly commit?: EventV2.PublishOptions["commit"]
  },
) {
  const existing = yield* findActivity(db, input.id)
  if (existing !== undefined)
    return equivalentActivity(existing, input) ? existing : yield* Effect.die(new LifecycleConflict({ id: input.id }))
  if (input.activity.type === "team_message" && input.delivery !== "steer")
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const timestamp = yield* DateTime.now
  return yield* Effect.gen(function* () {
    const admittedSeq =
      input.activity.type === "prompt"
        ? yield* events
            .publish(
              SessionEvent.PromptLifecycle.Admitted,
              {
                messageID: input.id,
                sessionID: input.sessionID,
                timestamp,
                prompt: input.activity.prompt,
                delivery: input.delivery,
              },
              input.commit ? { commit: input.commit } : undefined,
            )
            .pipe(
              Effect.map((event) => event.seq),
              Effect.flatMap((seq) =>
                seq === undefined ? Effect.die("Activity admission event is missing aggregate sequence") : Effect.succeed(seq),
              ),
            )
        : yield* events
            .publish(
              SessionEvent.TeamMessageLifecycle.Admitted,
              {
                messageID: input.id,
                sessionID: input.sessionID,
                timestamp,
                teamID: input.activity.team_id,
                recipientRowID: input.activity.recipient_row_id,
                sender: input.activity.sender,
                body: input.activity.body,
              },
              input.commit ? { commit: input.commit } : undefined,
            )
            .pipe(
              Effect.map((event) => event.seq),
              Effect.flatMap((seq) =>
                seq === undefined ? Effect.die("Activity admission event is missing aggregate sequence") : Effect.succeed(seq),
              ),
            )
    return new ActivityAdmission({
      admittedSeq,
      id: input.id,
      sessionID: input.sessionID,
      activity: input.activity,
      source: input.activity.type === "prompt" ? "prompt" : "team_mailbox",
      delivery: input.delivery,
      timeCreated: timestamp,
    })
  }).pipe(
    Effect.catchDefect((defect) =>
      findActivity(db, input.id).pipe(
        Effect.flatMap((stored) =>
          stored && equivalentActivity(stored, input) ? Effect.succeed(stored) : Effect.die(defect),
        ),
      ),
    ),
  )
})

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) {
  const stored = yield* admitActivity(db, events, {
    id: input.id,
    sessionID: input.sessionID,
    activity: new PromptActivity({ type: "prompt", prompt: input.prompt }),
    delivery: input.delivery,
  })
  if (stored.activity.type !== "prompt") return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return new Admitted({
    admittedSeq: stored.admittedSeq,
    id: stored.id,
    sessionID: stored.sessionID,
    prompt: stored.activity.prompt,
    delivery: stored.delivery,
    timeCreated: stored.timeCreated,
    ...(stored.promotedSeq === undefined ? {} : { promotedSeq: stored.promotedSeq }),
  })
})

export const latestSeq = Effect.fn("SessionInput.latestSeq")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export const pendingQueued = Effect.fn("SessionInput.pendingQueued")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const sequence = yield* tx
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()
        const rows = yield* tx
          .select({
            id: SessionInputTable.id,
            sequence: SessionInputTable.admitted_seq,
            activity: SessionInputTable.activity,
            time_created: SessionInputTable.time_created,
          })
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, sessionID),
              isNull(SessionInputTable.promoted_seq),
              eq(SessionInputTable.delivery, "queue"),
              eq(SessionInputTable.source, "prompt"),
            ),
          )
          .orderBy(asc(SessionInputTable.admitted_seq), asc(SessionInputTable.id))
          .all()
        return new PendingSessionInputs({
          revision: Math.max(0, sequence?.seq ?? 0),
          inputs: rows.map((row) => {
            const activity = decodeActivity(row.activity)
            if (activity.type !== "prompt") throw new Error("Queued prompt row has a non-prompt activity")
            return new PendingSessionInput({
              id: SessionMessage.ID.make(row.id),
              sequence: row.sequence,
              delivery: "queue",
              prompt: activity.prompt,
              time_created: row.time_created,
            })
          }),
        })
      }),
    )
    .pipe(Effect.orDie)
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly activity: Activity
    readonly source: Source
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) {
  if (
    (input.activity.type === "prompt" && input.source !== "prompt") ||
    (input.activity.type === "team_message" && (input.source !== "team_mailbox" || input.delivery !== "steer"))
  )
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: input.activity.type === "prompt" ? encodePrompt(input.activity.prompt) : null,
      activity: encodeActivity(input.activity),
      source: input.source,
      delivery: input.delivery,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPromoted = Effect.fn("SessionInput.projectPromoted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly activity: Activity
    readonly source: Source
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = fromRow(updated)
  if (
    !equivalentActivity(stored, input) ||
    DateTime.toEpochMillis(stored.timeCreated) !== DateTime.toEpochMillis(input.timeCreated)
  )
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return toMessage(stored)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const pendingTeamMessages = Effect.fn("SessionInput.pendingTeamMessages")(function* (
  db: DatabaseService,
  sessionID?: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.source, "team_mailbox"),
        sessionID === undefined ? undefined : eq(SessionInputTable.session_id, sessionID),
      ),
    )
    .orderBy(asc(SessionInputTable.session_id), asc(SessionInputTable.admitted_seq), asc(SessionInputTable.id))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) => input.delivery === expected.delivery && matchesPrompt(input, expected)

export const equivalentActivity = (
  input: ActivityAdmission,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly activity: Activity
    readonly delivery?: Delivery
    readonly source?: Source
  },
) =>
  input.sessionID === expected.sessionID &&
  (expected.delivery === undefined || input.delivery === expected.delivery) &&
  (expected.source === undefined || input.source === expected.source) &&
  JSON.stringify(encodeActivity(input.activity)) === JSON.stringify(encodeActivity(expected.activity))

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

export const guardReservedID = Effect.fn("SessionInput.guardReservedID")(function* (
  db: DatabaseService,
  event: EventV2.Payload,
) {
  if (
    Schema.is(SessionEvent.PromptLifecycle.Admitted)(event) ||
    Schema.is(SessionEvent.PromptLifecycle.Promoted)(event) ||
    Schema.is(SessionEvent.TeamMessageLifecycle.Admitted)(event) ||
    Schema.is(SessionEvent.TeamMessageLifecycle.Promoted)(event)
  )
    return
  const id = reservedID(event)
  if (id === undefined) return
  const admitted = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (admitted === undefined) return
  return yield* Effect.die(new LifecycleConflict({ id }))
})

const reservedID = (event: EventV2.Payload) => {
  if (Schema.is(SessionEvent.Step.Started)(event)) return event.data.assistantMessageID
  if (Schema.is(SessionEvent.AgentSwitched)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.ModelSwitched)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Prompted)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Synthetic)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Shell.Started)(event)) return event.data.messageID
  if (Schema.is(SessionEvent.Compaction.Started)(event)) return event.data.messageID
}

export const projectLegacyPrompted = Effect.fn("SessionInput.projectLegacyPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const inserted = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.promotedSeq,
      prompt: encodePrompt(input.prompt),
      activity: encodeActivity(new PromptActivity({ type: "prompt", prompt: input.prompt })),
      source: "prompt",
      delivery: input.delivery,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!inserted) return yield* Effect.die("Prompt projection conflicts with admitted input")
  return fromRow(inserted)
})

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    const activity = decodeActivity(row.activity)
    const timestamp = yield* DateTime.now
    const recover = Effect.catchDefect((defect) =>
      defect instanceof LifecycleConflict
        ? findActivity(db, SessionMessage.ID.make(row.id)).pipe(
            Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
          )
        : Effect.die(defect),
    )
    if (activity.type === "prompt") {
      yield* events
        .publish(SessionEvent.PromptLifecycle.Promoted, {
          sessionID,
          timestamp,
          messageID: SessionMessage.ID.make(row.id),
          prompt: activity.prompt,
          timeCreated: DateTime.makeUnsafe(row.time_created),
        })
        .pipe(recover)
      continue
    }
    yield* events
      .publish(SessionEvent.TeamMessageLifecycle.Promoted, {
        sessionID,
        timestamp,
        messageID: SessionMessage.ID.make(row.id),
        teamID: activity.team_id,
        recipientRowID: activity.recipient_row_id,
        sender: activity.sender,
        body: activity.body,
        timeCreated: DateTime.makeUnsafe(row.time_created),
      })
      .pipe(recover)
  }
  return rows.length
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row]).pipe(Effect.as(true))
})

const toMessage = (input: ActivityAdmission) =>
  input.activity.type === "prompt"
    ? new SessionMessage.User({
        id: input.id,
        type: "user",
        text: input.activity.prompt.text,
        files: input.activity.prompt.files,
        agents: input.activity.prompt.agents,
        references: input.activity.prompt.references,
        time: { created: input.timeCreated },
      })
    : new SessionMessage.System({
        id: input.id,
        type: "system",
        text: ["<team-messages>", `From ${input.activity.sender}:`, input.activity.body, "</team-messages>"].join("\n"),
        source: "team_mailbox",
        time: { created: input.timeCreated },
      })
