import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { EventTable } from "@oc2-ai/core/event/sql"
import { ModelV2 } from "@oc2-ai/core/model"
import { Project } from "@oc2-ai/core/project"
import { ProjectTable } from "@oc2-ai/core/project/sql"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SessionV2 } from "@oc2-ai/core/session"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { SessionMessage } from "@oc2-ai/core/session/message"
import { Prompt } from "@oc2-ai/core/session/prompt"
import { SessionMessageUpdater } from "@oc2-ai/core/session/message-updater"
import { SessionProjector } from "@oc2-ai/core/session/projector"
import { SessionExecution } from "@oc2-ai/core/session/execution"
import { SessionInput } from "@oc2-ai/core/session/input"
import { SessionStore } from "@oc2-ai/core/session/store"
import { PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "@oc2-ai/core/session/sql"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { CanonicalUsage } from "@oc2-ai/llm"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
  content: SessionMessage.AssistantContent[] = [],
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(new SessionMessage.Assistant({ id, type: "assistant", agent: "build", model, content, time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

const seedSession = Effect.fnUntraced(function* (db: Database.Interface["db"]) {
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionProjector", () => {
  it.effect("applies aggregate terminal accounting once and rejects conflicting terminals", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const assistantMessageID = SessionMessage.ID.make("msg_accounted")
      yield* db.insert(SessionMessageTable).values(assistantRow(assistantMessageID, 0)).run().pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const accounting = {
        mode: "aggregate",
        purpose: "assistant",
        model,
        time: { started: created, completed: DateTime.makeUnsafe(10), duration: 10 },
        usage: {
          authoritative: CanonicalUsage.from({
            input: 11,
            output: 7,
            reasoning: 3,
            cache: { read: 5, write: 2 },
          }),
          source: "step-finish",
        },
        pricing: { source: "catalog", amount: 0.25 },
      } satisfies SessionEvent.Step.Accounting
      const ended = {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(10),
        finish: "stop",
        cost: 0.25,
        tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 5, write: 2 } },
        accounting,
      }

      const mismatch = yield* events.publish(SessionEvent.Step.Ended, { ...ended, cost: 0.5 }).pipe(Effect.exit)
      expect(String(mismatch)).toContain("AccountingMismatch")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0,
        time_processing: 0,
        tokens_input: 0,
      })
      yield* events.publish(SessionEvent.Step.Ended, ended)
      yield* events.publish(SessionEvent.Step.Ended, ended)

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0.25,
        time_processing: 10,
        tokens_input: 11,
        tokens_output: 7,
        tokens_reasoning: 3,
        tokens_cache_read: 5,
        tokens_cache_write: 2,
      })

      const changed = yield* events
        .publish(SessionEvent.Step.Ended, {
          ...ended,
          tokens: { ...ended.tokens, input: 12 },
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: CanonicalUsage.from({ ...accounting.usage.authoritative, input: 12 }),
            },
          },
        })
        .pipe(Effect.exit)
      const retyped = yield* events
        .publish(SessionEvent.Step.Failed, {
          sessionID,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(10),
          error: { type: "unknown", message: "failed" },
          accounting: { ...accounting, usage: undefined, pricing: undefined },
        })
        .pipe(Effect.exit)
      expect(String(changed)).toContain("TerminalConflict")
      expect(String(retyped)).toContain("TerminalConflict")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0.25,
        time_processing: 10,
        tokens_input: 11,
      })
    }),
  )

  it.effect("accounts failed aggregate duration without billing pricing that has no authoritative usage", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const assistantMessageID = SessionMessage.ID.make("msg_failed_accounting")
      yield* db.insert(SessionMessageTable).values(assistantRow(assistantMessageID, 0)).run().pipe(Effect.orDie)
      yield* (yield* EventV2.Service).publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(20),
        error: { type: "unknown", message: "failed" },
        accounting: {
          mode: "aggregate",
          purpose: "assistant",
          model,
          time: { started: created, completed: DateTime.makeUnsafe(20), duration: 20 },
          pricing: { source: "provider", amount: 0.5, providerAmount: 0.5 },
        },
      })

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0,
        time_processing: 20,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      expect(message?.data).not.toHaveProperty("cost")
      expect(message?.data).not.toHaveProperty("tokens")
    }),
  )

  it.effect("derives failed assistant compatibility fields from authoritative accounting", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const assistantMessageID = SessionMessage.ID.make("msg_failed_authoritative")
      yield* db.insert(SessionMessageTable).values(assistantRow(assistantMessageID, 0)).run().pipe(Effect.orDie)
      yield* (yield* EventV2.Service).publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(30),
        error: { type: "unknown", message: "failed" },
        accounting: {
          mode: "aggregate",
          purpose: "assistant",
          model,
          time: { started: created, completed: DateTime.makeUnsafe(30), duration: 30 },
          usage: {
            authoritative: CanonicalUsage.from({
              input: 11,
              output: 7,
              reasoning: 3,
              cache: { read: 5, write: 2 },
            }),
            source: "provider-error",
          },
          pricing: { source: "provider", amount: 0.5, providerAmount: 0.5 },
        },
      })

      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      expect(message?.data).toMatchObject({
        cost: 0.5,
        tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 5, write: 2 } },
      })
    }),
  )

  it.effect("replays stored v1 terminals and compaction as logical non-owning events", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const assistantMessageID = SessionMessage.ID.make("msg_v1_terminal")
      yield* db.insert(SessionMessageTable).values(assistantRow(assistantMessageID, 0)).run().pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const serialized = [
        {
          id: EventV2.ID.create(),
          aggregateID: sessionID,
          seq: 0,
          type: EventV2.versionedType(SessionEvent.Step.EndedV1.type, 1),
          data: {
            sessionID,
            timestamp: 10,
            finish: "stop",
            cost: 1,
            tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
          },
        },
        {
          id: EventV2.ID.create(),
          aggregateID: sessionID,
          seq: 1,
          type: EventV2.versionedType(SessionEvent.Step.FailedV1.type, 1),
          data: { sessionID, timestamp: 11, error: { type: "unknown", message: "old failure" } },
        },
        {
          id: EventV2.ID.create(),
          aggregateID: sessionID,
          seq: 2,
          type: EventV2.versionedType(SessionEvent.Compaction.EndedV1.type, 1),
          data: { sessionID, timestamp: 12, text: "old compaction" },
        },
      ]

      for (const event of serialized) yield* events.replay(event)
      const read = yield* events.aggregateEvents({ aggregateID: sessionID }).pipe(Stream.take(3), Stream.runCollect)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)

      expect(Array.from(read).map((item) => ({ type: item.event.type, version: item.event.version }))).toEqual([
        { type: SessionEvent.Step.Ended.type, version: 1 },
        { type: SessionEvent.Step.Failed.type, version: 1 },
        { type: SessionEvent.Compaction.Ended.type, version: 1 },
      ])
      expect(message?.data).not.toHaveProperty("finish")
      expect(message?.data).not.toHaveProperty("accounting")
      expect(session).toMatchObject({ cost: 0, time_processing: 0, tokens_input: 0, tokens_output: 0 })
    }),
  )

  it.effect("keeps mirror and unmarked terminals non-owning while legacy parts account once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const assistantMessageID = SessionMessage.ID.make("msg_mirror")
      const unmarkedMessageID = SessionMessage.ID.make("msg_unmarked")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(assistantMessageID, 0), assistantRow(unmarkedMessageID, 1)])
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: unmarkedMessageID,
        timestamp: DateTime.makeUnsafe(10),
        finish: "stop",
        cost: 99,
        tokens: { input: 99, output: 99, reasoning: 99, cache: { read: 99, write: 99 } },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(10),
        finish: "stop",
        cost: 1,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        accounting: {
          mode: "mirror",
          purpose: "assistant",
          model,
          time: { started: created, completed: DateTime.makeUnsafe(10), duration: 10 },
          usage: {
            authoritative: CanonicalUsage.from({
              input: 10,
              output: 4,
              reasoning: 2,
              cache: { read: 3, write: 1 },
            }),
            source: "step-finish",
          },
          pricing: { source: "catalog", amount: 1 },
        },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0,
        tokens_input: 0,
      })

      const messageID = SessionV1.MessageID.ascending()
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 0,
        part: {
          id: SessionV1.PartID.ascending(),
          messageID,
          sessionID,
          type: "step-finish",
          reason: "stop",
          duration: 10,
          cost: 1,
          tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 1,
        time_processing: 10,
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
    }),
  )

  it.effect("projects and replaces V1 provenance instead of conflicting compatibility fields", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const events = yield* EventV2.Service
      const messageID = SessionV1.MessageID.ascending()
      const partID = SessionV1.PartID.ascending()
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 0,
        part: {
          id: partID,
          messageID,
          sessionID,
          type: "step-finish",
          reason: "error",
          duration: 999,
          cost: 99,
          tokens: { input: 99, output: 99, reasoning: 99, cache: { read: 99, write: 99 } },
          accounting: {
            mode: "aggregate",
            purpose: "assistant",
            model,
            time: { started: 10, completed: 20, duration: 10 },
            usage: {
              authoritative: {
                input: 4,
                output: 3,
                reasoning: 2,
                cache: { read: 1, write: 5 },
                providerTotal: 15,
                providerMetadata: { openrouter: { usage: { cost: 0.25 } } },
              },
              source: "provider-error",
            },
            pricing: { source: "provider", amount: 0.25, providerAmount: 0.25 },
          },
        },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0.25,
        time_processing: 10,
        tokens_input: 4,
        tokens_output: 3,
        tokens_reasoning: 2,
        tokens_cache_read: 1,
        tokens_cache_write: 5,
      })
      expect(
        yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: {
          accounting: {
            usage: { authoritative: { providerTotal: 15 } },
            pricing: { amount: 0.25 },
          },
        },
      })

      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 1,
        part: {
          id: partID,
          messageID,
          sessionID,
          type: "step-finish",
          reason: "error",
          duration: 999,
          cost: 99,
          tokens: { input: 99, output: 99, reasoning: 99, cache: { read: 99, write: 99 } },
          accounting: {
            mode: "aggregate",
            purpose: "assistant",
            model,
            time: { started: 20, completed: 40, duration: 20 },
            usage: {
              authoritative: {
                input: 8,
                output: 6,
                reasoning: 4,
                cache: { read: 2, write: 10 },
              },
              source: "provider-error",
            },
            pricing: { source: "catalog", amount: 0.5 },
          },
        },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 0.5,
        time_processing: 20,
        tokens_input: 8,
        tokens_output: 6,
        tokens_reasoning: 4,
        tokens_cache_read: 2,
        tokens_cache_write: 10,
      })
    }),
  )

  it.effect("keeps V1 accounting reads permissive while validating strict PartWrite provenance", () =>
    Effect.sync(() => {
      const accounting = {
        mode: "aggregate",
        purpose: "assistant",
        model,
        time: { started: 100, completed: 110, duration: 5 },
        usage: {
          authoritative: {
            input: 4,
            output: 3,
            reasoning: 2,
            cache: { read: 1, write: 5 },
            providerTotal: 15,
            providerMetadata: { openrouter: { usage: { cost: 0.25 } } },
          },
          source: "provider-error",
        },
        pricing: {
          source: "catalog",
          amount: 0.25,
          providerAmount: 0.2,
          estimateAmount: 0.25,
          rate: {
            tier: { type: "context", size: 100 },
            input: 0.125,
            output: 0.25,
            cache: { read: 0.0125, write: 0.05 },
          },
        },
      } satisfies SessionV1.StepFinishAccounting
      const part = {
        id: SessionV1.PartID.ascending(),
        messageID: SessionV1.MessageID.ascending(),
        sessionID,
        type: "step-finish",
        reason: "error",
        duration: 5,
        cost: 0.25,
        tokens: { total: 15, input: 4, output: 3, reasoning: 2, cache: { read: 1, write: 5 } },
        accounting,
      } satisfies typeof SessionV1.StepFinishPart.Type
      const decodeWrite = Schema.decodeUnknownExit(SessionV1.PartWrite)
      const decodeRead = Schema.decodeUnknownExit(SessionV1.Part)
      const withTime = (time: { started: number; completed: number; duration: number }) => ({
        ...part,
        accounting: { ...accounting, time },
      })

      expect(Exit.isSuccess(decodeWrite(part))).toBe(true)
      for (const providerMetadata of [
        { anthropic: { usage: { input_tokens: 4, output_tokens: 3 } } },
        {
          anthropic: {
            usage: {
              input_tokens: 4,
              output_tokens: 3,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              iterations: [
                {
                  type: "message",
                  input_tokens: 4,
                  output_tokens: 3,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: null,
                },
              ],
            },
          },
        },
        {
          anthropic: {
            iterations: [
              { type: "advisor_message", model: "advisor", input_tokens: 4, output_tokens: 3 },
            ],
          },
        },
        { google: { promptTokenCount: 4, candidatesTokenCount: 3 } },
        { bedrock: { inputTokens: 4, outputTokens: 3 } },
        { openai: { input_tokens: 4, output_tokens: 3 } },
        { copilot: { totalNanoAiu: 25_000_000 } },
        { xai: { input_tokens: 4, output_tokens: 3, is_byok: false } },
        { deepinfra: { prompt_tokens: 4, completion_tokens: 3, prompt_tokens_details: null } },
        { openrouter: { usage: { promptTokens: 4, completionTokens: 3, cost: 0.25 } } },
        {
          openrouter: {
            usage: {
              prompt_tokens: 4,
              completion_tokens: 3,
              cost: null,
              prompt_tokens_details: null,
              completion_tokens_details: null,
              cost_details: { upstream_inference_cost: null },
            },
          },
        },
      ]) {
        expect(
          Exit.isSuccess(
            decodeWrite({
              ...part,
              accounting: {
                ...accounting,
                usage: {
                  ...accounting.usage,
                  authoritative: { ...accounting.usage.authoritative, providerMetadata },
                },
              },
            }),
          ),
        ).toBe(true)
      }
      expect(
        Exit.isSuccess(
          decodeWrite({
            ...part,
            cost: 0.2,
            accounting: {
              ...accounting,
              pricing: {
                ...accounting.pricing,
                source: "provider",
                amount: 0.2,
                providerAmount: 0.2,
                estimateAmount: 0.25,
              },
            },
          }),
        ),
      ).toBe(true)
      for (const time of [
        { started: -1, completed: 110, duration: 5 },
        { started: 100.5, completed: 110, duration: 5 },
        { started: Number.POSITIVE_INFINITY, completed: 110, duration: 5 },
        { started: 100, completed: 99, duration: 0 },
        { started: 100, completed: 110, duration: 10.5 },
        { started: 100, completed: 110, duration: 11 },
      ]) {
        expect(Exit.isFailure(decodeWrite(withTime(time)))).toBe(true)
      }

      for (const pricing of [
        { ...accounting.pricing, amount: -0.1 },
        { ...accounting.pricing, providerAmount: -0.1 },
        { ...accounting.pricing, estimateAmount: -0.1 },
        { ...accounting.pricing, amount: Number.POSITIVE_INFINITY },
        { ...accounting.pricing, rate: { ...accounting.pricing.rate, input: -0.1 } },
        {
          ...accounting.pricing,
          rate: { ...accounting.pricing.rate, cache: { ...accounting.pricing.rate.cache, read: -0.1 } },
        },
        {
          ...accounting.pricing,
          rate: { ...accounting.pricing.rate, tier: { type: "context", size: -1 } },
        },
        {
          ...accounting.pricing,
          rate: { ...accounting.pricing.rate, tier: { type: "context", size: 1.5 } },
        },
        {
          ...accounting.pricing,
          rate: {
            ...accounting.pricing.rate,
            tier: { type: "context", size: Number.POSITIVE_INFINITY },
          },
        },
      ]) {
        expect(
          Exit.isFailure(decodeWrite({ ...part, accounting: { ...accounting, pricing } })),
        ).toBe(true)
      }

      for (const invalid of [
        { ...part, duration: 4 },
        { ...part, cost: 0.5 },
        { ...part, tokens: { ...part.tokens, total: 14 } },
        { ...part, tokens: { ...part.tokens, input: 5 } },
        { ...part, tokens: { ...part.tokens, cache: { ...part.tokens.cache, write: 6 } } },
        {
          ...part,
          accounting: {
            ...accounting,
            pricing: { ...accounting.pricing, source: "provider", amount: 0.25, providerAmount: undefined },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            pricing: { ...accounting.pricing, source: "provider", amount: 0.25, providerAmount: 0.2 },
          },
        },
        {
          ...part,
          accounting: { ...accounting, pricing: { ...accounting.pricing, estimateAmount: undefined } },
        },
        {
          ...part,
          accounting: { ...accounting, pricing: { ...accounting.pricing, amount: 0.2 } },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { custom: { secret: "reject" } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { openrouter: { usage: { cost: 0.25, secret: "reject" } } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { openrouter: { inputTokens: 1 } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { copilot: { cost: 1 } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { openai: { usage: { usage: { usage: { cost: 1 } } } } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: { ...accounting.usage.authoritative, providerMetadata: { anthropic: {} } },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { anthropic: { usage: { usage: { usage: { input_tokens: 1 } } } } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { anthropic: { iterations: [{}] } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { anthropic: { iterations: [{ model: "secret" }] } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: {
                  anthropic: {
                    iterations: [{ type: "message", model: "invented", input_tokens: 1, output_tokens: 2 }],
                  },
                },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: {
                  anthropic: { iterations: [{ type: "advisor_message", input_tokens: 1, output_tokens: 2 }] },
                },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: { anthropic: { usage: { cacheCreationInputTokens: 1 } } },
              },
            },
          },
        },
        {
          ...part,
          accounting: {
            ...accounting,
            usage: {
              ...accounting.usage,
              authoritative: {
                ...accounting.usage.authoritative,
                providerMetadata: {
                  anthropic: {
                    iterations: [
                      { type: "message", input_tokens: 1, output_tokens: 2, cacheCreationInputTokens: 1 },
                    ],
                  },
                },
              },
            },
          },
        },
      ]) {
        expect(Exit.isFailure(decodeWrite(invalid))).toBe(true)
      }

      const legacy = {
        ...part,
        accounting: {
          ...accounting,
          time: { started: -2.5, completed: -1.25, duration: -3.5 },
          pricing: {
            ...accounting.pricing,
            amount: -0.25,
            providerAmount: -0.2,
            estimateAmount: -0.25,
            rate: {
              ...accounting.pricing.rate,
              tier: { type: "context", size: -100 },
              input: -0.125,
              cache: { read: -0.0125, write: -0.05 },
            },
          },
        },
      }
      expect(Exit.isSuccess(decodeRead(legacy))).toBe(true)
      expect(Exit.isFailure(decodeWrite(legacy))).toBe(true)
    }),
  )

  it.effect("prevents stale V1 session metadata from overwriting aggregate columns", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      yield* db
        .update(SessionTable)
        .set({
          cost: 2,
          time_processing: 30,
          tokens_input: 11,
          tokens_output: 12,
          tokens_reasoning: 13,
          tokens_cache_read: 14,
          tokens_cache_write: 15,
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* (yield* EventV2.Service).publish(SessionV1.Event.Updated, {
        sessionID,
        info: {
          id: sessionID,
          slug: "test",
          projectID: Project.ID.global,
          directory: "/project",
          title: "updated",
          version: "test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 100, processing: 0 },
        },
      })

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        title: "updated",
        time_updated: 100,
        cost: 2,
        time_processing: 30,
        tokens_input: 11,
        tokens_output: 12,
        tokens_reasoning: 13,
        tokens_cache_read: 14,
        tokens_cache_write: 15,
      })
    }),
  )
  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: new Prompt({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: new Prompt({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(
      Effect.provide(
        SessionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(database),
          Layer.provide(Project.defaultLayer),
          Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
          Layer.provide(SessionExecution.noopLayer),
        ),
      ),
    ),
  )

  it.effect("marks an admitted lifecycle row promoted with the PromptPromoted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "promote me" }),
        delivery: "steer",
      })

      const event = yield* events.publish(SessionEvent.PromptLifecycle.Promoted, {
        sessionID,
        timestamp: created,
        messageID: id,
        prompt: new Prompt({ text: "promote me" }),
        timeCreated: created,
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("rejects a Prompted event that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_conflict")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "admitted" }),
        delivery: "steer",
      })

      const exit = yield* events
        .publish(SessionEvent.Prompted, {
          sessionID,
          messageID: id,
          timestamp: created,
          prompt: new Prompt({ text: "different" }),
          delivery: "steer",
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: null })
    }),
  )

  it.effect("rejects an assistant message ID that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_conflict")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "admitted" }),
        delivery: "steer",
      })

      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          timestamp: created,
          assistantMessageID: id,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects a Prompted delivery mode that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_delivery_conflict")
      const prompt = new Prompt({ text: "admitted" })
      yield* SessionInput.admit(db, events, { id, sessionID, prompt, delivery: "queue" })

      const exit = yield* events
        .publish(SessionEvent.Prompted, { sessionID, messageID: id, timestamp: created, prompt, delivery: "steer" })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ delivery: "queue", promoted_seq: null })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("rejects provider content after a terminal without reviving stale assistants", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      const exit = yield* service
        .publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
          timestamp: DateTime.makeUnsafe(3),
          textID: "text-stale",
        })
        .pipe(Effect.exit)
      expect(String(exit)).toContain("ContentAfterTerminal")

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )

  it.effect("allows local tool settlement after the provider terminal", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const assistantMessageID = SessionMessage.ID.make("msg_local_tool")
      const failedMessageID = SessionMessage.ID.make("msg_local_tool_failed")
      const localTool = (id: string) =>
        new SessionMessage.AssistantTool({
          type: "tool",
          id,
          name: "lookup",
          provider: { executed: false },
          time: { created, ran: created },
          state: new SessionMessage.ToolStateRunning({
            status: "running",
            input: { query: "test" },
            structured: {},
            content: [],
          }),
        })
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(assistantMessageID, 0, { created, completed: DateTime.makeUnsafe(1) }, [localTool("call-1")]),
          assistantRow(failedMessageID, 1, { created, completed: DateTime.makeUnsafe(1) }, [localTool("call-failed")]),
        ])
        .run()
        .pipe(Effect.orDie)

      yield* (yield* EventV2.Service).publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(2),
        callID: "call-1",
        structured: { ok: true },
        content: [],
        result: "done",
        provider: { executed: false },
      })
      yield* (yield* EventV2.Service).publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID: failedMessageID,
        timestamp: DateTime.makeUnsafe(2),
        callID: "call-failed",
        error: { type: "unknown", message: "local failed" },
        provider: { executed: false },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toMatchObject([
        {
          type: "assistant",
          time: { completed: DateTime.makeUnsafe(1) },
          content: [{ type: "tool", state: { status: "completed", result: "done" } }],
        },
        {
          type: "assistant",
          time: { completed: DateTime.makeUnsafe(1) },
          content: [{ type: "tool", state: { status: "error", error: { message: "local failed" } } }],
        },
      ])
    }),
  )

  it.effect("transactionally rejects provider tool settlement after the terminal", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db)
      const successID = SessionMessage.ID.make("msg_provider_tool_success")
      const failedID = SessionMessage.ID.make("msg_provider_tool_failed")
      const running = (id: string) =>
        new SessionMessage.AssistantTool({
          type: "tool",
          id,
          name: "lookup",
          provider: { executed: true },
          time: { created, ran: created },
          state: new SessionMessage.ToolStateRunning({
            status: "running",
            input: { query: "test" },
            structured: {},
            content: [],
          }),
        })
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(successID, 0, { created, completed: DateTime.makeUnsafe(1) }, [running("call-success")]),
          assistantRow(failedID, 1, { created, completed: DateTime.makeUnsafe(1) }, [running("call-failed")]),
        ])
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      const success = yield* events
        .publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID: successID,
          timestamp: DateTime.makeUnsafe(2),
          callID: "call-success",
          structured: { ok: true },
          content: [],
          result: "done",
          provider: { executed: true },
        })
        .pipe(Effect.exit)
      const failed = yield* events
        .publish(SessionEvent.Tool.Failed, {
          sessionID,
          assistantMessageID: failedID,
          timestamp: DateTime.makeUnsafe(2),
          callID: "call-failed",
          error: { type: "unknown", message: "failed" },
          provider: { executed: true },
        })
        .pipe(Effect.exit)
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      const eventRows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(String(success)).toContain("ContentAfterTerminal")
      expect(String(failed)).toContain("ContentAfterTerminal")
      expect(messages.map((message) => (message.type === "assistant" ? message.content[0] : undefined))).toMatchObject([
        { type: "tool", state: { status: "running" } },
        { type: "tool", state: { status: "running" } },
      ])
      expect(eventRows).toHaveLength(0)
    }),
  )
})
