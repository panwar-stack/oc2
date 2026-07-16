import { NodeFileSystem } from "@effect/platform-node"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@oc2-ai/core/util/log"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { ModelV2 } from "@oc2-ai/core/model"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { LLMEvent, Usage } from "@oc2-ai/llm"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function fuguProviderCfg(url: string) {
  return {
    ...providerCfg(url),
    fugu: {
      branches: [{ model: "test/test-model" }, { model: "test/test-model" }],
      synthesizer: { model: "test/test-model" },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

function timedStream(
  events: LLMEvent[],
  attempts: ReadonlyArray<{ step: number; started: number; completed: number; outcome: LLM.ProviderOutcome }>,
) {
  let now = 0
  const timing = LLM.makeProviderTiming(() => now)
  for (const attempt of attempts) {
    LLM.beginProviderStep(timing, attempt.step)
    now = attempt.started
    LLM.beginProviderAttempt(timing)
    now = attempt.completed
    LLM.finishProviderAttempt(timing, attempt.outcome)
  }
  return LLM.withProviderTiming(Stream.fromIterable(events), timing)
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      timedStream(
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
          LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
          LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
          LLMEvent.toolResult({
            id: "call-1",
            name: "lookup",
            result: { type: "error", value: "provider boom" },
            providerExecuted: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [{ step: 0, started: 100, completed: 150, outcome: "success" }],
      ),
  }),
)
const providerErrorEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(providerErrorLLM),
  Layer.provideMerge(deps),
)
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      timedStream(
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-1" }),
          LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "partial" }),
          LLMEvent.providerError({ message: "Provider stream ended without a terminal event" }),
        ],
        [{ step: 0, started: 200, completed: 225, outcome: "eof" }],
      ),
  }),
)
const fragmentFailureEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(fragmentFailureLLM),
  Layer.provideMerge(deps),
)
const itFragmentFailure = testEffect(fragmentFailureEnv)

const mirrorUsage = Usage.from({
  inputTokens: 10,
  outputTokens: 7,
  nonCachedInputTokens: 6,
  cacheReadInputTokens: 3,
  cacheWriteInputTokens: 1,
  reasoningTokens: 2,
  totalTokens: 17,
})
const mirrorUsageLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      timedStream(
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: mirrorUsage,
          }),
          LLMEvent.stepStart({ index: 1 }),
          LLMEvent.stepFinish({
            index: 1,
            reason: "stop",
            usage: mirrorUsage,
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          { step: 0, started: 100, completed: 150, outcome: "success" },
          { step: 1, started: 1_000, completed: 1_030, outcome: "success" },
        ],
      ),
  }),
)
const mirrorUsageEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(mirrorUsageLLM),
  Layer.provideMerge(deps),
)
const itMirrorUsage = testEffect(mirrorUsageEnv)

const retryUsage = (attempt: number) =>
  Usage.from({
    inputTokens: attempt + 10,
    nonCachedInputTokens: attempt,
    cacheReadInputTokens: 7,
    cacheWriteInputTokens: 3,
    outputTokens: attempt + 10,
    totalTokens: attempt * 2 + 20,
    providerTotalTokens: 1_000 + attempt,
    providerMetadata: { openrouter: { usage: { cost: attempt / 100 } } },
  })
const conflictingRetryMetadata = {
  openrouter: { usage: { cost: 99, promptTokens: 999 } },
  custom: { secret: "must not persist" },
}
const retryThenSuccessLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      const attempt = input.attempt ?? 1
      return attempt === 1
        ? timedStream(
            [
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.providerError({
                message: "temporary provider fault",
                retryable: true,
                usage: retryUsage(attempt),
                providerMetadata: conflictingRetryMetadata,
              }),
            ],
            [{ step: 0, started: 100, completed: 110, outcome: "error" }],
          )
        : timedStream(
            [
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage: retryUsage(attempt) }),
              LLMEvent.finish({ reason: "stop" }),
            ],
            [{ step: 0, started: 200, completed: 220, outcome: "success" }],
          )
    },
  }),
)
const retryThenSuccessEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(retryThenSuccessLLM),
  Layer.provideMerge(deps),
)
const itRetryThenSuccess = testEffect(retryThenSuccessEnv)

const retryFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      const attempt = input.attempt ?? 1
      return timedStream(
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({
            message: "rate limit",
            usage: retryUsage(attempt),
            providerMetadata: conflictingRetryMetadata,
          }),
        ],
        [{ step: 0, started: attempt * 100, completed: attempt * 100 + 10, outcome: "error" }],
      )
    },
  }),
)
const retryFailureEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(retryFailureLLM),
  Layer.provideMerge(deps),
)
const itRetryFailure = testEffect(retryFailureEnv)

const preStepFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.fromEffect(Effect.sleep("20 millis")).pipe(
        Stream.flatMap(() => Stream.fail(new Error("pre-step failure"))),
      ),
  }),
)
const preStepFailureEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(preStepFailureLLM),
  Layer.provideMerge(deps),
)
const itPreStepFailure = testEffect(preStepFailureEnv)

const endedThenFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      timedStream(
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: mirrorUsage }),
          LLMEvent.providerError({ message: "late stream failure", usage: retryUsage(99) }),
        ],
        [{ step: 0, started: 500, completed: 550, outcome: "success" }],
      ),
  }),
)
const endedThenFailureEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(endedThenFailureLLM),
  Layer.provideMerge(deps),
)
const itEndedThenFailure = testEffect(endedThenFailureEnv)
const endedThenFailureLegacyEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: false })),
  Layer.provide(endedThenFailureLLM),
  Layer.provideMerge(deps),
)
const itEndedThenFailureLegacy = testEffect(endedThenFailureLegacyEnv)

const nextStepFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      const rejection = JSON.stringify(input.messages).includes("rejection")
      const stream = timedStream(
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: mirrorUsage }),
          ...(rejection ? [] : [LLMEvent.providerError({ message: "Provider stream ended without a terminal event" })]),
        ],
        [
          { step: 0, started: 100, completed: 150, outcome: "success" },
          { step: 1, started: 1_000, completed: 1_030, outcome: rejection ? "error" : "eof" },
        ],
      )
      if (!rejection) return stream
      const timing = LLM.providerTiming(stream)
      if (!timing) throw new Error("missing test provider timing")
      return LLM.withProviderTiming(
        stream.pipe(Stream.concat(Stream.fail(new Error("step 1 rejected before first chunk")))),
        timing,
      )
    },
  }),
)
const nextStepFailureEnv = SessionProcessor.layer.pipe(
  Layer.provide(summary),
  Layer.provide(Image.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
  Layer.provide(nextStepFailureLLM),
  Layer.provideMerge(deps),
)
const itNextStepFailure = testEffect(nextStepFailureEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itMirrorUsage.live("session.processor effect tests publish authoritative mirror accounting", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "mirror usage")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const settlements: Array<typeof SessionEvent.Step.Ended.Type> = []
        let failure: string | undefined
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Step.Ended.type)
            settlements.push(event as typeof SessionEvent.Step.Ended.Type)
          if (event.type === SessionEvent.Step.Failed.type)
            failure = (event.data as typeof SessionEvent.Step.Failed.data.Type).error.message
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "mirror usage" }],
          tools: {},
        })
        yield* off

        expect(failure).toBeUndefined()
        expect(settlements).toHaveLength(2)
        expect(settlements[1]?.data.accounting).toMatchObject({
          mode: "mirror",
          purpose: "assistant",
          model: { id: ref.modelID, providerID: ref.providerID },
          usage: {
            source: "step-finish",
            authoritative: { input: 6, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
          },
          pricing: { source: "catalog", amount: 0 },
          time: { duration: 30 },
        })
        const persisted = (yield* session.messages({ sessionID: chat.id })).find((item) => item.info.id === msg.id)
        expect(persisted?.parts.filter((part) => part.type === "step-finish").map((part) => part.duration)).toEqual([
          50, 30,
        ])
      }),
    { config: cfg },
  ),
)

itMirrorUsage.live("automation-safe processor never creates snapshots", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const snapshot = yield* Snapshot.Service
        const original = { track: snapshot.track, trackDetailed: snapshot.trackDetailed }
        Object.assign(snapshot, {
          track: () => Effect.die("automation called snapshot.track"),
          trackDetailed: () => Effect.die("automation called snapshot.trackDetailed"),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(snapshot, original)))
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "safe processing")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          automationSafe: true,
        })

        const result = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
            automation: true,
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "safe processing" }],
          tools: {},
        })

        expect(result).toBe("continue")
        const parts = yield* MessageV2.parts(msg.id)
        expect(
          parts
            .filter((part) => part.type === "step-start" || part.type === "step-finish")
            .every((part) => part.snapshot === undefined),
        ).toBe(true)
      }),
    { config: cfg },
  ),
)

itPreStepFailure.live("session.processor effect tests leave pre-dispatch failures without accounting", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "pre-step failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        let accounting: SessionEvent.Step.Accounting | undefined
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Step.Failed.type)
            accounting = (event.data as typeof SessionEvent.Step.Failed.data.Type).accounting
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "pre-step failure" }],
          tools: {},
        })
        yield* off

        expect(accounting).toBeUndefined()
      }),
    { config: cfg },
  ),
)

itEndedThenFailure.live("session.processor effect tests do not fail an already ended provider step", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "late failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        let ended = 0
        let failed = 0
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Step.Ended.type) ended++
          if (event.type === SessionEvent.Step.Failed.type) failed++
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "late failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        expect({ ended, failed }).toEqual({ ended: 1, failed: 0 })
        const persisted = (yield* session.messages({ sessionID: chat.id })).find((item) => item.info.id === msg.id)
        expect(persisted?.parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
      }),
    { config: cfg },
  ),
)

itEndedThenFailureLegacy.live("session.processor ignores late billed error usage without v2 mirroring", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "legacy late failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "legacy late failure" }],
            tools: {},
          }),
        ).toBe("stop")

        const parts = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.StepFinishPart => part.type === "step-finish",
        )
        expect(parts).toHaveLength(1)
        expect(parts[0]?.reason).toBe("stop")
        expect(parts[0]?.tokens.input).toBe(6)
      }),
    { config: cfg },
  ),
)

const nextStepFailure = (message: string) =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, message)
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const ended: Array<typeof SessionEvent.Step.Ended.Type> = []
        const failed: Array<typeof SessionEvent.Step.Failed.Type> = []
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Step.Ended.type) ended.push(event as typeof SessionEvent.Step.Ended.Type)
          if (event.type === SessionEvent.Step.Failed.type) failed.push(event as typeof SessionEvent.Step.Failed.Type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: message }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        expect(ended).toHaveLength(1)
        expect(failed).toHaveLength(1)
        expect(failed[0]?.data.accounting?.time).toMatchObject({ duration: 30 })
        const persisted = (yield* session.messages({ sessionID: chat.id })).find((item) => item.info.id === msg.id)
        expect(persisted?.parts.filter((part) => part.type === "step-finish")).toHaveLength(1)
        expect(persisted?.info).toMatchObject({ finish: "error", error: {} })
      }),
    { config: cfg },
  )

itNextStepFailure.live("fails raw step 1 EOF before its first normalized chunk", () => nextStepFailure("step 1 eof"))

itNextStepFailure.live("fails raw step 1 rejection before its first normalized chunk", () =>
  nextStepFailure("step 1 rejection"),
)

it.live("session.processor effect tests persist and stream only fugu synthesizer output", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.push(
          reply().text("hidden branch a").stop(),
          reply().text("hidden branch b").stop(),
          reply().text("final ").text("answer").stop(),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "current fugu turn")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ProviderV2.ID.make("fugu"), ModelV2.ID.make("fugu"))
        const deltas: string[] = []
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Text.Delta.type) {
            const data = event.data as typeof SessionEvent.Text.Delta.data.Type
            deltas.push(data.delta)
          }
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ProviderV2.ID.make("fugu"), modelID: ModelV2.ID.make("fugu") },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: ["system instruction", "developer instruction"],
          messages: [
            { role: "user", content: "prior user" },
            { role: "assistant", content: "prior assistant" },
            { role: "user", content: "current fugu turn" },
          ],
          tools: {},
        })

        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")
        const inputs = yield* llm.inputs
        const serializedInputs = inputs.map((input) => JSON.stringify(input))
        const synthInput = serializedInputs.find((input) => input.includes("final answer synthesizer"))
        const branchInputs = serializedInputs.filter((input) => !input.includes("final answer synthesizer"))
        const visibleParts = JSON.stringify(parts)
        const streamedText = deltas.join("")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(3)
        expect(text?.text).toBe("final answer")
        expect(visibleParts).not.toContain("hidden branch")
        expect(visibleParts).not.toContain("test/test-model")
        expect(deltas).toEqual(["final ", "answer"])
        expect(streamedText).not.toContain("hidden branch")
        expect(streamedText).not.toContain("test/test-model")

        expect(branchInputs).toHaveLength(2)
        for (const input of branchInputs) {
          expect(input).toContain("system instruction")
          expect(input).toContain("developer instruction")
          expect(input).toContain("prior user")
          expect(input).toContain("prior assistant")
          expect(input).toContain("current fugu turn")
          expect(input).not.toContain("hidden branch")
          expect(input).not.toContain("final answer synthesizer")
        }

        expect(synthInput).toContain("system instruction")
        expect(synthInput).toContain("developer instruction")
        expect(synthInput).toContain("prior user")
        expect(synthInput).toContain("prior assistant")
        expect(synthInput).toContain("current fugu turn")
        expect(synthInput).toContain("hidden branch a")
        expect(synthInput).toContain("hidden branch b")
      }),
    { config: (url) => fuguProviderCfg(url) },
  ),
)

it.live("session.processor effect tests complete fugu synthesizer tool calls", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          reply().text("hidden branch a").stop(),
          reply().text("hidden branch b").stop(),
          reply().tool("lookup", { query: "weather" }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "current fugu tool turn")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ProviderV2.ID.make("fugu"), ModelV2.ID.make("fugu"))
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ProviderV2.ID.make("fugu"), modelID: ModelV2.ID.make("fugu") },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "current fugu tool turn" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "fugu-test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const visibleParts = JSON.stringify(parts)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(3)
        expect(visibleParts).not.toContain("hidden branch")
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "fugu-test" })
      }),
    { config: (url) => fuguProviderCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itRetryThenSuccess.effect("session.processor accounts failed usage once before retry success", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry accounting")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const retried: number[] = []
        let failed = 0
        const off = yield* events.listen((event) => {
          if (Schema.is(SessionEvent.Retried)(event)) retried.push(event.data.attempt)
          if (event.type === SessionEvent.Step.Failed.type) failed++
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "retry accounting" }],
            tools: {},
          })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust("2 seconds")
        expect(handle.message.error).toBeUndefined()
        expect(yield* Fiber.join(result)).toBe("continue")
        yield* off

        const parts = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.StepFinishPart => part.type === "step-finish",
        )
        expect(parts.map((part) => part.reason)).toEqual(["error", "stop"])
        expect(parts.map((part) => part.tokens.input)).toEqual([1, 2])
        expect(parts.map((part) => part.cost)).toEqual([0.01, 0])
        expect(parts[0]).toMatchObject({
          duration: 10,
          tokens: {
            total: 1_001,
            input: 1,
            output: 11,
            reasoning: 0,
            cache: { read: 7, write: 3 },
          },
          accounting: {
            mode: "aggregate",
            purpose: "assistant",
            model: { id: ref.modelID, providerID: ref.providerID },
            time: { started: 100, completed: 110, duration: 10 },
            usage: {
              source: "provider-error",
              authoritative: {
                input: 1,
                output: 11,
                reasoning: 0,
                cache: { read: 7, write: 3 },
                providerTotal: 1_001,
                providerMetadata: { openrouter: { usage: { cost: 0.01, promptTokens: 999 } } },
              },
            },
            pricing: {
              source: "provider",
              amount: 0.01,
              providerAmount: 0.01,
              estimateAmount: 0,
              rate: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            },
          },
        })
        expect(parts[0]?.accounting?.usage.authoritative.providerMetadata).not.toHaveProperty("custom")
        expect(retried).toEqual([1])
        expect(failed).toBe(0)
      }),
    { config: cfg },
  ),
)

itRetryFailure.effect("session.processor accounts eight failed attempts and publishes seven retries", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "terminal retry accounting")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const retried: number[] = []
        const failed: Array<typeof SessionEvent.Step.Failed.Type> = []
        const off = yield* events.listen((event) => {
          if (Schema.is(SessionEvent.Retried)(event)) retried.push(event.data.attempt)
          if (Schema.is(SessionEvent.Step.Failed)(event)) failed.push(event)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "terminal retry accounting" }],
            tools: {},
          })
          .pipe(Effect.forkChild)
        for (const wait of [2, 4, 8, 16, 30, 30, 30]) {
          yield* Effect.yieldNow
          yield* TestClock.adjust(`${wait} seconds`)
        }
        expect(yield* Fiber.join(result)).toBe("stop")
        yield* off

        const persisted = yield* MessageV2.parts(msg.id)
        const parts = persisted.filter(
          (part): part is SessionV1.StepFinishPart => part.type === "step-finish",
        )
        expect(persisted.filter((part) => part.type === "step-start")).toHaveLength(8)
        expect(parts).toHaveLength(8)
        expect(parts.map((part) => part.tokens.input)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        expect(parts.map((part) => part.cost)).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08])
        expect(parts.every((part) => part.accounting?.usage.source === "provider-error")).toBe(true)
        expect(retried).toEqual([1, 2, 3, 4, 5, 6, 7])
        expect(failed).toHaveLength(1)
        expect(failed[0]?.data.accounting?.usage?.authoritative.input).toBe(8)
        expect(failed[0]?.data.accounting?.usage?.authoritative.providerTotal).toBe(1_008)
        expect(failed[0]?.data.accounting?.usage?.authoritative.providerMetadata).toEqual({
          openrouter: { usage: { cost: 0.08, promptTokens: 999 } },
        })
        expect(failed[0]?.data.accounting?.pricing?.amount).toBe(0.08)
        expect(handle.message.cost).toBeCloseTo(0.36)
        const aggregate = yield* session.get(chat.id)
        expect(aggregate.cost).toBeCloseTo(0.36)
        expect(aggregate).toMatchObject({
          time: { processing: 80 },
          tokens: {
            input: 36,
            output: 116,
            reasoning: 0,
            cache: { read: 56, write: 24 },
          },
        })
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const settlements: Array<typeof SessionEvent.Tool.Failed.Type> = []
        const off = yield* events.listen((event) => {
          if (event.type === SessionEvent.Tool.Failed.type)
            settlements.push(event as typeof SessionEvent.Tool.Failed.Type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(settlements).toHaveLength(1)
        expect(settlements[0]?.data).toMatchObject({
          callID: "call-1",
          error: { type: "unknown", message: "provider boom" },
          result: { type: "error", value: "provider boom" },
          provider: { executed: true },
        })
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor flushes partial fragments without an accounting part when usage is missing", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        let text: string | undefined
        let reasoning: string | undefined
        const textDeltas: string[] = []
        const reasoningDeltas: string[] = []
        let failedAccounting: SessionEvent.Step.Accounting | undefined
        let ended = 0
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          if (event.type === SessionEvent.Text.Delta.type)
            textDeltas.push((event.data as typeof SessionEvent.Text.Delta.data.Type).delta)
          if (event.type === SessionEvent.Reasoning.Delta.type)
            reasoningDeltas.push((event.data as typeof SessionEvent.Reasoning.Delta.data.Type).delta)
          if (event.type === SessionEvent.Text.Ended.type)
            text = (event.data as typeof SessionEvent.Text.Ended.data.Type).text
          if (event.type === SessionEvent.Reasoning.Ended.type)
            reasoning = (event.data as typeof SessionEvent.Reasoning.Ended.data.Type).text
          if (event.type === SessionEvent.Step.Failed.type)
            failedAccounting = (event.data as typeof SessionEvent.Step.Failed.data.Type).accounting
          if (event.type === SessionEvent.Step.Ended.type) ended++
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const failed = seen.indexOf(SessionEvent.Step.Failed.type)
        expect(failed).toBeGreaterThan(-1)
        expect(seen.indexOf(SessionEvent.Text.Ended.type)).toBeLessThan(failed)
        expect(seen.indexOf(SessionEvent.Reasoning.Ended.type)).toBeLessThan(failed)
        expect(textDeltas).toEqual(["partial"])
        expect(reasoningDeltas).toEqual(["thinking"])
        expect(text).toBe("partial")
        expect(reasoning).toBe("thinking")
        expect(failedAccounting).toMatchObject({
          mode: "mirror",
          purpose: "assistant",
          model: { id: ref.modelID, providerID: ref.providerID },
        })
        expect(failedAccounting).not.toHaveProperty("usage")
        expect(failedAccounting).not.toHaveProperty("pricing")
        expect(ended).toBe(0)
        const persisted = (yield* session.messages({ sessionID: chat.id })).find((item) => item.info.id === msg.id)
        expect(persisted?.parts.filter((part) => part.type === "step-finish")).toHaveLength(0)
        expect(persisted?.info).toMatchObject({ finish: "error", error: {} })
      }),
    { config: cfg },
  ),
)
