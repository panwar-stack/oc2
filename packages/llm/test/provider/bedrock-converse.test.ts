import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CacheHint, CanonicalUsage, LLM, Message, ToolCallPart, ToolChoice } from "../../src"
import { LLMClient } from "../../src/route"
import { AmazonBedrock } from "../../src/providers"
import * as BedrockConverse from "../../src/protocols/bedrock-converse"
import { it } from "../lib/effect"
import { fixedResponse, truncatedStream } from "../lib/http"
import {
  eventSummary,
  expectWeatherToolLoop,
  runWeatherToolLoop,
  weatherTool,
  weatherToolLoopRequest,
  weatherToolName,
} from "../recorded-scenarios"
import { recordedTests } from "../recorded-test"

const codec = new EventStreamCodec(toUtf8, fromUtf8)
const utf8Encoder = new TextEncoder()

// Build a single AWS event-stream frame for a Converse stream event. Each
// frame carries `:message-type=event` + `:event-type=<name>` headers and a
// JSON payload body.
const eventFrame = (type: string, payload: object) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: utf8Encoder.encode(JSON.stringify(payload)),
  })

const exceptionFrame = (type: string, payload: object) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "exception" },
      ":exception-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: utf8Encoder.encode(JSON.stringify(payload)),
  })

const errorFrame = (code: string, message: string) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "error" },
      ":error-code": { type: "string", value: code },
      ":error-message": { type: "string", value: message },
    },
    body: new Uint8Array(0),
  })

const concat = (frames: ReadonlyArray<Uint8Array>) => {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

const eventStreamBody = (...payloads: ReadonlyArray<readonly [string, object]>) =>
  concat(payloads.map(([type, payload]) => eventFrame(type, payload)))

// Override the default SSE content-type with the binary event-stream type so
// the cassette layer treats the body as bytes when recording.
const fixedBytes = (bytes: Uint8Array) =>
  fixedResponse(bytes.slice().buffer, { headers: { "content-type": "application/vnd.amazon.eventstream" } })

const model = AmazonBedrock.configure({
  baseURL: "https://bedrock-runtime.test",
  apiKey: "test-bearer",
}).model("anthropic.claude-3-5-sonnet-20240620-v1:0")

const baseRequest = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  // Wire-shape assertions in this file predate the `cache: "auto"` default;
  // pin the policy off so they only exercise the lowering path itself.
  cache: "none",
  generation: { maxTokens: 64, temperature: 0 },
})

describe("Bedrock Converse route", () => {
  it.effect("prepares Converse target with system, inference config, and messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(baseRequest)

      expect(prepared.body).toEqual({
        modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        system: [{ text: "You are concise." }],
        messages: [{ role: "user", content: [{ text: "Say hello." }] }],
        inferenceConfig: { maxTokens: 64, temperature: 0 },
      })
    }),
  )

  it.effect("lowers chronological system updates to wrapped user text in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<BedrockConverse.BedrockConverseBody>(
        LLM.request({
          model,
          messages: [Message.user("Before."), Message.system("Update."), Message.assistant("After.")],
          cache: "none",
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ text: "Before." }, { text: "<system-update>\nUpdate.\n</system-update>" }] },
        { role: "assistant", content: [{ text: "After." }] },
      ])
    }),
  )

  it.effect("prepares tool config with toolSpec and toolChoice", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(baseRequest, {
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            },
          ],
          toolChoice: ToolChoice.make({ type: "required" }),
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "lookup",
                description: "Lookup data",
                inputSchema: {
                  json: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
                },
              },
            },
          ],
          toolChoice: { any: {} },
        },
      })
    }),
  )

  it.effect("lowers assistant tool-call + tool-result message history", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_history",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "tool_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "tool_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ text: "What is the weather?" }] },
          {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "tool_1", name: "lookup", input: { query: "weather" } } }],
          },
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "tool_1",
                  content: [{ json: { forecast: "sunny" } }],
                  status: "success",
                },
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("lowers image content in tool-result messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_image",
          model,
          messages: [
            Message.user("Capture the screen."),
            Message.assistant([ToolCallPart.make({ id: "tool_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "tool_1",
              name: "screenshot",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Screenshot captured." },
                  { type: "media", mediaType: "image/png", data: "AAAA" },
                ],
              },
            }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "user", content: [{ text: "Capture the screen." }] },
          {
            role: "assistant",
            content: [{ toolUse: { toolUseId: "tool_1", name: "screenshot", input: {} } }],
          },
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "tool_1",
                  content: [{ text: "Screenshot captured." }, { image: { format: "png", source: { bytes: "AAAA" } } }],
                  status: "success",
                },
              },
            ],
          },
        ],
      })
    }),
  )

  it.effect("decodes text-delta + messageStop + metadata usage from binary event stream", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "!" } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
        [
          "metadata",
          {
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 12,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
            },
          },
        ],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.text).toBe("Hello!")
      const finishes = response.events.filter((event) => event.type === "finish")
      // Bedrock splits the finish across `messageStop` (carries reason) and
      // `metadata` (carries usage). We consolidate them into a single
      // terminal `finish` event with both.
      expect(finishes).toHaveLength(1)
      expect(finishes[0]).toMatchObject({ type: "finish", reason: "stop" })
      expect(response.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        totalTokens: 12,
        providerTotalTokens: 12,
        providerMetadata: {
          bedrock: {
            inputTokens: 5,
            outputTokens: 2,
            totalTokens: 12,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
          },
        },
        cacheTelemetry: {
          provider: "bedrock",
          model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
          inputTokens: 10,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          cacheMissTokens: null,
          uncachedInputTokens: 5,
          classification: "cache_unsupported",
        },
      })
    }),
  )

  it.effect("keeps incomplete usage absent", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["messageStop", { stopReason: "end_turn" }],
              ["metadata", { usage: { inputTokens: 5, totalTokens: 7 } }],
            ),
          ),
        ),
      )

      expect(response.usage).toBeUndefined()
      expect(response.events.flatMap((event) => ("usage" in event ? [event.usage] : [])).every((usage) => !usage)).toBe(
        true,
      )
    }),
  )

  it.effect("assembles streamed tool call input", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        [
          "contentBlockStart",
          {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tool_1", name: "lookup" } },
          },
        ],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"query"' } } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: ':"weather"}' } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "tool_use" }],
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(baseRequest, {
          tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedBytes(body)))

      expect(response.toolCalls).toEqual([
        { type: "tool-call", id: "tool_1", name: "lookup", input: { query: "weather" } },
      ])
      const events = response.events.filter((event) => event.type === "tool-input-delta")
      expect(events).toEqual([
        { type: "tool-input-delta", id: "tool_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "tool_1", name: "lookup", text: ':"weather"}' },
      ])
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    }),
  )

  it.effect("decodes reasoning deltas", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me think." } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.reasoning).toBe("Let me think.")
    }),
  )

  it.effect("preserves streamed reasoning signatures for continuation lowering", () =>
    Effect.gen(function* () {
      const body = eventStreamBody(
        ["messageStart", { role: "assistant" }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me think." } } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig_1" } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["messageStop", { stopReason: "end_turn" }],
      )
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))
      const reasoning = response.events.find((event) => event.type === "reasoning-end")

      expect(reasoning).toEqual({
        type: "reasoning-end",
        id: "reasoning-0",
        providerMetadata: { bedrock: { signature: "sig_1" } },
      })

      const prepared = yield* LLMClient.prepare<BedrockConverse.BedrockConverseBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Let me think.", providerMetadata: reasoning?.providerMetadata },
            ]),
          ],
          cache: "none",
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: [{ reasoningContent: { reasoningText: { text: "Let me think.", signature: "sig_1" } } }],
        },
      ])
    }),
  )

  it.effect("emits provider-error for throttlingException", () =>
    Effect.gen(function* () {
      const body = concat([
        eventFrame("messageStart", { role: "assistant" }),
        exceptionFrame("throttlingException", { message: "Slow down" }),
      ])
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.events.find((event) => event.type === "provider-error")).toEqual({
        type: "provider-error",
        message: "Slow down",
        retryable: true,
      })
    }),
  )

  it.effect("emits only an error when a failure follows pending success", () =>
    Effect.gen(function* () {
      const body = concat([
        eventFrame("messageStart", { role: "assistant" }),
        eventFrame("messageStop", { stopReason: "end_turn" }),
        eventFrame("metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
        exceptionFrame("throttlingException", { message: "Slow down" }),
      ])
      const response = yield* LLMClient.generate(baseRequest).pipe(Effect.provide(fixedBytes(body)))

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        expect.objectContaining({
          type: "provider-error",
          message: "Slow down",
          retryable: true,
          usage: expect.objectContaining({
            inputTokens: 5,
            outputTokens: 2,
            nonCachedInputTokens: 5,
            totalTokens: 7,
          }),
        }),
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(CanonicalUsage.fromUsage(response.usage!)).toMatchObject({
        input: 5,
        output: 2,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
    }),
  )

  it.effect("decodes a Smithy error frame as exactly one failure terminal", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              errorFrame("InternalFailure", "Connection lost"),
              eventFrame("messageStop", { stopReason: "end_turn" }),
              eventFrame("metadata", { usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 } }),
            ]),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        {
          type: "provider-error",
          message: "InternalFailure: Connection lost",
          retryable: true,
        },
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toBeUndefined()
    }),
  )

  it.effect("preserves pending authoritative usage on a Smithy error frame", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              eventFrame("messageStop", { stopReason: "end_turn" }),
              eventFrame("metadata", {
                usage: {
                  inputTokens: 5,
                  outputTokens: 2,
                  totalTokens: 12,
                  cacheReadInputTokens: 3,
                  cacheWriteInputTokens: 2,
                },
              }),
              errorFrame("ServiceUnavailable", "Try again"),
            ]),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        expect.objectContaining({
          type: "provider-error",
          message: "ServiceUnavailable: Try again",
          retryable: true,
          usage: expect.objectContaining({
            inputTokens: 10,
            outputTokens: 2,
            nonCachedInputTokens: 5,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
            totalTokens: 12,
          }),
        }),
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    }),
  )

  it.effect("emits one provider error for a modeled exception without a message", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(fixedBytes(exceptionFrame("throttlingException", {}))),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        {
          type: "provider-error",
          message: "Bedrock Converse error",
          retryable: true,
        },
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
    }),
  )

  it.effect("fails a truncated binary frame before metadata without emitting pending success", () =>
    Effect.gen(function* () {
      const metadata = eventFrame("metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              eventFrame("messageStop", { stopReason: "end_turn" }),
              metadata.subarray(0, -1),
            ]),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        {
          type: "provider-error",
          message: "Bedrock Converse event stream ended with an incomplete binary frame",
          retryable: true,
        },
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toBeUndefined()
    }),
  )

  it.effect("fails a truncated binary frame after metadata and preserves authoritative usage", () =>
    Effect.gen(function* () {
      const trailing = eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "ignored" } })
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            concat([
              eventFrame("messageStart", { role: "assistant" }),
              eventFrame("messageStop", { stopReason: "end_turn" }),
              eventFrame("metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }),
              trailing.subarray(0, -1),
            ]),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        expect.objectContaining({
          type: "provider-error",
          message: "Bedrock Converse event stream ended with an incomplete binary frame",
          retryable: true,
          usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
        }),
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    }),
  )

  it.effect("emits one usage-free error when the stream ends after partial content", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }],
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        {
          type: "provider-error",
          message: "Bedrock Converse stream ended before messageStop",
          retryable: true,
        },
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toBeUndefined()
    }),
  )

  it.effect("fails metadata-only EOF while preserving authoritative usage", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["metadata", { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        expect.objectContaining({
          type: "provider-error",
          message: "Bedrock Converse stream ended before messageStop",
          usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
        }),
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    }),
  )

  it.effect("emits one usage-free error when the upstream stream fails before terminal usage", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          truncatedStream(
            [
              eventStreamBody(
                ["messageStart", { role: "assistant" }],
                ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "partial" } }],
              ),
            ],
            { headers: { "content-type": "application/vnd.amazon.eventstream" } },
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        {
          type: "provider-error",
          message: "Failed to read amazon-bedrock/bedrock-converse stream",
          retryable: true,
        },
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toBeUndefined()
    }),
  )

  it.effect("preserves pending usage in one error when the upstream stream fails", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          truncatedStream(
            [
              eventStreamBody(
                ["messageStart", { role: "assistant" }],
                ["messageStop", { stopReason: "end_turn" }],
                [
                  "metadata",
                  {
                    usage: {
                      inputTokens: 5,
                      outputTokens: 2,
                      totalTokens: 12,
                      cacheReadInputTokens: 3,
                      cacheWriteInputTokens: 2,
                    },
                  },
                ],
              ),
            ],
            { headers: { "content-type": "application/vnd.amazon.eventstream" } },
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        expect.objectContaining({
          type: "provider-error",
          message: "Failed to read amazon-bedrock/bedrock-converse stream",
          retryable: true,
          usage: expect.objectContaining({
            inputTokens: 10,
            outputTokens: 2,
            nonCachedInputTokens: 5,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
            totalTokens: 12,
          }),
        }),
      ])
      expect(response.events.some((event) => event.type === "step-finish")).toBe(false)
      expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
    }),
  )

  it.effect("ignores content after messageStop and emits one finish", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(
            eventStreamBody(
              ["messageStart", { role: "assistant" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "done" } }],
              ["contentBlockStop", { contentBlockIndex: 0 }],
              ["messageStop", { stopReason: "end_turn" }],
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: " ignored" } }],
              ["metadata", { usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }],
            ),
          ),
        ),
      )

      expect(response.text).toBe("done")
      expect(response.events.filter((event) => event.type === "finish" || event.type === "provider-error")).toEqual([
        expect.objectContaining({ type: "finish", reason: "stop" }),
      ])
    }),
  )

  it.effect("classifies input-too-long validation exceptions", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(baseRequest).pipe(
        Effect.provide(
          fixedBytes(exceptionFrame("validationException", { message: "Input is too long for requested model" })),
        ),
      )

      expect(response.events.find((event) => event.type === "provider-error")).toEqual({
        type: "provider-error",
        message: "Input is too long for requested model",
        classification: "context-overflow",
        retryable: false,
      })
    }),
  )

  it.effect("rejects requests with no auth path", () =>
    Effect.gen(function* () {
      const unsignedModel = AmazonBedrock.configure({
        baseURL: "https://bedrock-runtime.test",
      }).model("anthropic.claude-3-5-sonnet-20240620-v1:0")
      const error = yield* LLMClient.generate(LLM.updateRequest(baseRequest, { model: unsignedModel })).pipe(
        Effect.provide(fixedBytes(eventStreamBody(["messageStop", { stopReason: "end_turn" }]))),
        Effect.flip,
      )

      expect(error.message).toContain("Bedrock Converse requires either route bearer auth or AWS credentials")
    }),
  )

  it.effect("signs requests with SigV4 when AWS credentials are provided (deterministic plumbing check)", () =>
    Effect.gen(function* () {
      const signed = AmazonBedrock.configure({
        baseURL: "https://bedrock-runtime.test",
        credentials: {
          region: "us-east-1",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      }).model("anthropic.claude-3-5-sonnet-20240620-v1:0")
      const prepared = yield* LLMClient.prepare(LLM.updateRequest(baseRequest, { model: signed }))

      expect(prepared.route).toBe("bedrock-converse")
      expect(prepared.model).toBe(signed)
    }),
  )

  it.effect("emits cachePoint markers after system, user-text, and assistant-text with cache hints", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_cache",
          model,
          system: [{ type: "text", text: "System prefix.", cache }],
          messages: [
            Message.user([{ type: "text", text: "User prefix.", cache }]),
            Message.assistant([{ type: "text", text: "Assistant prefix.", cache }]),
          ],
          generation: { maxTokens: 16, temperature: 0 },
        }),
      )

      expect(prepared.body).toMatchObject({
        // System: text block followed by cachePoint marker.
        system: [{ text: "System prefix." }, { cachePoint: { type: "default" } }],
        messages: [
          {
            role: "user",
            content: [{ text: "User prefix." }, { cachePoint: { type: "default" } }],
          },
          {
            role: "assistant",
            content: [{ text: "Assistant prefix." }, { cachePoint: { type: "default" } }],
          },
        ],
      })
    }),
  )

  it.effect("does not emit cachePoint when no cache hint is set", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(baseRequest)
      expect(prepared.body).toMatchObject({
        system: [{ text: "You are concise." }],
        messages: [{ role: "user", content: [{ text: "Say hello." }] }],
      })
    }),
  )

  it.effect("lowers image media into Bedrock image blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_image",
          model,
          messages: [
            Message.user([
              { type: "text", text: "What is in this image?" },
              { type: "media", mediaType: "image/png", data: "AAAA" },
              { type: "media", mediaType: "image/jpeg", data: "BBBB" },
              { type: "media", mediaType: "image/jpg", data: "CCCC" },
              { type: "media", mediaType: "image/webp", data: "DDDD" },
            ]),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { text: "What is in this image?" },
              { image: { format: "png", source: { bytes: "AAAA" } } },
              { image: { format: "jpeg", source: { bytes: "BBBB" } } },
              // image/jpg is a non-standard alias; we map it to jpeg.
              { image: { format: "jpeg", source: { bytes: "CCCC" } } },
              { image: { format: "webp", source: { bytes: "DDDD" } } },
            ],
          },
        ],
      })
    }),
  )

  it.effect("base64-encodes Uint8Array image bytes", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_image_bytes",
          model,
          messages: [Message.user([{ type: "media", mediaType: "image/png", data: new Uint8Array([1, 2, 3, 4, 5]) }])],
        }),
      )

      // Buffer.from([1,2,3,4,5]).toString("base64") === "AQIDBAU="
      expect(prepared.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [{ image: { format: "png", source: { bytes: "AQIDBAU=" } } }],
          },
        ],
      })
    }),
  )

  it.effect("lowers document media into Bedrock document blocks with format and name", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_doc",
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "application/pdf", data: "UERGREFUQQ==", filename: "report.pdf" },
              { type: "media", mediaType: "text/csv", data: "Q1NWREFUQQ==" },
            ]),
          ],
        }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              // Filename round-trips when supplied.
              { document: { format: "pdf", name: "report.pdf", source: { bytes: "UERGREFUQQ==" } } },
              // Falls back to a stable placeholder when filename is missing.
              { document: { format: "csv", name: "document.csv", source: { bytes: "Q1NWREFUQQ==" } } },
            ],
          },
        ],
      })
    }),
  )

  it.effect("rejects unsupported image media types", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_bad_image",
          model,
          messages: [Message.user([{ type: "media", mediaType: "image/svg+xml", data: "x" }])],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("Bedrock Converse does not support image media type image/svg+xml")
    }),
  )

  it.effect("rejects unsupported document media types", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_bad_doc",
          model,
          messages: [Message.user([{ type: "media", mediaType: "application/x-tar", data: "x", filename: "a.tar" }])],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("Bedrock Converse does not support media type application/x-tar")
    }),
  )

  it.effect("maps ttlSeconds >= 3600 to cachePoint ttl: '1h'", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral", ttlSeconds: 3600 })
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          system: [{ type: "text", text: "system", cache }],
          prompt: "hi",
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ text: "system" }, { cachePoint: { type: "default", ttl: "1h" } }],
      })
    }),
  )

  it.effect("appends cachePoint after marked tool definitions and tool-result blocks", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          tools: [{ name: "lookup", description: "lookup", inputSchema: { type: "object", properties: {} }, cache }],
          messages: [
            Message.user("What's the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            Message.tool({ id: "call_1", name: "lookup", result: { temp: 72 }, cache }),
          ],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [{ toolSpec: { name: "lookup" } }, { cachePoint: { type: "default" } }],
        },
        messages: [
          { role: "user", content: [{ text: "What's the weather?" }] },
          { role: "assistant", content: [{ toolUse: { toolUseId: "call_1" } }] },
          {
            role: "user",
            content: [{ toolResult: { toolUseId: "call_1" } }, { cachePoint: { type: "default" } }],
          },
        ],
      })
    }),
  )

  it.effect("drops cachePoint markers past the 4-per-request cap", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model,
          system: [
            { type: "text", text: "a", cache },
            { type: "text", text: "b", cache },
            { type: "text", text: "c", cache },
            { type: "text", text: "d", cache },
            { type: "text", text: "e", cache },
            { type: "text", text: "f", cache },
          ],
          prompt: "hi",
        }),
      )

      const system = (prepared.body as { system: Array<{ cachePoint?: unknown }> }).system
      expect(system.filter((part) => "cachePoint" in part)).toHaveLength(4)
    }),
  )
})

// Live recorded integration tests. Run with `RECORD=true AWS_ACCESS_KEY_ID=...
// AWS_SECRET_ACCESS_KEY=... [AWS_SESSION_TOKEN=...] bun run test ...` to refresh
// cassettes; replay is the default and works without credentials.
//
// Region is pinned to us-east-1 in tests so the request URL is stable across
// machines on replay. If you need to record from a different region (e.g. your
// account has access elsewhere), pass `BEDROCK_RECORDING_REGION=eu-west-1` —
// but then commit the resulting cassette and others should record from the
// same region too.
const RECORDING_REGION = process.env.BEDROCK_RECORDING_REGION ?? "us-east-1"

const recordedModel = () =>
  AmazonBedrock.configure({
    // Most newer Anthropic models on Bedrock require a cross-region inference
    // profile (`us.` prefix). Nova does not require an Anthropic use-case form
    // and is on-demand-throughput accessible by default for most accounts.
    credentials: {
      region: RECORDING_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "fixture",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "fixture",
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
  }).model(process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-micro-v1:0")

const recorded = recordedTests({
  prefix: "bedrock-converse",
  provider: "amazon-bedrock",
  protocol: "bedrock-converse",
  requires: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
})

describe("Bedrock Converse recorded", () => {
  recorded.effect("streams text", () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const response = yield* llm.generate(
        LLM.request({
          id: "recorded_bedrock_text",
          model: recordedModel(),
          system: "Reply with the single word 'Hello'.",
          prompt: "Say hello.",
          cache: "none",
          generation: { maxTokens: 16, temperature: 0 },
        }),
      )

      expect(eventSummary(response.events)).toEqual([
        { type: "text", value: "Hello" },
        { type: "finish", reason: "stop", usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } },
      ])
    }),
  )

  recorded.effect.with("streams a tool call", { tags: ["tool"] }, () =>
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const response = yield* llm.generate(
        LLM.request({
          id: "recorded_bedrock_tool_call",
          model: recordedModel(),
          system: "Call tools exactly as requested.",
          prompt: "Call get_weather with city exactly Paris.",
          tools: [weatherTool],
          toolChoice: ToolChoice.make(weatherTool),
          cache: "none",
          generation: { maxTokens: 80, temperature: 0 },
        }),
      )

      expect(eventSummary(response.events)).toEqual([
        { type: "tool-call", name: weatherToolName, input: { city: "Paris" } },
        { type: "finish", reason: "tool-calls", usage: { inputTokens: 419, outputTokens: 16, totalTokens: 435 } },
      ])
    }),
  )

  recorded.effect.with("drives a tool loop", { tags: ["tool", "tool-loop", "golden"] }, () =>
    Effect.gen(function* () {
      expectWeatherToolLoop(
        yield* runWeatherToolLoop(
          weatherToolLoopRequest({
            id: "recorded_bedrock_tool_loop",
            model: recordedModel(),
          }),
        ),
      )
    }),
  )
})
