import { expect, test } from "bun:test"
import { DateTime, Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@oc2-ai/llm"
import { EventV2 } from "@oc2-ai/core/event"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { SessionMessage } from "@oc2-ai/core/session/message"
import { SessionV2 } from "@oc2-ai/core/session"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { createLLMEventPublisher } from "@oc2-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const providerID = ProviderV2.ID.make("provider")
const modelID = ModelV2.ID.make("model")
const emptyCatalog = ModelV2.Info.empty(providerID, modelID)

const capture = (input?: {
  readonly catalog?: ModelV2.Info
  readonly variant?: ModelV2.VariantID
  readonly clock?: () => number
}) => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.sync ? EventV2.versionedType(definition.type, definition.sync.version) : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    aggregateEvents: () => Stream.empty,
    sync: () => Effect.succeed(Effect.void),
    listen: () => Effect.succeed(Effect.void),
    beforeCommit: () => Effect.void,
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: modelID,
        providerID,
        ...(input?.variant === undefined ? {} : { variant: input.variant }),
      },
      catalog: input?.catalog ?? emptyCatalog,
      clock: input?.clock,
    }),
  }
}

const usage = {
  inputTokens: 20,
  nonCachedInputTokens: 10,
  cacheReadInputTokens: 6,
  cacheWriteInputTokens: 4,
  outputTokens: 10,
  reasoningTokens: 3,
}

const terminals = (published: ReadonlyArray<{ readonly type: string; readonly data: unknown }>) =>
  published.filter(
    (event) => event.type === "session.next.step.ended.2" || event.type === "session.next.step.failed.2",
  )

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "media", mediaType: "image/png", data: base64, filename: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", source: { type: "data", data: base64 }, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", source: { type: "data", data: base64 }, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", source: { type: "data", data: base64 }, mime: "image/png" }],
    result: { type: "content", value: [{ type: "media", mediaType: "image/png", data: base64 }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("settles one aggregate terminal with selected variant pricing and provider duration", async () => {
  let now = 1_000
  const rate = { input: 2, output: 8, cache: { read: 0.2, write: 1 } }
  const catalog = new ModelV2.Info({
    ...emptyCatalog,
    cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
    variants: [
      {
        id: ModelV2.VariantID.make("high"),
        headers: {},
        body: {},
        generation: {},
        options: {},
        cost: [rate],
      },
    ],
  })
  const { published, publisher } = capture({
    catalog,
    variant: ModelV2.VariantID.make("high"),
    clock: () => now,
  })
  publisher.startAttempt()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  now = 1_080
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage })))
  now = 1_120
  await Effect.runPromise(publisher.publish(LLMEvent.finish({ reason: "stop", usage })))
  await Effect.runPromise(publisher.settle("eof"))

  expect(terminals(published)).toHaveLength(1)
  expect(JSON.stringify(published.find((event) => event.type === "session.next.step.started.1")?.data)).not.toContain(
    '"catalog"',
  )
  expect(JSON.stringify(published.find((event) => event.type === "session.next.step.started.1")?.data)).not.toContain(
    '"clock"',
  )
  expect(published.find((event) => event.type === "session.next.step.started.1")).toMatchObject({
    data: { timestamp: DateTime.makeUnsafe(1_000) },
  })
  expect(terminals(published)[0]).toMatchObject({
    type: "session.next.step.ended.2",
    data: {
      finish: "stop",
      tokens: { input: 10, output: 7, reasoning: 3, cache: { read: 6, write: 4 } },
      accounting: {
        mode: "aggregate",
        purpose: "assistant",
        time: { duration: 80 },
        usage: {
          source: "step-finish",
          authoritative: { input: 10, output: 7, reasoning: 3, cache: { read: 6, write: 4 } },
        },
        pricing: { source: "catalog", rate },
      },
    },
  })
})

test("uses finish usage only as a proven one-step fallback and records mismatches", async () => {
  const fallback = capture()
  fallback.publisher.startAttempt()
  await Effect.runPromise(fallback.publisher.publish(LLMEvent.stepStart({ index: 4 })))
  await Effect.runPromise(fallback.publisher.publish(LLMEvent.finish({ reason: "stop", usage })))
  await Effect.runPromise(fallback.publisher.settle("eof"))
  expect(terminals(fallback.published)[0]).toMatchObject({
    data: { accounting: { usage: { source: "finish-fallback" } } },
  })

  const mismatch = capture()
  mismatch.publisher.startAttempt()
  await Effect.runPromise(mismatch.publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(mismatch.publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage })))
  await Effect.runPromise(
    mismatch.publisher.publish(
      LLMEvent.finish({ reason: "stop", usage: { ...usage, inputTokens: 21, nonCachedInputTokens: 11 } }),
    ),
  )
  await Effect.runPromise(mismatch.publisher.settle("eof"))
  expect(terminals(mismatch.published)[0]).toMatchObject({
    data: {
      accounting: {
        usage: {
          source: "step-finish",
          authoritative: { input: 10 },
          finalObservation: { input: 11 },
          anomaly: "final-usage-mismatch",
        },
      },
    },
  })
})

test("bills only authoritative provider-error usage and leaves missing-terminal EOF duration-only", async () => {
  const failed = capture()
  failed.publisher.startAttempt()
  await Effect.runPromise(
    failed.publisher.publish(
      LLMEvent.providerError({
        message: "Provider unavailable",
        usage: { ...usage, providerMetadata: { openrouter: { usage: { cost: 0.25 } } } },
      }),
    ),
  )
  expect(
    await Effect.runPromiseExit(failed.publisher.publish(LLMEvent.textStart({ id: "after-provider-error" }))),
  ).toMatchObject({ _tag: "Failure" })
  await Effect.runPromise(failed.publisher.settle("error"))
  expect(terminals(failed.published)[0]).toMatchObject({
    type: "session.next.step.failed.2",
    data: {
      error: { message: "Provider unavailable" },
      accounting: {
        usage: { source: "provider-error", authoritative: { input: 10 } },
        pricing: { source: "provider", amount: 0.25, providerAmount: 0.25 },
      },
    },
  })

  let now = 2_000
  const eof = capture({ clock: () => now })
  eof.publisher.startAttempt()
  now = 2_030
  eof.publisher.completeRawAttempt("eof")
  now = 2_080
  await Effect.runPromise(eof.publisher.settle("eof"))
  expect(terminals(eof.published)[0]).toMatchObject({
    type: "session.next.step.failed.2",
    data: {
      error: { message: "Provider stream ended without a terminal event" },
      accounting: { time: { duration: 30 } },
    },
  })
  expect(JSON.stringify(terminals(eof.published)[0]?.data)).not.toContain('"usage"')

  now = 2_100
  const transport = capture({ clock: () => now })
  transport.publisher.startAttempt()
  now = 2_125
  transport.publisher.failAttempt()
  now = 2_900
  await Effect.runPromise(transport.publisher.settle("error", "Transport unavailable"))
  expect(terminals(transport.published)[0]).toMatchObject({
    type: "session.next.step.failed.2",
    data: {
      accounting: {
        time: {
          started: DateTime.makeUnsafe(2_100),
          completed: DateTime.makeUnsafe(2_125),
          duration: 25,
        },
      },
    },
  })
})

test("closes WebSocket/raw failure and interruption before pre-settlement delay", async () => {
  for (const [outcome, started] of [
    ["error", 3_000],
    ["interrupt", 4_000],
  ] as const) {
    let now = started
    const { published, publisher } = capture({ clock: () => now })
    publisher.startAttempt()
    now = started + 40
    publisher.completeRawAttempt(outcome)
    now = started + 900
    await Effect.runPromise(publisher.failUnsettledTools("Pre-settlement tool cleanup"))
    await Effect.runPromise(publisher.settle(outcome))

    expect(terminals(published)[0]).toMatchObject({
      type: "session.next.step.failed.2",
      data: {
        accounting: {
          time: {
            started: DateTime.makeUnsafe(started),
            completed: DateTime.makeUnsafe(started + 40),
            duration: 40,
          },
        },
      },
    })
  }
})

test("rejects provider errors that conflict with authoritative success", async () => {
  let now = 4_000
  const { published, publisher } = capture({ clock: () => now })
  publisher.startAttempt()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  now = 4_010
  await Effect.runPromise(
    publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } })),
  )
  now = 4_020
  expect(
    await Effect.runPromiseExit(
      publisher.publish(
        LLMEvent.providerError({
          message: "prompt too long",
          classification: "context-overflow",
          usage: { ...usage, providerMetadata: { openrouter: { usage: { cost: 0.25 } } } },
        }),
      ),
    ),
  ).toMatchObject({ _tag: "Failure" })
  now = 4_030
  await Effect.runPromise(publisher.settle("error"))

  expect(terminals(published)).toHaveLength(1)
  expect(terminals(published)[0]).toMatchObject({
    type: "session.next.step.ended.2",
    data: {
      accounting: { time: { duration: 10 }, usage: { source: "step-finish", authoritative: { input: 1 } } },
    },
  })

  const final = capture()
  final.publisher.startAttempt()
  await Effect.runPromise(final.publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(final.publisher.publish(LLMEvent.finish({ reason: "stop", usage })))
  expect(
    await Effect.runPromiseExit(
      final.publisher.publish(
        LLMEvent.providerError({
          message: "Late provider error",
        }),
      ),
    ),
  ).toMatchObject({ _tag: "Failure" })
  await Effect.runPromise(final.publisher.settle("error"))
  expect(terminals(final.published)[0]).toMatchObject({
    type: "session.next.step.ended.2",
    data: { accounting: { usage: { source: "finish-fallback" } } },
  })
})

test("latches step-finish authority across later errors and local tool settlement", async () => {
  let now = 3_000
  const { published, publisher } = capture({ clock: () => now })
  publisher.startAttempt()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(call))
  now = 3_010
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage })))
  now = 3_100
  await Effect.runPromise(publisher.settle("error"))
  await Effect.runPromise(publisher.publish(result))
  await Effect.runPromise(publisher.settle("interrupt"))

  expect(terminals(published)).toHaveLength(1)
  expect(terminals(published)[0]).toMatchObject({
    type: "session.next.step.ended.2",
    data: { finish: "tool-calls", accounting: { time: { duration: 10 }, usage: { source: "step-finish" } } },
  })
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(true)
  expect(
    await Effect.runPromiseExit(publisher.publish(LLMEvent.textStart({ id: "content-after-terminal" }))),
  ).toMatchObject({ _tag: "Failure" })
})
