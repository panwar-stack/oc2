import { describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SupervisorState } from "@/supervisor"
import { Supervisor } from "@/supervisor/supervisor"
import { Effect, Layer, Queue, Schema } from "effect"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import * as Option from "effect/Option"

void Log.init({ print: false })

type Recommendation = Schema.Schema.Type<typeof Supervisor.Recommendation>

let generationEvents: Queue.Queue<void> | undefined

const model: Provider.Model = {
  id: ModelID.make("test"),
  providerID: ProviderID.make("test"),
  api: { npm: "test", id: "test", url: "" },
  name: "test",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const language: LanguageModelV3 = {
  specificationVersion: "v3",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  doGenerate: (options) =>
    Promise.resolve().then(() => {
      if (generationEvents) Queue.offerUnsafe(generationEvents, undefined)
      const prompt = options.prompt.flatMap((message) =>
        message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
      ).at(-1)
      const repeatedFailure = prompt?.includes("repeated_command_failure") ?? false
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              repeatedFailure
                ? {
                    recommend: true,
                    action: "nudge",
                    trigger: "repeated_command_failure",
                    message: "Inspect the failing command before continuing.",
                    evidence: ["command:bun test"],
                  }
                : {
                    recommend: true,
                    action: "nudge",
                    trigger: "missing_validation",
                    message: "Run validation before wrapping up.",
                    evidence: ["file:src/app.ts"],
                  },
            ),
          },
        ],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    }),
  doStream: () => Promise.reject(new Error("streaming is not used")),
}

const it = testEffect(
  SupervisorState.layer.pipe(
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Session.defaultLayer),
    Layer.provideMerge(SessionStatus.layer),
    Layer.provideMerge(SessionSummary.defaultLayer),
    Layer.provideMerge(Layer.mock(Provider.Service, {
      getModel: () => Effect.succeed(model),
      getLanguage: () => Effect.succeed(language),
    })),
    Layer.provideMerge(Bus.layer),
  ),
)

function addMessage(sessionID: MessageV2.User["sessionID"]) {
  return Session.Service.use((session) =>
    session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now() },
    } as MessageV2.User),
  )
}

function updatePatch(input: { sessionID: MessageV2.User["sessionID"]; messageID: MessageID }) {
  return Session.Service.use((session) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "patch",
      hash: PartID.ascending(),
      files: ["src/app.ts"],
    }),
  )
}

function updateFailedCommand(input: { sessionID: MessageV2.User["sessionID"]; messageID: MessageID }) {
  return Session.Service.use((session) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool",
      callID: PartID.ascending(),
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "bun test" },
        output: "",
        title: "bun test",
        metadata: { exitCode: 1 },
        time: { start: Date.now(), end: Date.now() },
      },
    }),
  )
}

function configureSupervisor(input: {
  sessionID: MessageV2.User["sessionID"]
  insert?: boolean
  mode?: Supervisor.Mode
  max?: number
}) {
  return SupervisorState.Service.use((supervisor) =>
    supervisor.updateSettings({
      sessionID: input.sessionID,
      patch: {
        mode: input.mode ?? "advise",
        recommendation_model: "test/test",
        recommendation_timeout_ms: 1000,
        review_cadence: "step",
        min_review_interval_ms: 1,
        max_recommendation_chars: 60,
        max_repeated_command_failures: 1,
        max_recommendations_per_session: input.max ?? 4,
        insert_recommendations: input.insert ?? true,
      },
    }),
  )
}

function subscribeRecommendations(sessionID: MessageV2.User["sessionID"]) {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const events = yield* Queue.unbounded<Recommendation>()
    yield* Effect.acquireRelease(
      bus.subscribeCallback(Supervisor.Event.RecommendationCreated, (event) => {
        if (event.properties.sessionID === sessionID) Queue.offerUnsafe(events, event.properties.recommendation)
      }),
      (off) => Effect.sync(off),
    )
    return events
  })
}

function supervisorTextPartCount(sessionID: MessageV2.User["sessionID"]) {
  return Session.Service.use((session) =>
    session.messages({ sessionID }).pipe(
      Effect.map(
        (messages) =>
          messages.flatMap((message) =>
            message.parts.filter(
              (part) => part.type === "text" && part.synthetic && part.metadata?.supervisor !== undefined,
            ),
          ).length,
      ),
    ),
  )
}

function supervisorTextParts(sessionID: MessageV2.User["sessionID"]) {
  return Session.Service.use((session) =>
    session.messages({ sessionID }).pipe(
      Effect.map((messages) =>
        messages.flatMap((message) =>
          message.parts.filter((part) => part.type === "text" && part.synthetic && part.metadata?.supervisor !== undefined),
        ),
      ),
    ),
  )
}

function expectNoRecommendation(events: Queue.Queue<Recommendation>) {
  return Effect.gen(function* () {
    expect(Option.isNone(yield* Queue.take(events).pipe(Effect.timeoutOption("200 millis")))).toBe(true)
  })
}

describe("supervisor recommendation insertion", () => {
  it.instance("queues on step while busy and inserts a visible synthetic user text part at idle", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const events = yield* subscribeRecommendations(info.id)
      generationEvents = yield* Queue.unbounded<void>()

      yield* supervisor.init()
      yield* configureSupervisor({ sessionID: info.id, max: 1 })
      yield* status.set(info.id, { type: "busy" })
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })

      yield* awaitWithTimeout(Queue.take(generationEvents), "recommendation was not generated while busy")
      yield* expectNoRecommendation(events)
      yield* status.set(info.id, { type: "idle" })

      const recommendation = yield* awaitWithTimeout(Queue.take(events), "recommendation was not inserted")
      const inserted = recommendation.inserted
      expect(inserted?.messageID).toBeString()
      expect(inserted?.partID).toBeString()

      const messages = yield* session.messages({ sessionID: info.id })
      const insertedMessage = messages.find((item) => item.info.id === inserted?.messageID)
      const part = insertedMessage?.parts.find((part) => part.id === inserted?.partID)
      expect(insertedMessage?.info.role).toBe("user")
      expect(part?.type).toBe("text")
      expect(part?.type === "text" ? part.synthetic : false).toBe(true)
      expect(part?.type === "text" ? part.text.length : 0).toBeLessThanOrEqual(60)
      expect(part?.type === "text" ? part.text : "").toContain("Evidence:")
      expect(part?.type === "text" ? part.text : "").toContain("- command:bun test")
      expect(part?.type === "text" ? part.metadata?.supervisor : undefined).toMatchObject({ inserted })
      expect(MessageV2.latest(messages).user?.id === inserted?.messageID).toBe(true)
      expect(MessageV2.latestPrimaryUser(messages)?.id === message.id).toBe(true)

      const modelMessages = yield* MessageV2.toModelMessagesEffect(messages, model)
      const modelText = modelMessages.flatMap((message) =>
        message.role === "user"
          ? typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      )
      expect(modelText.some((text) => text.includes("Evidence:") && text.includes("- command:bun test"))).toBe(true)
    }),
  )

  it.instance("drops queued recommendation when insertion is disabled before idle", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const events = yield* subscribeRecommendations(info.id)
      generationEvents = yield* Queue.unbounded<void>()

      yield* supervisor.init()
      yield* configureSupervisor({ sessionID: info.id })
      yield* status.set(info.id, { type: "busy" })
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })
      yield* awaitWithTimeout(Queue.take(generationEvents), "recommendation was not generated while busy")
      yield* expectNoRecommendation(events)

      yield* configureSupervisor({ sessionID: info.id, insert: false })
      yield* status.set(info.id, { type: "idle" })

      yield* expectNoRecommendation(events)
      expect((yield* supervisor.get(info.id)).recommendation).toBeUndefined()
      expect(yield* supervisorTextPartCount(info.id)).toBe(0)
    }),
  )

  it.instance("flushes queued recommendation at prompt boundary while still busy", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const events = yield* subscribeRecommendations(info.id)
      generationEvents = yield* Queue.unbounded<void>()

      yield* supervisor.init()
      yield* configureSupervisor({ sessionID: info.id, max: 1 })
      yield* status.set(info.id, { type: "busy" })
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })

      yield* awaitWithTimeout(Queue.take(generationEvents), "recommendation was not generated while busy")
      yield* expectNoRecommendation(events)

      expect(yield* supervisor.flushPendingInsertion(info.id)).toBe(true)
      expect((yield* status.get(info.id)).type).toBe("busy")

      const recommendation = yield* awaitWithTimeout(Queue.take(events), "recommendation was not inserted")
      expect(recommendation.inserted?.messageID).toBeString()
      expect(yield* supervisorTextPartCount(info.id)).toBe(1)
    }),
  )

  it.instance("rebuilds inserted recommendation linkage from persisted supervisor metadata", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const events = yield* subscribeRecommendations(info.id)
      generationEvents = yield* Queue.unbounded<void>()

      yield* supervisor.init()
      yield* configureSupervisor({ sessionID: info.id, max: 1 })
      yield* status.set(info.id, { type: "busy" })
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })
      yield* awaitWithTimeout(Queue.take(generationEvents), "recommendation was not generated while busy")
      yield* status.set(info.id, { type: "idle" })

      const recommendation = yield* awaitWithTimeout(Queue.take(events), "recommendation was not inserted")
      const part = (yield* supervisorTextParts(info.id))[0]
      expect(part?.id === recommendation.inserted?.partID).toBe(true)

      yield* configureSupervisor({ sessionID: info.id, mode: "off" })
      yield* configureSupervisor({ sessionID: info.id, max: 1 })

      const rebuilt = yield* supervisor.get(info.id)
      expect(rebuilt.recommendation?.inserted?.messageID).toBe(recommendation.inserted?.messageID)
      expect(rebuilt.recommendation?.inserted?.partID).toBe(recommendation.inserted?.partID)
    }),
  )

  it.instance("drops queued recommendation when mode is switched off before idle", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const events = yield* subscribeRecommendations(info.id)
      generationEvents = yield* Queue.unbounded<void>()

      yield* supervisor.init()
      yield* configureSupervisor({ sessionID: info.id })
      yield* status.set(info.id, { type: "busy" })
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })
      yield* awaitWithTimeout(Queue.take(generationEvents), "recommendation was not generated while busy")
      yield* expectNoRecommendation(events)

      yield* configureSupervisor({ sessionID: info.id, mode: "off" })
      yield* status.set(info.id, { type: "idle" })

      yield* expectNoRecommendation(events)
      expect(yield* supervisorTextPartCount(info.id)).toBe(0)
    }),
  )

  it.instance("dedupes repeated same trigger/state and honors max recommendations", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const status = yield* SessionStatus.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const events = yield* subscribeRecommendations(info.id)
      generationEvents = yield* Queue.unbounded<void>()

      yield* supervisor.init()
      yield* configureSupervisor({ sessionID: info.id, max: 1 })
      yield* status.set(info.id, { type: "busy" })
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })
      yield* awaitWithTimeout(Queue.take(generationEvents), "first recommendation was not evaluated")
      yield* updateFailedCommand({ sessionID: info.id, messageID: message.id })
      yield* awaitWithTimeout(Queue.take(generationEvents), "duplicate recommendation was not evaluated")
      yield* expectNoRecommendation(events)

      yield* status.set(info.id, { type: "idle" })
      yield* awaitWithTimeout(Queue.take(events), "queued recommendation was not inserted")

      yield* expectNoRecommendation(events)
      expect(yield* supervisorTextPartCount(info.id)).toBe(1)
    }),
  )
})
