import { expect, test } from "bun:test"
import { createRuntimeEventBus } from "../../src/events/event-bus"
import { createTaskScheduler } from "../../src/scheduler/scheduler"
import { checkProviderGate, createConfiguredProvider, type ModelFetch } from "../../src/model/ai-sdk-provider"
import { createFakeModelProvider } from "../../src/model/fake-provider"
import { createModelService } from "../../src/model/model-service"
import {
  ModelProviderError,
  classifyModelError,
  isRetryableClassification,
  type ModelRequest,
} from "../../src/model/provider"
import { collectModelStream } from "../../src/model/stream"

const createRequest = (signal = new AbortController().signal): ModelRequest => ({
  sessionId: "session-1",
  modelId: "test",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  signal,
})

test("fake provider streams deterministic text, reasoning, tool calls, usage, and done", async () => {
  const provider = createFakeModelProvider({
    events: [
      { type: "reasoning-delta", text: "think " },
      { type: "text-delta", text: "hello" },
      { type: "text-delta", text: " world" },
      { type: "tool-call", call: { id: "call-1", name: "read", arguments: { filePath: "README.md" } } },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 1 } },
      { type: "done" },
    ],
  })

  const result = await collectModelStream(
    provider.stream(createRequest(), { providerId: "fake", requestId: "r1", startedAt: new Date() }),
  )

  expect(result.text).toBe("hello world")
  expect(result.reasoning).toBe("think ")
  expect(result.toolCalls).toEqual([{ id: "call-1", name: "read", arguments: { filePath: "README.md" } }])
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4, reasoningTokens: 1 })
  expect(result.done).toBe(true)
})

test("model service emits runtime events while collecting fake stream", async () => {
  const published: string[] = []
  const events = createRuntimeEventBus()
  events.all((event) => published.push(event.type))
  const service = createModelService({
    events,
    providers: [createFakeModelProvider({ events: [{ type: "text-delta", text: "ok" }, { type: "done" }] })],
  })

  const result = await service.collect("fake", createRequest())

  expect(result.text).toBe("ok")
  expect(published).toEqual(["model.started", "model.delta", "model.completed"])
})

test("fake provider observes cancellation before completing stream", async () => {
  const controller = new AbortController()
  const provider = createFakeModelProvider({
    delayMs: 10,
    events: [{ type: "text-delta", text: "first" }, { type: "text-delta", text: "second" }, { type: "done" }],
  })
  const stream = provider.stream(createRequest(controller.signal), {
    providerId: "fake",
    requestId: "r1",
    startedAt: new Date(),
  })
  const iterator = stream[Symbol.asyncIterator]()

  const first = await iterator.next()
  controller.abort("stop")
  expect(first.value).toEqual({ type: "text-delta", text: "first" })
  await expect(iterator.next()).rejects.toMatchObject({ classification: "cancelled", retryable: false })
})

test("model service can collect through the scheduler model queue", async () => {
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1000,
  })
  const service = createModelService({
    scheduler,
    providers: [createFakeModelProvider({ events: [{ type: "text-delta", text: "scheduled" }, { type: "done" }] })],
  })

  const result = await service.collect("fake", createRequest())

  expect(result.text).toBe("scheduled")
  expect(result.done).toBe(true)
})

test("provider gates require API keys or explicit unauthenticated local config", () => {
  expect(checkProviderGate({ type: "openai" }, {})).toMatchObject({
    ok: false,
    missingApiKey: true,
    apiKeyEnv: "OPENAI_API_KEY",
  })
  expect(checkProviderGate({ type: "anthropic" }, { ANTHROPIC_API_KEY: "secret" })).toMatchObject({ ok: true })
  expect(
    checkProviderGate({ type: "openai-compatible", id: "compat", baseURL: "http://localhost:1234" }, {}),
  ).toMatchObject({
    ok: false,
    reason: "Provider requires apiKeyEnv or allowUnauthenticated",
  })
  expect(
    checkProviderGate(
      { type: "local", id: "local", baseURL: "http://localhost:11434", allowUnauthenticated: true },
      {},
    ),
  ).toMatchObject({ ok: true, providerId: "local" })
})

test("configured real provider fails before any real call when API key is missing", async () => {
  let called = false
  const fetchImplementation = createTestFetch(async () => {
    called = true
    throw new Error("should not call fetch")
  })
  const provider = createConfiguredProvider(
    { type: "openai", apiKeyEnv: "OC2_TEST_OPENAI_KEY" },
    {},
    fetchImplementation,
  )

  await expect(provider.listModels()).rejects.toMatchObject({ classification: "auth", retryable: false })
  expect(called).toBe(false)
})

test("configured OpenAI-compatible provider streams through gated HTTP SSE", async () => {
  const fetchImplementation = createTestFetch(async (input, init) => {
    expect(String(input)).toBe("http://localhost:1234/chat/completions")
    expect(init?.method).toBe("POST")
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"hi ","reasoning_content":"why ","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"filePath\\":\\"README.md\\"}"}}]}}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
          ),
        )
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"there"},"finish_reason":"stop"}]}\n\n'),
        )
        controller.close()
      },
    })
    return new Response(stream, { status: 200 })
  })
  const provider = createConfiguredProvider(
    { type: "openai-compatible", id: "local", baseURL: "http://localhost:1234", allowUnauthenticated: true },
    {},
    fetchImplementation,
  )

  const result = await collectModelStream(
    provider.stream(createRequest(), { providerId: "local", requestId: "r1", startedAt: new Date() }),
  )

  expect(result.text).toBe("hi there")
  expect(result.reasoning).toBe("why ")
  expect(result.toolCalls).toEqual([{ id: "call-1", name: "read", arguments: { filePath: "README.md" } }])
  expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 })
  expect(result.done).toBe(true)
})

test("model provider error JSON omits raw cause values", () => {
  const error = new ModelProviderError({
    message: "failed Bearer secret-token sk-123456789",
    classification: "auth",
    cause: { headers: { authorization: "Bearer secret" } },
  })

  expect(error.toJSON()).toEqual({
    name: "ModelProviderError",
    message: "failed Bearer [REDACTED] [REDACTED]",
    classification: "auth",
    retryable: false,
    providerId: undefined,
    status: undefined,
  })
})

test("error classification is retry-safe", () => {
  expect(classifyModelError({ status: 429 })).toBe("rate_limit")
  expect(isRetryableClassification("rate_limit")).toBe(true)
  expect(classifyModelError({ status: 500 })).toBe("provider_unavailable")
  expect(isRetryableClassification("provider_unavailable")).toBe(true)
  expect(isRetryableClassification("unknown")).toBe(false)
  expect(classifyModelError({ status: 401 })).toBe("auth")
  expect(isRetryableClassification("auth")).toBe(false)
  expect(classifyModelError(new Error("schema tool validation failed"))).toBe("schema")
  expect(isRetryableClassification("schema")).toBe(false)
})

test("model service publishes failed event with provider classification details", async () => {
  const failedEvents: Array<{ readonly cause?: unknown; readonly details?: unknown }> = []
  const events = createRuntimeEventBus()
  events.subscribe("model.failed", (event) => failedEvents.push(event.payload.error))
  const cause = { headers: { authorization: "Bearer secret" } }
  const service = createModelService({
    events,
    providers: [
      createFakeModelProvider({
        failWith: new ModelProviderError({
          message: "rate limit Bearer secret-token sk-123456789",
          classification: "rate_limit",
          providerId: "fake",
          cause,
        }),
      }),
    ],
  })

  await expect(service.collect("fake", createRequest())).rejects.toMatchObject({
    classification: "rate_limit",
    retryable: true,
  })
  expect(failedEvents).toEqual([
    expect.objectContaining({
      cause: undefined,
      message: "rate limit Bearer [REDACTED] [REDACTED]",
      details: expect.objectContaining({
        message: "rate limit Bearer [REDACTED] [REDACTED]",
        classification: "rate_limit",
        retryable: true,
      }),
    }),
  ])
})

const createTestFetch = (implementation: (...args: Parameters<ModelFetch>) => Promise<Response>): ModelFetch =>
  Object.assign(implementation, { preconnect() {} }) as ModelFetch
