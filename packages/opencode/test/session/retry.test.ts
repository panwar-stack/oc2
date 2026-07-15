import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import type { NamedError } from "@oc2-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Effect, Exit, Fiber, Layer, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { LLMEvent } from "@oc2-ai/llm"

const providerID = ProviderV2.ID.make("test")
const retryProvider = "test"
const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

function apiError(headers?: Record<string, string>): SessionV1.APIError {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test.each([
    ["empty", {}],
    ["unrelated", { "x-request-id": "request" }],
    ["invalid retry-after", { "retry-after": "invalid" }],
    ["invalid retry-after-ms", { "retry-after-ms": "invalid" }],
  ])("uses capped no-hint delay at attempt seven for %s headers", (_name, headers) => {
    expect(SessionRetry.delay(7, apiError(headers))).toBe(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("evaluates http-date retry-after against the policy clock", () => {
    const error = apiError({ "retry-after": new Date(20_000).toUTCString() })
    expect(SessionRetry.delay(1, error, 0)).toBe(20_000)
  })

  test.each([
    "Sun, 06 Nov 1994 08:49:37 GMT",
    "Sunday, 06-Nov-94 08:49:37 GMT",
    "Sun Nov  6 08:49:37 1994",
  ])("accepts RFC HTTP-date form %s", (value) => {
    const target = Date.UTC(1994, 10, 6, 8, 49, 37)
    expect(SessionRetry.delay(1, apiError({ "retry-after": value }), target - 1_000)).toBe(1_000)
  })

  test("applies RFC850 rolling 50-year interpretation", () => {
    const now = Date.UTC(2026, 0, 1)
    const target = Date.UTC(2075, 10, 6, 8, 49, 37)
    expect(SessionRetry.delay(1, apiError({ "retry-after": "Wednesday, 06-Nov-75 08:49:37 GMT" }), now)).toBe(
      SessionRetry.RETRY_MAX_DELAY,
    )
    expect(target - now).toBeGreaterThan(SessionRetry.RETRY_MAX_DELAY)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores negative and non-finite numeric retry hints", () => {
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": "-1" }))).toBe(2000)
    expect(SessionRetry.delay(1, apiError({ "retry-after-ms": "-Infinity" }))).toBe(2000)
    expect(SessionRetry.delay(1, apiError({ "retry-after": "-1" }))).toBe(2000)
    expect(SessionRetry.delay(1, apiError({ "retry-after": "-Infinity" }))).toBe(2000)
  })

  test.each(["", " 1", "1 ", "+1", "-1", "0x10", "1e2", "1.5", ".5", "9".repeat(400)])(
    "rejects non-RFC delay-seconds value %j",
    (value) => {
      expect(SessionRetry.delay(1, apiError({ "retry-after": value }))).toBe(2000)
    },
  )

  test.each(["2026-01-01", "December 1, 2026", "01/02/2026", "Thu, 32 Jan 2026 00:00:00 GMT"])(
    "rejects non-HTTP Date.parse value %j",
    (value) => {
      expect(SessionRetry.delay(10, apiError({ "retry-after": value }), 0)).toBe(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
    },
  )

  test.each([
    "Mon, 31 Feb 2026 00:00:00 GMT",
    "Monday, 31-Feb-26 00:00:00 GMT",
    "Mon Feb 31 00:00:00 2026",
    "Tue, 06 Nov 1994 08:49:37 GMT",
  ])("rejects semantically invalid HTTP-date value %j", (value) => {
    expect(SessionRetry.delay(10, apiError({ "retry-after": value }), 0)).toBe(
      SessionRetry.RETRY_MAX_DELAY_NO_HEADERS,
    )
  })

  test("uses normal capped fallback for invalid retry hints", () => {
    expect(SessionRetry.delay(10, apiError({ "retry-after-ms": "invalid" }))).toBe(
      SessionRetry.RETRY_MAX_DELAY_NO_HEADERS,
    )
    expect(SessionRetry.delay(10, apiError({ "retry-after": "invalid" }))).toBe(
      SessionRetry.RETRY_MAX_DELAY_NO_HEADERS,
    )
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the retry time budget", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.instance("policy updates retry status and increments attempts", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("session-retry-test")
      const error = apiError({ "retry-after-ms": "0" })
      const status = yield* SessionStatus.Service

      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) =>
            status.set(sessionID, {
              type: "retry",
              attempt: info.attempt,
              message: info.message,
              next: info.next,
            }),
        }),
      )
      yield* step(error)
      yield* step(error)

      expect(yield* status.get(sessionID)).toMatchObject({
        type: "retry",
        attempt: 2,
        message: "boom",
      })
    }),
  )

  it.effect("policy stops after eight total attempts", () =>
    Effect.gen(function* () {
      const retries: number[] = []
      const error = apiError({ "retry-after-ms": "0" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) => Effect.sync(() => retries.push(info.attempt)),
        }),
      )

      const exits = []
      for (let attempt = 1; attempt <= SessionRetry.RETRY_MAX_ATTEMPTS; attempt++) {
        exits.push(yield* Effect.exit(step(error)))
      }

      expect(retries).toEqual([1, 2, 3, 4, 5, 6, 7])
      const last = exits.at(-1)
      expect(last).toBeDefined()
      if (last) expect(Exit.isFailure(last)).toBe(true)
    }),
  )

  it.effect("policy stops before retry delay crosses fifteen minutes", () =>
    Effect.gen(function* () {
      const retries: number[] = []
      const error = apiError({ "retry-after-ms": "600000" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) => Effect.sync(() => retries.push(info.attempt)),
        }),
      )

      const first = yield* step(error).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 minutes")
      expect(Exit.isSuccess(yield* Fiber.join(first))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(step(error)))).toBe(true)
      expect(retries).toEqual([1])
    }),
  )

  it.effect("policy includes initial provider execution in elapsed limit", () =>
    Effect.gen(function* () {
      const retries: number[] = []
      const now = yield* Clock.currentTimeMillis
      const error = apiError({ "retry-after-ms": "120000" })
      const step = yield* Schedule.toStepWithMetadata(
        SessionRetry.policy({
          provider: "test",
          parse: Schema.decodeUnknownSync(SessionV1.APIError.Schema),
          set: (info) => Effect.sync(() => retries.push(info.attempt)),
          startedAt: now - 14 * 60 * 1000,
        }),
      )

      expect(Exit.isFailure(yield* Effect.exit(step(error)))).toBe(true)
      expect(retries).toEqual([])
    }),
  )
})

describe("session.retry.retryable", () => {
  test("honors explicit provider retryability independently of message heuristics", () => {
    const retryable = MessageV2.fromError(
      LLMEvent.providerError({ message: "temporary provider fault", retryable: true }),
      { providerID },
    )
    const permanent = MessageV2.fromError(
      LLMEvent.providerError({ message: "rate limit", retryable: false }),
      { providerID },
    )

    expect(SessionRetry.retryable(retryable, retryProvider)).toEqual({ message: "temporary provider fault" })
    expect(SessionRetry.retryable(permanent, retryProvider)).toBeUndefined()
  })

  test("preserves provider context-overflow classification", () => {
    const error = MessageV2.fromError(
      LLMEvent.providerError({ message: "provider-specific overflow", classification: "context-overflow" }),
      { providerID },
    )

    expect(SessionV1.ContextOverflowError.isInstance(error)).toBe(true)
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries transport timeout errors", () => {
    const request = MessageV2.fromError(new ProviderError.HeaderTimeoutError(10000), { providerID })
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "Provider response headers timed out after 10000ms",
    })
  })

  test("retries websocket stream transport errors", () => {
    const request = MessageV2.fromError(
      new ProviderError.ResponseStreamError("WebSocket closed before response.completed (code 1006: Connection ended)"),
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(request)).toBe(true)
    expect(SessionRetry.retryable(request, retryProvider)).toEqual({
      message: "WebSocket closed before response.completed (code 1006: Connection ended)",
    })
  })

  test("does not retry context overflow errors", () => {
    const error = new SessionV1.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(SessionV1.APIError.isInstance(result)).toBe(true)
      if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderV2.ID.make("openai") })
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderV2.ID.make("openai") },
    )

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})
