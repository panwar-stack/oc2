import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import { ConfigV1 } from "@oc2-ai/core/v1/config/config"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Ref, Stream } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import z from "zod"
import { LLM } from "../../src/session/llm"
import { CanonicalUsage, type LLMEvent as LLMEventType } from "@oc2-ai/llm"
import type { EventV2 } from "@oc2-ai/core/event"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@oc2-ai/llm/route"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@oc2-ai/core/models-dev"
import { Plugin } from "@/plugin"

import { testEffect } from "../lib/effect"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { LLMFugu } from "@/session/llm/fugu"
import { Session as SessionNs } from "@/session/session"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { ModelV2 } from "@oc2-ai/core/model"
import { SessionEvent } from "@oc2-ai/core/session/event"

type ConfigModel = NonNullable<NonNullable<ConfigV1.Info["provider"]>[string]["models"]>[string]

const openAIConfig = (model: ModelsDev.Provider["models"][string], baseURL: string): Partial<ConfigV1.Info> => {
  const { experimental: _experimental, ...configModel } = model
  return {
    enabled_providers: ["openai"],
    provider: {
      openai: {
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          [model.id]: JSON.parse(JSON.stringify(configModel)) as ConfigModel,
        },
        options: {
          apiKey: "test-openai-key",
          baseURL,
        },
      },
    },
  }
}

const it = testEffect(Layer.mergeAll(LLM.defaultLayer, Provider.defaultLayer, EventV2Bridge.defaultLayer))

// LLM.stream returns a Stream, not an Effect, so we can't use the serviceUse proxy.
const drain = (input: LLM.StreamInput) => LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain))
const collect = (input: LLM.StreamInput) =>
  LLM.Service.use((svc) =>
    svc.stream(input).pipe(
      Stream.runCollect,
      Effect.map((events) => Array.from(events)),
    ),
  )

// drainWith builds an isolated runtime so the custom layer fully owns LLM and
// its transitive deps — `Effect.provide(layer)` over an existing runtime layers
// the new services on top, but transitive Service overrides (e.g. RequestExecutor)
// resolved through the outer LLM.defaultLayer leak through.
const drainWith = (layer: Layer.Layer<LLM.Service>, input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runDrain)).pipe(
          Effect.provide(layer),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

describe("session.llm.telemetry", () => {
  test("includes system prompt in Langfuse-compatible input and metadata", () => {
    const attrs = LLM.langfuseTelemetryAttributes({
      sessionID: "ses_telemetry",
      userID: "tester",
      system: ["system guidance"],
      messages: [{ role: "user", content: "hello" }],
    })

    const messages = [
      { role: "system", content: "system guidance" },
      { role: "user", content: "hello" },
    ]

    expect(JSON.parse(attrs["langfuse.observation.input"])).toEqual({ messages })
    expect(JSON.parse(attrs["langfuse.trace.input"])).toEqual({ messages })
    expect(JSON.parse(attrs["gen_ai.input.messages"])).toEqual(messages)
    expect(attrs["langfuse.observation.metadata.system_prompt"]).toBe("system guidance")
    expect(attrs["langfuse.trace.metadata.system_prompt"]).toBe("system guidance")
  })

  test("does not duplicate prepared system messages", () => {
    const attrs = LLM.langfuseTelemetryAttributes({
      sessionID: "ses_telemetry",
      userID: "tester",
      system: ["system guidance"],
      messages: [
        { role: "system", content: "system guidance" },
        { role: "user", content: "hello" },
      ],
    })

    expect(JSON.parse(attrs["gen_ai.input.messages"])).toEqual([
      { role: "system", content: "system guidance" },
      { role: "user", content: "hello" },
    ])
  })
})

function llmLayerWithExecutor(executor: Layer.Layer<RequestExecutor.Service>, flags: Partial<RuntimeFlags.Info> = {}) {
  return LLM.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(executor, WebSocketExecutor.layer)))),
    Layer.provide(RuntimeFlags.layer(flags)),
  )
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

describe("session.llm.ai-sdk adapter", () => {
  type AISDKAdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]

  const adapt = (events: ReadonlyArray<AISDKAdapterEvent>, identity?: LLMAISDK.UsageIdentity) => {
    const state = LLMAISDK.adapterState(identity)
    return Effect.runPromise(
      Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
    )
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests defensive adapter branches outside AI SDK's current typed surface
  const uncheckedAdapterEvent = (input: unknown) => input as AISDKAdapterEvent

  test("maps AI SDK stream chunks without losing session-visible fields", async () => {
    const metadata = { openai: { itemID: "item-1" } }
    const events = await adapt([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", toolName: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", delta: '{"query":' },
      { type: "tool-input-delta", id: "call-1", delta: '"weather"}' },
      { type: "tool-input-end", id: "call-1", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { query: "weather" },
        output: { title: "Lookup", output: "sunny", metadata: { ok: true } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "other",
        rawFinishReason: "other",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 1 },
        },
        providerMetadata: { openai: { step: true } },
      },
      {
        type: "finish",
        finishReason: "other",
        rawFinishReason: "other",
        totalUsage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          cachedInputTokens: 4,
          reasoningTokens: 2,
          inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 4, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 2 },
        },
      },
    ])

    expect(events).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text-delta", id: "text-1", text: "Hel", providerMetadata: { openai: { delta: 1 } } },
      { type: "text-delta", id: "text-1", text: "lo", providerMetadata: { openai: { delta: 2 } } },
      { type: "text-end", id: "text-1", providerMetadata: { openai: { done: true } } },
      { type: "reasoning-start", id: "reasoning-1", providerMetadata: metadata },
      { type: "reasoning-delta", id: "reasoning-1", text: "Think", providerMetadata: { openai: { delta: 3 } } },
      { type: "reasoning-end", id: "reasoning-1", providerMetadata: { openai: { done: true } } },
      { type: "tool-input-start", id: "call-1", name: "lookup", providerMetadata: metadata },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '{"query":' },
      { type: "tool-input-delta", id: "call-1", name: "lookup", text: '"weather"}' },
      { type: "tool-input-end", id: "call-1", name: "lookup", providerMetadata: { openai: { inputDone: true } } },
      {
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        input: { query: "weather" },
        providerExecuted: true,
        providerMetadata: { openai: { called: true } },
      },
      {
        type: "tool-result",
        id: "call-1",
        name: "lookup",
        result: { type: "json", value: { title: "Lookup", output: "sunny", metadata: { ok: true } } },
        providerExecuted: true,
        providerMetadata: { openai: { result: true } },
      },
      {
        type: "step-finish",
        index: 0,
        reason: "unknown",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningTokens: 1,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
        },
        providerMetadata: undefined,
      },
      {
        type: "finish",
        reason: "unknown",
        usage: {
          inputTokens: 11,
          outputTokens: 6,
          totalTokens: 17,
          reasoningTokens: 2,
          cacheReadInputTokens: 4,
        },
      },
    ])
  })

  test("creates stable block ids when AI SDK omits them", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({ type: "text-delta", text: "implicit text" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "implicit reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(events).toMatchObject([
      { type: "text-delta", id: "text-0", text: "implicit text" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "implicit reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  test("explicitly ignores non-session-visible AI SDK chunks", async () => {
    expect(
      await adapt([
        uncheckedAdapterEvent({ type: "abort" }),
        uncheckedAdapterEvent({ type: "source" }),
        uncheckedAdapterEvent({ type: "file" }),
        uncheckedAdapterEvent({ type: "raw" }),
        uncheckedAdapterEvent({ type: "tool-output-denied" }),
        uncheckedAdapterEvent({ type: "tool-approval-request" }),
      ]),
    ).toEqual([])
  })

  test("preserves tool-error cause", async () => {
    const error = new PermissionV1.RejectedError()
    const events = await Effect.runPromise(
      LLMAISDK.toLLMEvents(LLMAISDK.adapterState(), {
        type: "tool-error",
        toolCallId: "call_123",
        toolName: "bash",
        input: {},
        error,
      }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "tool-error",
      id: "call_123",
      name: "bash",
      message: error.message,
      error,
    })
  })

  test("emits undefined usage when AI SDK category fields are missing", async () => {
    // A provider total without disjoint categories cannot establish billable usage.
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "response-1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: 3,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
      {
        type: "finish-step",
        response: { id: "response-2", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: 3,
          outputTokens: undefined,
          totalTokens: 3,
          reasoningTokens: 1,
          cachedInputTokens: undefined,
          inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: 1 },
        },
      },
    ])

    expect(events).toHaveLength(2)
    expect(events.every((event) => event.type === "step-finish" && event.usage === undefined)).toBe(true)
  })

  test("reuses adapter state cleanly across streams once finish has fired", async () => {
    // adapterState() is meant to be per-stream, but the only thing finish currently clears
    // is toolNames — step, text counters, and the current text/reasoning IDs all leak
    // forward. A caller that reuses a state across two streams sees text-1/reasoning-1/
    // step index 1 on the second stream's first events. The test pins the intended
    // contract: after finish, the same state can be reused and starts fresh.
    const state = LLMAISDK.adapterState()
    const run = (events: ReadonlyArray<AISDKAdapterEvent>) =>
      Effect.runPromise(
        Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
      )

    await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "first" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "first reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
      {
        type: "finish-step",
        response: { id: "r1", timestamp: new Date(0), modelId: "gpt-test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        providerMetadata: undefined,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ])

    const secondStream = await run([
      { type: "start-step", request: {}, warnings: [] },
      uncheckedAdapterEvent({ type: "text-delta", text: "second" }),
      uncheckedAdapterEvent({ type: "text-end" }),
      uncheckedAdapterEvent({ type: "reasoning-delta", text: "second reasoning" }),
      uncheckedAdapterEvent({ type: "reasoning-end" }),
    ])

    expect(secondStream).toMatchObject([
      { type: "step-start", index: 0 },
      { type: "text-delta", id: "text-0", text: "second" },
      { type: "text-end", id: "text-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "second reasoning" },
      { type: "reasoning-end", id: "reasoning-0" },
    ])
  })

  // Anthropic emits cache writes in provider metadata rather than inputTokenDetails.
  test("recovers Anthropic cache writes from step metadata", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-3-5-sonnet" },
        finishReason: "stop",
        rawFinishReason: "stop",
        // Anthropic's AI SDK shape: cacheWriteTokens is NOT in usage, it arrives via providerMetadata.
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } },
      },
    ])

    expect(events).toHaveLength(1)
    const stepFinish = events[0]
    if (stepFinish.type !== "step-finish") throw new Error("expected step-finish")
    expect(stepFinish.providerMetadata).toEqual({ anthropic: { cacheCreationInputTokens: 300 } })
    expect(stepFinish.usage?.nonCachedInputTokens).toBe(500)
    expect(stepFinish.usage?.cacheWriteInputTokens).toBe(300)
    expect(stepFinish.usage?.cacheReadInputTokens).toBe(200)

    // End-to-end compatibility still receives the same inclusive totals and event metadata.
    const result = SessionNs.getUsage({
      model: {
        id: "claude-3-5-sonnet",
        providerID: "anthropic",
        name: "Claude",
        limit: { context: 200_000, output: 8_000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: false,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { npm: "@ai-sdk/anthropic" },
        options: {},
      } as never,
      usage: stepFinish.usage!,
      metadata: stepFinish.providerMetadata,
    })
    expect(result.tokens.cache.write).toBe(300)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("normalizes Anthropic executor iteration caches without billing advisor usage", async () => {
    const iterations = [
      {
        type: "compaction",
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 5,
      },
      {
        type: "message",
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2,
      },
      {
        type: "compaction",
        input_tokens: 2,
        output_tokens: 1,
        cache_read_input_tokens: null,
      },
      {
        type: "advisor_message",
        model: "claude-haiku-4-5",
        input_tokens: 100,
        output_tokens: 100,
        cache_read_input_tokens: 9,
        cache_creation_input_tokens: 10,
        prompt: "must not survive",
      },
    ]
    const usage = {
      inputTokens: 17,
      outputTokens: 6,
      totalTokens: 23,
      inputTokenDetails: { noCacheTokens: 14, cacheReadTokens: 1, cacheWriteTokens: 2 },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    }
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "iteration-step", timestamp: new Date(0), modelId: "claude-sonnet-4-6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage,
        providerMetadata: {
          anthropic: {
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              cache_read_input_tokens: 1,
              cache_creation_input_tokens: 2,
              iterations,
              prompt: "must not survive",
            },
            iterations: ["must not survive"],
          },
        },
      },
      { type: "finish", finishReason: "stop", rawFinishReason: "end_turn", totalUsage: usage },
    ])

    const canonical = events.map((event) =>
      "usage" in event && event.usage ? CanonicalUsage.fromUsage(event.usage) : undefined,
    )
    expect(canonical[0]).toMatchObject({
      input: 14,
      output: 6,
      reasoning: 0,
      cache: { read: 5, write: 7 },
    })
    expect(canonical[1]).toEqual({ input: 14, output: 6, reasoning: 0, cache: { read: 5, write: 7 } })
    expect(canonical[0]?.providerMetadata).toEqual({
      anthropic: {
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2,
          iterations: [
            iterations[0],
            iterations[1],
            iterations[2],
            {
              type: "advisor_message",
              model: "claude-haiku-4-5",
              input_tokens: 100,
              output_tokens: 100,
              cache_read_input_tokens: 9,
              cache_creation_input_tokens: 10,
            },
          ],
        },
      },
    })
  })

  test("applies AI SDK usage precedence and whitelists reconciliation metadata", async () => {
    const metadata = {
      anthropic: {
        cacheCreationInputTokens: 30,
        prompt: "secret prompt",
        responseBody: { secret: true },
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          prompt: "secret prompt",
          authorization: ["Bearer secret"],
        },
      },
      bedrock: { usage: ["Bearer secret"] },
      google: { usageMetadata: { promptTokenCount: 100, totalTokenCount: 120, prompt: "secret prompt" } },
      openrouter: {
        authorization: "secret",
        usage: {
          inputTokens: 100,
          cost: 0.25,
          prompt: "secret prompt",
          headers: { authorization: "secret" },
          costDetails: ["secret billing payload"],
        },
      },
      custom: { billing: ["secret"], usage: { inputTokens: 100, cost: 0.25 } },
    }
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "metadata-write", timestamp: new Date(0), modelId: "test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 20, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: 16 },
        },
        providerMetadata: metadata,
      },
      {
        type: "finish-step",
        response: { id: "detail-write", timestamp: new Date(0), modelId: "test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 20, cacheWriteTokens: 30 },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: 16 },
        },
        providerMetadata: metadata,
      },
    ])

    const finishes = events.filter((event) => event.type === "step-finish")
    expect(finishes).toHaveLength(2)
    expect(CanonicalUsage.fromUsage(finishes[0]!.usage!)).toEqual({
      input: 50,
      output: 4,
      reasoning: 16,
      cache: { read: 20, write: 30 },
      providerTotal: 120,
      providerMetadata: {
        anthropic: {
          cacheCreationInputTokens: 30,
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        google: { usageMetadata: { promptTokenCount: 100, totalTokenCount: 120 } },
        openrouter: { usage: { inputTokens: 100, cost: 0.25 } },
      },
    })
    expect(CanonicalUsage.fromUsage(finishes[1]!.usage!)).toMatchObject({
      input: 90,
      output: 4,
      reasoning: 16,
      cache: { read: 20, write: 30 },
    })
    expect(finishes[0]?.providerMetadata).toEqual(finishes[0]?.usage?.providerMetadata)
    expect(finishes[1]?.providerMetadata).toEqual(finishes[1]?.usage?.providerMetadata)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("secret prompt")
    expect(serialized).not.toContain("Bearer secret")
    expect(serialized).not.toContain("secret billing payload")
    expect(serialized).not.toContain('"authorization"')
  })

  test("corrects the installed xAI Responses usage conversion from raw usage", async () => {
    const raw = {
      input_tokens: 32,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 110 },
      total_tokens: 151,
      prompt: "must not survive",
    }
    const sdkUsage = {
      inputTokens: 32,
      outputTokens: 9,
      totalTokens: 41,
      inputTokenDetails: { noCacheTokens: 24, cacheReadTokens: 8, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: -101, reasoningTokens: 110 },
      raw,
    }
    const events = await adapt(
      [
        {
          type: "finish-step",
          response: { id: "xai-response", timestamp: new Date(0), modelId: "grok-4" },
          finishReason: "stop",
          rawFinishReason: "completed",
          usage: sdkUsage,
          providerMetadata: { xai: { prompt: "must not survive" } },
        },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "completed",
          totalUsage: { ...sdkUsage, raw: undefined },
        },
      ],
      { providerID: "xai", modelID: "grok-4", apiPackage: "@ai-sdk/xai" },
    )

    expect(events.map((event) => ("usage" in event ? CanonicalUsage.fromUsage(event.usage) : undefined))).toEqual([
      {
        input: 24,
        output: 9,
        reasoning: 110,
        cache: { read: 8, write: 0 },
        providerTotal: 151,
        providerMetadata: {
          xai: {
            input_tokens: 32,
            input_tokens_details: { cached_tokens: 8 },
            output_tokens: 9,
            output_tokens_details: { reasoning_tokens: 110 },
            total_tokens: 151,
          },
        },
      },
      { input: 24, output: 9, reasoning: 110, cache: { read: 8, write: 0 }, providerTotal: 151 },
    ])
  })

  test("recovers DeepSeek prompt cache hits from raw usage", async () => {
    const raw = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 60,
      authorization: "must not survive",
    }
    const sdkUsage = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 20, reasoningTokens: undefined },
      raw,
    }
    const events = await adapt(
      [
        {
          type: "finish-step",
          response: { id: "deepseek-response", timestamp: new Date(0), modelId: "deepseek-chat" },
          finishReason: "stop",
          rawFinishReason: "stop",
          usage: sdkUsage,
          providerMetadata: { deepseek: {} },
        },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { ...sdkUsage, raw: undefined },
        },
      ],
      { providerID: "deepseek", modelID: "deepseek-chat", apiPackage: "@ai-sdk/openai-compatible" },
    )

    const canonical = events.map((event) => ("usage" in event ? CanonicalUsage.fromUsage(event.usage) : undefined))
    expect(canonical).toMatchObject([
      { input: 60, output: 20, reasoning: 0, cache: { read: 40, write: 0 }, providerTotal: 120 },
      { input: 60, output: 20, reasoning: 0, cache: { read: 40, write: 0 }, providerTotal: 120 },
    ])
    expect(canonical[0]?.providerMetadata).toEqual({
      deepseek: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 60,
      },
    })
  })

  test("keeps the first terminal raw usage but fills usage after a usage-less finish", async () => {
    const identity = {
      providerID: "deepseek",
      modelID: "deepseek-chat",
      apiPackage: "@ai-sdk/openai-compatible",
    }
    const raw = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 40,
      prompt_cache_miss_tokens: 60,
    }
    const sdkUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 0, reasoningTokens: undefined },
    }

    for (const rawEvents of [
      [
        { type: "response.completed", response: { usage: raw } },
        {
          choices: [],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 0,
          },
        },
      ],
      [
        { type: "response.completed", response: {} },
        { choices: [], usage: raw },
      ],
    ]) {
      const events = await adapt(
        [
          ...rawEvents.map((rawValue) => uncheckedAdapterEvent({ type: "raw", rawValue })),
          {
            type: "finish-step",
            response: { id: "deepseek-terminal", timestamp: new Date(0), modelId: identity.modelID },
            finishReason: "stop",
            rawFinishReason: "stop",
            usage: sdkUsage,
            providerMetadata: undefined,
          },
          { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: sdkUsage },
        ],
        identity,
      )

      expect(
        events.map((event) => ("usage" in event ? CanonicalUsage.fromUsage(event.usage) : undefined)),
      ).toMatchObject([
        { input: 60, output: 20, reasoning: 0, cache: { read: 40, write: 0 }, providerTotal: 120 },
        { input: 60, output: 20, reasoning: 0, cache: { read: 40, write: 0 }, providerTotal: 120 },
      ])
    }
  })

  test("distinguishes unknown and incomplete raw usage at every provider profile boundary", async () => {
    const identities: LLMAISDK.UsageIdentity[] = [
      { providerID: "xai", modelID: "grok-4", apiPackage: "@ai-sdk/xai" },
      { providerID: "deepinfra", modelID: "google/gemini-2.5-pro", apiPackage: "@ai-sdk/deepinfra" },
      { providerID: "deepinfra", modelID: "deepseek-ai/DeepSeek-R1", apiPackage: "@ai-sdk/deepinfra" },
      { providerID: "deepseek", modelID: "deepseek-chat", apiPackage: "@ai-sdk/openai-compatible" },
      {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
        apiPackage: "@openrouter/ai-sdk-provider",
      },
    ]
    const sdkUsage = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 20, reasoningTokens: undefined },
    }

    for (const identity of identities) {
      const unknown = await adapt(
        [
          {
            type: "finish-step",
            response: { id: "unknown", timestamp: new Date(0), modelId: identity.modelID },
            finishReason: "stop",
            rawFinishReason: "stop",
            usage: sdkUsage,
            providerMetadata: undefined,
          },
          { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: sdkUsage },
        ],
        identity,
      )
      const unknownUsage = unknown.map((event) =>
        "usage" in event && event.usage ? CanonicalUsage.fromUsage(event.usage) : undefined,
      )
      expect(unknownUsage[0]).toBeUndefined()
      expect(unknownUsage[1]).toBeUndefined()

      const incomplete = await adapt(
        [
          {
            type: "finish-step",
            response: { id: "complete", timestamp: new Date(0), modelId: identity.modelID },
            finishReason: "tool-calls",
            rawFinishReason: "tool_calls",
            usage: {
              ...sdkUsage,
              raw: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            },
            providerMetadata: undefined,
          },
          {
            type: "finish-step",
            response: { id: "incomplete", timestamp: new Date(0), modelId: identity.modelID },
            finishReason: "stop",
            rawFinishReason: "stop",
            usage: { ...sdkUsage, outputTokens: 0, totalTokens: 100, raw: { prompt_tokens: 100 } },
            providerMetadata: undefined,
          },
          { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: sdkUsage },
        ],
        identity,
      )
      const incompleteUsage = incomplete.map((event) =>
        "usage" in event && event.usage ? CanonicalUsage.fromUsage(event.usage) : undefined,
      )
      expect(incompleteUsage[0]).toMatchObject({ input: 100, output: 20 })
      expect(incompleteUsage[1]).toBeUndefined()
      expect(incompleteUsage[2]).toBeUndefined()
    }
  })

  test("rejects every malformed raw token observation without SDK fallback", async () => {
    const identity = {
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4",
      apiPackage: "@openrouter/ai-sdk-provider",
    }
    const base = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 20 },
    }
    const mutations: ReadonlyArray<readonly [string, (value: unknown) => Record<string, unknown>]> = [
      ["input", (value) => ({ ...base, prompt_tokens: value })],
      ["output", (value) => ({ ...base, completion_tokens: value })],
      [
        "reasoning",
        (value) => ({ ...base, completion_tokens_details: { reasoning_tokens: value } }),
      ],
      [
        "cache read",
        (value) => ({ ...base, prompt_tokens_details: { ...base.prompt_tokens_details, cached_tokens: value } }),
      ],
      [
        "cache write",
        (value) => ({ ...base, prompt_tokens_details: { ...base.prompt_tokens_details, cache_write_tokens: value } }),
      ],
      ["provider total", (value) => ({ ...base, total_tokens: value })],
    ]

    for (const [field, mutate] of mutations) {
      const malformed = [-1, 1.5, Number.POSITIVE_INFINITY, "10", undefined]
      for (const value of field === "cache write" ? malformed : [...malformed, null]) {
        const events = await adapt(
          [
            uncheckedAdapterEvent({
              type: "finish-step",
              response: { id: `${field}-${String(value)}`, timestamp: new Date(0), modelId: identity.modelID },
              finishReason: "stop",
              rawFinishReason: "stop",
              usage: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10 },
                outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
                raw: mutate(value),
              },
              providerMetadata: undefined,
            }),
            uncheckedAdapterEvent({
              type: "finish",
              finishReason: "stop",
              rawFinishReason: "stop",
              totalUsage: {
                inputTokens: 100,
                outputTokens: 50,
                totalTokens: 150,
                inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10 },
                outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
              },
            }),
          ],
          identity,
        )
        expect(events).toSatisfy(
          (items) =>
            items.length === 2 &&
            items.every((event) =>
              event.type === "step-finish" || event.type === "finish" ? event.usage === undefined : false,
            ),
        )
      }
    }
  })

  test("rejects malformed DeepSeek cache observations and accepts OpenRouter null cache writes", async () => {
    for (const field of ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"] as const) {
      const events = await adapt(
        [
          uncheckedAdapterEvent({
            type: "finish-step",
            response: { id: field, timestamp: new Date(0), modelId: "deepseek-chat" },
            finishReason: "stop",
            rawFinishReason: "stop",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
              inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: undefined },
              outputTokenDetails: { textTokens: 20, reasoningTokens: undefined },
              raw: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                prompt_cache_hit_tokens: 40,
                prompt_cache_miss_tokens: 60,
                [field]: null,
              },
            },
            providerMetadata: undefined,
          }),
        ],
        { providerID: "deepseek", modelID: "deepseek-chat", apiPackage: "@ai-sdk/openai-compatible" },
      )
      expect(events[0]).toMatchObject({ type: "step-finish", usage: undefined })
    }

    const openrouter = await adapt(
      [
        uncheckedAdapterEvent({
          type: "finish-step",
          response: { id: "null-write", timestamp: new Date(0), modelId: "anthropic/claude-sonnet-4" },
          finishReason: "stop",
          rawFinishReason: "stop",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 30, cacheWriteTokens: undefined },
            outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
            raw: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
              prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: null },
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          },
          providerMetadata: undefined,
        }),
      ],
      {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
        apiPackage: "@openrouter/ai-sdk-provider",
      },
    )
    expect(CanonicalUsage.fromUsage(openrouter[0]?.type === "step-finish" ? openrouter[0].usage : undefined)).toMatchObject(
      { input: 70, output: 30, reasoning: 20, cache: { read: 30, write: 0 }, providerTotal: 150 },
    )
  })

  test("requires explicit provider totals on every complete profiled step and resets between turns", async () => {
    const identity = {
      providerID: "deepseek",
      modelID: "deepseek-chat",
      apiPackage: "@ai-sdk/openai-compatible",
    }
    const step = (id: string, providerTotal?: number) =>
      uncheckedAdapterEvent({
        type: "finish-step",
        response: { id, timestamp: new Date(0), modelId: identity.modelID },
        finishReason: "tool-calls",
        rawFinishReason: "tool_calls",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 20, reasoningTokens: undefined },
          raw: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 40,
            ...(providerTotal === undefined ? {} : { total_tokens: providerTotal }),
          },
        },
        providerMetadata: undefined,
      })
    const finish = uncheckedAdapterEvent({
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
        inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 0, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: 40, reasoningTokens: undefined },
      },
    })

    const allTotals = await adapt([step("all-1", 120), step("all-2", 120), finish], identity)
    const allTotalUsage = allTotals.flatMap((event) =>
      event.type === "finish" && event.usage ? [CanonicalUsage.fromUsage(event.usage)] : [],
    )
    expect(allTotalUsage[0]).toEqual({
      input: 120,
      output: 40,
      reasoning: 0,
      cache: { read: 80, write: 0 },
      providerTotal: 240,
    })

    const state = LLMAISDK.adapterState(identity)
    const run = (events: ReadonlyArray<AISDKAdapterEvent>) =>
      Effect.runPromise(
        Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
      )
    const missingTotal = await run([step("missing-1", 120), step("missing-2"), finish])
    const missingTotalUsage = missingTotal.flatMap((event) =>
      event.type === "finish" && event.usage ? [CanonicalUsage.fromUsage(event.usage)] : [],
    )
    expect(missingTotalUsage[0]).toEqual({
      input: 120,
      output: 40,
      reasoning: 0,
      cache: { read: 80, write: 0 },
    })

    const reset = await run([step("reset", 120), finish])
    const resetUsage = reset.flatMap((event) =>
      event.type === "finish" && event.usage ? [CanonicalUsage.fromUsage(event.usage)] : [],
    )
    expect(resetUsage[0]).toEqual({
      input: 60,
      output: 20,
      reasoning: 0,
      cache: { read: 40, write: 0 },
      providerTotal: 120,
    })
  })

  test("recomputes OpenRouter fresh input when the SDK exposes cache writes", async () => {
    const raw = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost: 0.01234,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 20 },
      cost_details: {
        upstream_inference_cost: 0.01234,
        upstream_inference_prompt_cost: 0.004,
        upstream_inference_completions_cost: 0.00834,
      },
      prompt: "must not survive",
    }
    const sdkUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 30, cacheWriteTokens: 10 },
      outputTokenDetails: { textTokens: 30, reasoningTokens: 20 },
      raw,
    }
    const events = await adapt(
      [
        {
          type: "finish-step",
          response: { id: "openrouter-response", timestamp: new Date(0), modelId: "anthropic/claude-sonnet-4" },
          finishReason: "stop",
          rawFinishReason: "stop",
          usage: sdkUsage,
          providerMetadata: { openrouter: { prompt: "must not survive" } },
        },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { ...sdkUsage, raw: undefined },
        },
      ],
      {
        providerID: "openrouter",
        modelID: "anthropic/claude-sonnet-4",
        apiPackage: "@openrouter/ai-sdk-provider",
      },
    )

    const canonical = events.map((event) => ("usage" in event ? CanonicalUsage.fromUsage(event.usage) : undefined))
    expect(canonical).toMatchObject([
      { input: 60, output: 30, reasoning: 20, cache: { read: 30, write: 10 }, providerTotal: 150 },
      { input: 60, output: 30, reasoning: 20, cache: { read: 30, write: 10 }, providerTotal: 150 },
    ])
    const { prompt, ...safeRaw } = raw
    expect(prompt).toBe("must not survive")
    expect(canonical[0]?.providerMetadata).toEqual({ openrouter: { usage: safeRaw } })
    expect(canonical[1]?.providerMetadata).toBeUndefined()
    expect(events[0]).toMatchObject({ type: "step-finish", providerMetadata: canonical[0]?.providerMetadata })
    expect(events[1]).toMatchObject({ type: "finish", providerMetadata: undefined })
    expect(JSON.stringify(events)).not.toContain("must not survive")
  })

  test("retains metadata-only cache writes in one-step cumulative finish usage", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "metadata-write", timestamp: new Date(0), modelId: "test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 4,
          totalTokens: 104,
          inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 30 } },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 4,
          totalTokens: 104,
          inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
        },
      },
    ])

    expect(events).toHaveLength(2)
    const finish = events[1]
    if (finish.type !== "finish") throw new Error("expected finish")
    expect(CanonicalUsage.fromUsage(finish.usage!)).toEqual({
      input: 50,
      output: 4,
      reasoning: 0,
      cache: { read: 20, write: 30 },
    })
  })

  test("sums metadata-only cache writes across cumulative finish usage", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "metadata-write-1", timestamp: new Date(0), modelId: "test" },
        finishReason: "tool-calls",
        rawFinishReason: "tool_use",
        usage: {
          inputTokens: 100,
          outputTokens: 4,
          totalTokens: 104,
          inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 30 } },
      },
      {
        type: "finish-step",
        response: { id: "metadata-write-2", timestamp: new Date(0), modelId: "test" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 200,
          outputTokens: 8,
          totalTokens: 208,
          inputTokenDetails: { noCacheTokens: 150, cacheReadTokens: 50, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 8, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 40 } },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "end_turn",
        totalUsage: {
          inputTokens: 300,
          outputTokens: 12,
          totalTokens: 312,
          inputTokenDetails: { noCacheTokens: 230, cacheReadTokens: 70, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 12, reasoningTokens: undefined },
        },
      },
    ])

    const finish = events[2]
    if (finish.type !== "finish") throw new Error("expected finish")
    expect(CanonicalUsage.fromUsage(finish.usage!)).toEqual({
      input: 160,
      output: 12,
      reasoning: 0,
      cache: { read: 70, write: 70 },
    })
  })

  test("prefers standard cumulative cache writes over recovered step metadata", async () => {
    const events = await adapt([
      {
        type: "finish-step",
        response: { id: "metadata-write", timestamp: new Date(0), modelId: "test" },
        finishReason: "stop",
        rawFinishReason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 4,
          totalTokens: 104,
          inputTokenDetails: { noCacheTokens: 80, cacheReadTokens: 20, cacheWriteTokens: undefined },
          outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 30 } },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 4,
          totalTokens: 104,
          inputTokenDetails: { noCacheTokens: 55, cacheReadTokens: 20, cacheWriteTokens: 25 },
          outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
        },
      },
    ])

    const finish = events[1]
    if (finish.type !== "finish") throw new Error("expected finish")
    expect(CanonicalUsage.fromUsage(finish.usage!)).toMatchObject({
      input: 55,
      cache: { read: 20, write: 25 },
    })
  })

  test("captures Copilot billed usage from raw Anthropic message deltas per step", async () => {
    const events = await adapt([
      uncheckedAdapterEvent({
        type: "raw",
        rawValue: {
          type: "message_delta",
          copilot_usage: { total_nano_aiu: 4_473_525_000 },
        },
      }),
      {
        type: "finish-step",
        response: { id: "msg_test", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 11_774,
          outputTokens: 39,
          totalTokens: 11_813,
          inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 11_771 },
          outputTokenDetails: { textTokens: 39, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: { cacheCreationInputTokens: 11_771 } },
      },
      {
        type: "finish-step",
        response: { id: "msg_follow_up", timestamp: new Date(0), modelId: "claude-sonnet-4.6" },
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
        },
        providerMetadata: { anthropic: {} },
      },
    ])

    expect(events[0]).toMatchObject({
      type: "step-finish",
      providerMetadata: {
        anthropic: { cacheCreationInputTokens: 11_771 },
        copilot: { totalNanoAiu: 4_473_525_000 },
      },
    })
    expect(events[1]).toMatchObject({ type: "step-finish", providerMetadata: undefined })
    if (events[1].type !== "step-finish") throw new Error("expected step-finish")
    expect(events[1].providerMetadata?.copilot).toBeUndefined()
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string | string[]) {
  const chunks = Array.isArray(text) ? text : [text]
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      ...chunks.map(
        (chunk) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            choices: [{ delta: { content: chunk } }],
          })}`,
      ),
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createToolCallStream(input: unknown) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_lookup",
                  type: "function",
                  function: { name: "lookup", arguments: JSON.stringify(input) },
                },
              ],
            },
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function loadFixture(providerID: string, modelID: string) {
  const provider = MODELS_FIXTURE[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

function configModel(model: ModelsDev.Model): ConfigModel {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    release_date: model.release_date,
    attachment: model.attachment,
    reasoning: model.reasoning,
    temperature: model.temperature,
    tool_call: model.tool_call,
    interleaved: model.interleaved,
    cost: model.cost ? { ...model.cost } : undefined,
    limit: model.limit,
    modalities: model.modalities
      ? { input: [...model.modalities.input], output: [...model.modalities.output] }
      : undefined,
    status: model.status,
    provider: model.provider ? { ...model.provider } : undefined,
  }
}

const fuguFixture = { providerID: "vivgrid", modelID: "gemini-3.1-pro-preview" }
const fuguTarget = `${fuguFixture.providerID}/${fuguFixture.modelID}`

function fuguConfig(fugu?: Partial<NonNullable<ConfigV1.Info["fugu"]>>, model?: ConfigModel): Partial<ConfigV1.Info> {
  return {
    enabled_providers: [fuguFixture.providerID],
    provider: {
      [fuguFixture.providerID]: {
        options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
        ...(model ? { models: { [fuguFixture.modelID]: model } } : {}),
      },
    },
    fugu: {
      branches: [
        { model: fuguTarget, variant: "high" },
        { model: fuguTarget, variant: "high" },
      ],
      synthesizer: { model: fuguTarget, variant: "high" },
      ...fugu,
    },
  }
}

function testAgent(): Agent.Info {
  return {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function fuguInput(model: Provider.Model, input?: Partial<LLM.StreamInput>): LLM.StreamInput {
  const sessionID = SessionID.make(input?.sessionID ?? "session-test-fugu")
  const agent = input?.agent ?? testAgent()
  return {
    user: {
      id: MessageID.make("msg_user-fugu"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: ProviderV2.ID.make("fugu"), modelID: ModelV2.ID.make("fugu") },
    } satisfies SessionV1.User,
    sessionID,
    model,
    agent,
    system: ["System root instruction"],
    messages: [{ role: "user", content: "Hello from caller" }],
    tools: {},
    ...input,
  }
}

function toolHistoryMessages(): ModelMessage[] {
  return [
    { role: "user", content: "Use a tool first" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "lookup",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
    { role: "user", content: "Now answer" },
  ]
}

function visibleText(events: LLMEventType[]) {
  return textDeltas(events).join("")
}

function textDeltas(events: LLMEventType[]) {
  return events.filter((event) => event.type === "text-delta").map((event) => event.text)
}

function requestToolNames(body: Record<string, unknown>) {
  return Array.isArray(body.tools)
    ? body.tools.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const value = item as { function?: { name?: unknown } }
        return typeof value.function?.name === "string" ? [value.function.name] : []
      })
    : []
}

function reasoningEffort(body: Record<string, unknown>) {
  return (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
}

function fuguRuntimeModel(): Provider.Model {
  return {
    id: ModelV2.ID.make("fugu"),
    providerID: ProviderV2.ID.make("fugu"),
    name: "Fugu",
    capabilities: {
      toolcall: true,
      attachment: true,
      reasoning: true,
      temperature: true,
      interleaved: true,
      input: { text: true, image: true, audio: true, video: true, pdf: true },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { id: "fugu", url: "", npm: "" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 10_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function expectFuguFailure(message: string) {
  return Effect.gen(function* () {
    const exit = yield* collect(fuguInput(fuguRuntimeModel())).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
    expect(state.queue).toHaveLength(0)
  })
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  const vivgridFixture = { providerID: "vivgrid", modelID: "gemini-3.1-pro-preview" }

  it.instance(
    "runs fugu branches with original context and returns only synthesizer output",
    () =>
      Effect.gen(function* () {
        const branchA = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch a"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const branchB = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch b"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const synth = waitRequest(
          "/chat/completions",
          new Response(createChatStream(["final ", "answer"]), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const events = yield* collect(
          fuguInput(fuguRuntimeModel(), {
            tools: {
              lookup: tool({
                description: "Lookup data",
                inputSchema: z.object({}),
                execute: async () => ({ output: "should not run" }),
              }),
            },
          }),
        )

        const branchACapture = yield* Effect.promise(() => branchA)
        const branchBCapture = yield* Effect.promise(() => branchB)
        const synthCapture = yield* Effect.promise(() => synth)
        const branchMessages = JSON.stringify(branchACapture.body.messages)
        const synthMessages = JSON.stringify(synthCapture.body.messages)

        expect(textDeltas(events)).toEqual(["final ", "answer"])
        expect(visibleText(events)).toBe("final answer")
        expect(visibleText(events)).not.toContain("hidden branch")
        expect(branchMessages).toContain("System root instruction")
        expect(branchMessages).toContain("Hello from caller")
        expect(branchMessages).not.toContain("internal branch model")
        expect(branchMessages).not.toContain("proxy architecture")
        expect(branchMessages).not.toContain("final response synthesizer")
        expect(requestToolNames(branchACapture.body)).toEqual(["lookup"])
        expect(requestToolNames(branchBCapture.body)).toEqual(["lookup"])
        expect(requestToolNames(synthCapture.body)).toEqual(["lookup"])
        expect(reasoningEffort(branchACapture.body)).toBe("high")
        expect(reasoningEffort(branchBCapture.body)).toBe("high")
        expect(reasoningEffort(synthCapture.body)).toBe("high")
        expect(synthMessages).toContain("final answer synthesizer")
        expect(synthMessages).toContain("hidden branch a")
        expect(synthMessages).toContain("hidden branch b")
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "emits live fugu status events without branch output",
    () =>
      Effect.gen(function* () {
        const branchA = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch a"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const branchB = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch b"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const judge = waitRequest(
          "/chat/completions",
          new Response(createChatStream("secret judge guidance"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const synth = waitRequest(
          "/chat/completions",
          new Response(createChatStream(["final ", "answer"]), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const input = fuguInput(fuguRuntimeModel())
        const statuses: EventV2.Data<typeof SessionEvent.Fugu.Status>[] = []
        const eventBridge = yield* EventV2Bridge.Service
        const unsubscribe = yield* eventBridge.subscribeCallback(SessionEvent.Fugu.Status, (event) => {
          statuses.push(event.data)
        })

        const events = yield* collect(input)
        unsubscribe()
        yield* Effect.promise(() => branchA)
        yield* Effect.promise(() => branchB)
        const judgeCapture = yield* Effect.promise(() => judge)
        yield* Effect.promise(() => synth)
        const judgeMessages = JSON.stringify(judgeCapture.body.messages)

        expect(textDeltas(events)).toEqual(["final ", "answer"])
        expect(visibleText(events)).toBe("final answer")
        expect(visibleText(events)).not.toContain("hidden branch")
        expect(visibleText(events)).not.toContain("secret judge")
        expect(judgeMessages).toContain("System root instruction")
        expect(judgeMessages).toContain("Hello from caller")
        expect(judgeMessages).toContain("hidden branch a")
        expect(judgeMessages).toContain("hidden branch b")
        expect(judgeMessages).toContain("Evaluate these private candidate responses")
        expect(judgeMessages).not.toContain("internal evaluator")
        expect(judgeCapture.body.tools).toBeUndefined()

        const serialized = JSON.stringify(statuses)
        expect(serialized).not.toContain("hidden branch")
        expect(serialized).not.toContain("secret judge")
        expect(serialized).not.toContain(fuguTarget)
        expect(serialized).not.toContain(fuguFixture.modelID)
        expect(new Set(statuses.map((status) => status.runID)).size).toBe(1)
        expect(statuses[0]?.runID).toMatch(/^fugu_/)
        expect(statuses.every((status) => status.sessionID === input.sessionID)).toBe(true)

        const frames = statuses.map((status) => ({
          phase: status.phase,
          branches: status.branches.map((branch) => [branch.index, branch.status]),
          judge: status.judge?.status,
          synthesizer: status.synthesizer.status,
        }))
        expect(frames[0]).toEqual({
          phase: "branching",
          branches: [
            [0, "pending"],
            [1, "pending"],
          ],
          judge: "pending",
          synthesizer: "pending",
        })

        const branchStatusIndex = (branchIndex: number, status: string) =>
          frames.findIndex((frame) =>
            frame.branches.some((branch) => branch[0] === branchIndex && branch[1] === status),
          )
        const branch0Working = branchStatusIndex(0, "working")
        const branch0Complete = branchStatusIndex(0, "complete")
        const branch1Working = branchStatusIndex(1, "working")
        const branch1Complete = branchStatusIndex(1, "complete")
        const judgeWorking = frames.findIndex((frame) => frame.judge === "working")
        const judgeComplete = frames.findIndex((frame) => frame.judge === "complete")
        const synthWorking = frames.findIndex((frame) => frame.synthesizer === "working")
        const lastStatus = statuses[statuses.length - 1]

        expect(branch0Working).toBeGreaterThan(-1)
        expect(branch0Complete).toBeGreaterThan(branch0Working)
        expect(branch1Working).toBeGreaterThan(-1)
        expect(branch1Complete).toBeGreaterThan(branch1Working)
        expect(judgeWorking).toBeGreaterThan(Math.max(branch0Complete, branch1Complete))
        expect(judgeComplete).toBeGreaterThan(judgeWorking)
        expect(synthWorking).toBeGreaterThan(judgeComplete)
        expect(lastStatus?.phase).toBe("complete")
        expect(lastStatus?.branches.map((branch) => branch.status)).toEqual(["complete", "complete"])
        expect(lastStatus?.judge?.status).toBe("complete")
        expect(lastStatus?.synthesizer.status).toBe("complete")
      }),
    { config: () => fuguConfig({ judge: { model: fuguTarget, variant: "high" } }) },
  )

  it.instance(
    "adds implicit copilot noop only to fugu synthesizer with prior tool history",
    () =>
      Effect.gen(function* () {
        const branchA = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch a"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const branchB = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch b"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const synth = waitRequest(
          "/chat/completions",
          new Response(createChatStream("final answer"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        yield* collect(fuguInput(fuguRuntimeModel(), { messages: toolHistoryMessages() }))

        expect((yield* Effect.promise(() => branchA)).body.tools).toBeUndefined()
        expect((yield* Effect.promise(() => branchB)).body.tools).toBeUndefined()
        expect(requestToolNames((yield* Effect.promise(() => synth)).body)).toEqual(["_noop"])
      }),
    {
      config: () => {
        const model = loadFixture("github-copilot", "claude-opus-4.6").model
        return {
          enabled_providers: ["github-copilot"],
          provider: {
            "github-copilot": {
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
              models: { [model.id]: configModel(model) },
            },
          },
          fugu: {
            branches: [{ model: `github-copilot/${model.id}` }, { model: `github-copilot/${model.id}` }],
            synthesizer: { model: `github-copilot/${model.id}` },
          },
        } satisfies Partial<ConfigV1.Info>
      },
    },
  )

  it.instance(
    "passes private branch tool-call proposals to the fugu synthesizer without returning them",
    () =>
      Effect.gen(function* () {
        const branchA = waitRequest(
          "/chat/completions",
          new Response(createToolCallStream({ query: "branch-a" }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const branchB = waitRequest(
          "/chat/completions",
          new Response(createChatStream("hidden branch b"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const synth = waitRequest(
          "/chat/completions",
          new Response(createChatStream("final answer"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const events = yield* collect(
          fuguInput(fuguRuntimeModel(), {
            tools: {
              lookup: tool({
                description: "Lookup data",
                inputSchema: z.object({ query: z.string() }),
                execute: async () => ({ output: "should not run" }),
              }),
            },
          }),
        )

        expect(requestToolNames((yield* Effect.promise(() => branchA)).body)).toEqual(["lookup"])
        yield* Effect.promise(() => branchB)
        const synthMessages = JSON.stringify((yield* Effect.promise(() => synth)).body.messages)

        expect(events.filter((event) => event.type === "tool-call")).toHaveLength(0)
        expect(visibleText(events)).toBe("final answer")
        expect(synthMessages).toContain("toolCalls")
        expect(synthMessages).toContain("lookup")
        expect(synthMessages).toContain("branch-a")
        expect(synthMessages).toContain("suggestions only")
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "keeps implicit copilot noop tool for normal requests with prior tool history",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("github-copilot", "claude-opus-4.6").model
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("github-copilot"), ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-copilot-noop")
        const agent = testAgent()

        yield* drain({
          user: {
            id: MessageID.make("msg_user-copilot-noop"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("github-copilot"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: toolHistoryMessages(),
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(requestToolNames(capture.body)).toContain("_noop")
      }),
    {
      config: () => {
        const model = loadFixture("github-copilot", "claude-opus-4.6").model
        return {
          enabled_providers: ["github-copilot"],
          provider: {
            "github-copilot": {
              options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
              models: { [model.id]: configModel(model) },
            },
          },
        } satisfies Partial<ConfigV1.Info>
      },
    },
  )

  it.instance(
    "continues fugu synthesis after one branch fails",
    () =>
      Effect.gen(function* () {
        const branchA = waitRequest(
          "/chat/completions",
          new Response(createChatStream("branch success"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        const branchB = waitRequest("/chat/completions", new Response("branch failed", { status: 500 }))
        const branchBRetry = waitRequest("/chat/completions", new Response("branch failed", { status: 500 }))
        const synth = waitRequest(
          "/chat/completions",
          new Response(createChatStream("partial final"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const events = yield* collect(fuguInput(fuguRuntimeModel()))
        yield* Effect.promise(() => branchA)
        yield* Effect.promise(() => branchB)
        yield* Effect.promise(() => branchBRetry)
        const synthCapture = yield* Effect.promise(() => synth)
        const synthMessages = JSON.stringify(synthCapture.body.messages)

        expect(visibleText(events)).toBe("partial final")
        expect(synthMessages).toContain("branch success")
        expect(synthMessages).toContain("Internal Server Error")
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "fails fugu before provider requests when config is missing",
    () =>
      Effect.gen(function* () {
        const exit = yield* collect(fuguInput(fuguRuntimeModel())).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Fugu configuration is missing")
        expect(state.queue).toHaveLength(0)
      }),
    { config: () => ({}) },
  )

  it.instance(
    "rejects empty fugu branches before provider requests",
    () => expectFuguFailure("at least one fugu.branches"),
    {
      config: () => fuguConfig({ branches: [] }),
    },
  )

  it.instance(
    "rejects missing fugu synthesizer before provider requests",
    () => expectFuguFailure("requires fugu.synthesizer"),
    {
      config: () => fuguConfig({ synthesizer: undefined }),
    },
  )

  it.instance(
    "rejects missing fugu branch target model before provider requests",
    () => expectFuguFailure("target model is required"),
    {
      config: () => fuguConfig({ branches: [{}] }),
    },
  )

  it.instance(
    "rejects missing fugu judge target model before provider requests",
    () => expectFuguFailure("target model is required"),
    {
      config: () => fuguConfig({ judge: {} }),
    },
  )

  it.instance(
    "rejects missing fugu synthesizer target model before provider requests",
    () => expectFuguFailure("target model is required"),
    {
      config: () => fuguConfig({ synthesizer: {} }),
    },
  )

  it.instance(
    "rejects empty fugu branch target model before provider requests",
    () => expectFuguFailure("target model is required"),
    {
      config: () => fuguConfig({ branches: [{ model: "" }] }),
    },
  )

  it.instance(
    "rejects fugu target model without provider component before provider requests",
    () => expectFuguFailure("must use provider/model"),
    {
      config: () => fuguConfig({ branches: [{ model: "/claude" }] }),
    },
  )

  it.instance(
    "rejects fugu target model without model component before provider requests",
    () => expectFuguFailure("must use provider/model"),
    {
      config: () => fuguConfig({ branches: [{ model: "anthropic/" }] }),
    },
  )

  it.instance(
    "rejects fugu target model without provider/model separator before provider requests",
    () => expectFuguFailure("must use provider/model"),
    {
      config: () => fuguConfig({ branches: [{ model: "anthropic" }] }),
    },
  )

  it.instance(
    "rejects unresolved fugu branch targets before provider requests",
    () => expectFuguFailure("could not be resolved"),
    {
      config: () => fuguConfig({ branches: [{ model: "missing/model" }] }),
    },
  )

  it.instance(
    "rejects unresolved fugu synthesizer targets before provider requests",
    () => expectFuguFailure("could not be resolved"),
    {
      config: () => fuguConfig({ synthesizer: { model: "missing/model" } }),
    },
  )

  it.instance(
    "rejects unresolved fugu judge targets before provider requests",
    () => expectFuguFailure("could not be resolved"),
    {
      config: () => fuguConfig({ judge: { model: "missing/model" } }),
    },
  )

  it.instance(
    "rejects invalid fugu target variants before provider requests",
    () => expectFuguFailure("does not support variant"),
    {
      config: () => fuguConfig({ branches: [{ model: fuguTarget, variant: "missing" }] }),
    },
  )

  it.instance(
    "rejects invalid fugu judge variants before provider requests",
    () => expectFuguFailure("does not support variant"),
    {
      config: () => fuguConfig({ judge: { model: fuguTarget, variant: "missing" } }),
    },
  )

  it.instance(
    "rejects invalid fugu synthesizer variants before provider requests",
    () => expectFuguFailure("does not support variant"),
    {
      config: () => fuguConfig({ synthesizer: { model: fuguTarget, variant: "missing" } }),
    },
  )

  it.instance(
    "rejects missing required fugu target variants before provider requests",
    () => expectFuguFailure("requires variant high"),
    {
      config: () =>
        fuguConfig(
          { branches: [{ model: fuguTarget }] },
          { required_variant: "high", variants: { high: { reasoningEffort: "high" } } },
        ),
    },
  )

  it.instance(
    "rejects invalid required fugu target variants before provider requests",
    () => expectFuguFailure("requires unavailable variant"),
    {
      config: () =>
        fuguConfig(
          { branches: [{ model: fuguTarget }] },
          { required_variant: "missing", variants: { high: { reasoningEffort: "high" } } },
        ),
    },
  )

  it.instance(
    "rejects mismatched required fugu target variants before provider requests",
    () => expectFuguFailure("requires variant high"),
    {
      config: () =>
        fuguConfig(
          { branches: [{ model: fuguTarget, variant: "low" }] },
          {
            required_variant: "high",
            variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } },
          },
        ),
    },
  )

  it.instance(
    "rejects circular fugu branch targets before provider requests",
    () => expectFuguFailure("cannot resolve to fugu/fugu"),
    {
      config: () => fuguConfig({ branches: [{ model: "fugu/fugu" }] }),
    },
  )

  it.instance(
    "rejects circular fugu judge targets before provider requests",
    () => expectFuguFailure("cannot resolve to fugu/fugu"),
    {
      config: () => fuguConfig({ branches: [{ model: fuguTarget }], judge: { model: "fugu/fugu" } }),
    },
  )

  it.instance(
    "rejects circular fugu synthesizer targets before provider requests",
    () => expectFuguFailure("cannot resolve to fugu/fugu"),
    {
      config: () => fuguConfig({ branches: [{ model: fuguTarget }], synthesizer: { model: "fugu/fugu" } }),
    },
  )

  it.instance(
    "fails fugu when all branches fail",
    () =>
      Effect.gen(function* () {
        waitRequest("/chat/completions", new Response("branch a failed", { status: 500 }))
        waitRequest("/chat/completions", new Response("branch b failed", { status: 500 }))

        const exit = yield* collect(fuguInput(fuguRuntimeModel())).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const message = Cause.pretty(exit.cause)
          expect(message).toContain("All fugu branches failed")
          expect(message).not.toContain(fuguTarget)
          expect(message).not.toContain("Internal Server Error")
        }
        expect(state.queue).toHaveLength(0)
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "fails fugu when synthesizer fails",
    () =>
      Effect.gen(function* () {
        waitRequest(
          "/chat/completions",
          new Response(createChatStream("branch a"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        waitRequest(
          "/chat/completions",
          new Response(createChatStream("branch b"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )
        waitRequest("/chat/completions", new Response("synth failed", { status: 500 }))

        const exit = yield* collect(fuguInput(fuguRuntimeModel())).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Internal Server Error")
        expect(state.queue).toHaveLength(0)
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "logs fugu synthesizer thrown stream failures with target metadata",
    () =>
      Effect.gen(function* () {
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
        const statuses: LLMFugu.Status[] = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          logs.push(entry)
        })
        const provider = yield* Provider.Service
        let calls = 0
        const exit = yield* LLMFugu.run(
          { ...fuguInput(fuguRuntimeModel()), abort: new AbortController().signal },
          fuguConfig().fugu,
          provider,
          () => {
            calls++
            if (calls <= 2) return Stream.make({ type: "text-delta", id: `branch-${calls}`, text: `branch ${calls}` })
            return Stream.fail(new Error("synthetic stream failure"))
          },
          (status) => Effect.sync(() => statuses.push(status)),
        ).pipe(
          Effect.flatMap((stream) => Stream.runDrain(stream)),
          Effect.provide(Logger.layer([logger])),
          Effect.exit,
        )

        expect(Exit.isFailure(exit)).toBe(true)
        const failure = logs.find((entry) => entry.message === "fugu synthesizer failed")
        expect(failure).toBeDefined()
        expect(failure?.annotations["fugu.synthesizer"]).toBe(`${fuguTarget}@high`)
        expect(failure?.annotations["fugu.error"]).toBe("synthetic stream failure")
        expect(failure?.cause).toBeUndefined()
        expect(JSON.stringify(failure)).not.toContain("branch 1")
        expect(JSON.stringify(failure)).not.toContain("Hello from caller")
        expect(statuses[statuses.length - 1]?.phase).toBe("failed")
        expect(statuses[statuses.length - 1]?.synthesizer.status).toBe("failed")
        expect(JSON.stringify(statuses)).not.toContain("branch 1")
        expect(JSON.stringify(statuses)).not.toContain("Hello from caller")
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "limits fugu branch execution concurrency to four",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const branchCount = 6
        const activeBranches = yield* Ref.make(0)
        const maxActiveBranches = yield* Ref.make(0)
        const startedBranches = yield* Ref.make(0)
        const firstBatchStarted = yield* Deferred.make<void>()
        const releaseBranches = yield* Deferred.make<void>()

        const fiber = yield* LLMFugu.run(
          { ...fuguInput(fuguRuntimeModel()), abort: new AbortController().signal },
          fuguConfig({
            branches: Array.from({ length: branchCount }, () => ({ model: fuguTarget, variant: "high" })),
          }).fugu,
          provider,
          (request) => {
            if (!request.forbidImplicitTools) {
              return Stream.make({ type: "text-delta", id: "synth", text: "final" })
            }
            return Stream.fromEffect(
              Effect.gen(function* () {
                const index = yield* Ref.modify(startedBranches, (count) => [count, count + 1] as const)
                const active = yield* Ref.updateAndGet(activeBranches, (count) => count + 1)
                yield* Ref.update(maxActiveBranches, (max) => Math.max(max, active))
                if (index === 3) yield* Deferred.succeed(firstBatchStarted, undefined)
                yield* Deferred.await(releaseBranches)
                yield* Ref.update(activeBranches, (count) => count - 1)
                return { type: "text-delta", id: `branch-${index}`, text: `branch ${index}` } satisfies LLMEventType
              }),
            )
          },
        ).pipe(
          Effect.flatMap((stream) => Stream.runCollect(stream)),
          Effect.forkScoped,
        )

        yield* Deferred.await(firstBatchStarted).pipe(Effect.timeout("1 second"))
        expect(yield* Ref.get(startedBranches)).toBe(4)
        expect(yield* Ref.get(activeBranches)).toBe(4)

        yield* Deferred.succeed(releaseBranches, undefined)
        const events = Array.from(yield* Fiber.join(fiber))

        expect(visibleText(events)).toBe("final")
        expect(yield* Ref.get(startedBranches)).toBe(branchCount)
        expect(yield* Ref.get(maxActiveBranches)).toBe(4)
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "preserves fugu branch success and failure aggregation",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const branchCount = 5
        const branchCalls = yield* Ref.make(0)
        const synthesizerMessages = yield* Ref.make("")
        const execute: LLMFugu.Execute = (request) => {
          if (!request.forbidImplicitTools) {
            return Stream.fromEffect(
              Ref.set(synthesizerMessages, JSON.stringify(request.messages)).pipe(
                Effect.as({ type: "text-delta", id: "synth", text: "aggregated final" } satisfies LLMEventType),
              ),
            )
          }
          return Stream.fromEffect(
            Ref.modify(branchCalls, (count) => [count, count + 1] as const).pipe(
              Effect.flatMap((index): Effect.Effect<LLMEventType, Error> => {
                if (index === 1) {
                  return Effect.succeed({
                    type: "provider-error",
                    message: "branch provider failed",
                  } satisfies LLMEventType)
                }
                if (index === 3) return Effect.fail(new Error("branch stream failed"))
                return Effect.succeed({
                  type: "text-delta",
                  id: `branch-${index}`,
                  text: `branch ${index}`,
                } satisfies LLMEventType)
              }),
            ),
          )
        }

        const events = yield* LLMFugu.run(
          { ...fuguInput(fuguRuntimeModel()), abort: new AbortController().signal },
          fuguConfig({
            branches: Array.from({ length: branchCount }, () => ({ model: fuguTarget, variant: "high" })),
          }).fugu,
          provider,
          execute,
        ).pipe(
          Effect.flatMap((stream) => Stream.runCollect(stream)),
          Effect.map((chunk) => Array.from(chunk)),
        )

        const messages = yield* Ref.get(synthesizerMessages)
        expect(visibleText(events)).toBe("aggregated final")
        expect(yield* Ref.get(branchCalls)).toBe(branchCount)
        expect(messages).toContain("branch 0")
        expect(messages).toContain("branch 2")
        expect(messages).toContain("branch 4")
        expect(messages).toContain("branch provider failed")
        expect(messages).toContain("branch stream failed")
        expect(messages).toContain('\\"status\\": \\"success\\"')
        expect(messages).toContain('\\"status\\": \\"error\\"')
      }),
    { config: () => fuguConfig() },
  )

  it.instance(
    "sends temperature, tokens, and reasoning options for openai-compatible models",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(vivgridFixture.providerID, vivgridFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(vivgridFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(vivgridFixture.providerID), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      }),
    {
      config: () => ({
        enabled_providers: [vivgridFixture.providerID],
        provider: {
          [vivgridFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  const alibabaQwenFixture = { providerID: "alibaba", modelID: "qwen-plus" }
  it.instance(
    "service stream cancellation cancels provider response body promptly",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const pending = waitStreamingRequest("/chat/completions")

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        const fiber = yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        }).pipe(Effect.exit, Effect.forkScoped)

        yield* Effect.promise(() => pending.request)
        yield* Fiber.interrupt(fiber)

        yield* Effect.promise(() => Promise.race([pending.responseCanceled, timeout(500)]))
        const exit = yield* Fiber.await(fiber)
        // Fiber.await returns an Exit<Exit<...>>. Unwrap once.
        const inner = Exit.isSuccess(exit) ? exit.value : exit
        expect(Exit.isFailure(inner)).toBe(true)
        if (Exit.isFailure(inner)) {
          expect(Cause.hasInterrupts(inner.cause)).toBe(true)
        }
        yield* Effect.promise(() => Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined))
      }),
    {
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "keeps tools enabled by prompt permissions",
    () =>
      Effect.gen(function* () {
        const fixture = loadFixture(alibabaQwenFixture.providerID, alibabaQwenFixture.modelID)
        const request = waitRequest(
          "/chat/completions",
          new Response(createChatStream("Hello"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        )

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(alibabaQwenFixture.providerID),
          ModelV2.ID.make(fixture.model.id),
        )
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(alibabaQwenFixture.providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      }),
    {
      config: () => ({
        enabled_providers: [alibabaQwenFixture.providerID],
        provider: {
          [alibabaQwenFixture.providerID]: {
            options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends responses API payload for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model

        const responseChunks = [
          {
            type: "response.created",
            response: {
              id: "resp-1",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-1", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-1",
            delta: "Hello",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(responseChunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined) // match codex cli behavior
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "keeps supported OpenAI models on AI SDK path when native flag is off",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const request = waitRequest(
          "/responses",
          createEventResponse(
            [
              {
                type: "response.created",
                response: {
                  id: "resp-flag-off",
                  created_at: Math.floor(Date.now() / 1000),
                  model: model.id,
                  service_tier: null,
                },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "item-flag-off", status: "in_progress", role: "assistant", content: [] },
              },
              {
                type: "response.content_part.added",
                item_id: "item-flag-off",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: "item-flag-off",
                delta: "Flag off",
                logprobs: null,
              },
              {
                type: "response.completed",
                response: {
                  incomplete_details: null,
                  usage: {
                    input_tokens: 1,
                    input_tokens_details: null,
                    output_tokens: 1,
                    output_tokens_details: null,
                  },
                  service_tier: null,
                },
              },
            ],
            true,
          ),
        )
        const failingNativeClient = Layer.succeed(
          LLMClient.Service,
          LLMClient.Service.of({
            prepare: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
            stream: () => Stream.die(new Error("native LLM client should not be used when the flag is off")),
            generate: () => Effect.die(new Error("native LLM client should not be used when the flag is off")),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-flag-off")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(
          LLM.layer.pipe(
            Layer.provide(Auth.defaultLayer),
            Layer.provide(Config.defaultLayer),
            Layer.provide(Provider.defaultLayer),
            Layer.provide(Plugin.defaultLayer),
            Layer.provide(failingNativeClient),
            Layer.provide(RuntimeFlags.layer({ experimentalNativeLlm: false })),
          ),
          {
            user: {
              id: MessageID.make("msg_user-native-flag-off"),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: agent.name,
              model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
            } satisfies SessionV1.User,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          },
        )

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.body.model).toBe(resolved.api.id)
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "streams OpenAI through native runtime when opted in",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          { type: "response.created", response: { id: "resp-native" } },
          {
            type: "response.output_item.added",
            item: { type: "message", id: "item-native", status: "in_progress" },
          },
          { type: "response.output_text.delta", item_id: "item-native", delta: "Hello native" },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor(RequestExecutor.defaultLayer, { experimentalNativeLlm: true }), {
          user: {
            id: MessageID.make("msg_user-native"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id, variant: "high" },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(capture.headers.get("Authorization")).toBe("Bearer test-openai-key")
        expect(capture.body.model).toBe(model.id)
        expect(capture.body.stream).toBe(true)
        expect((capture.body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")
        expect(capture.body.include).toEqual(["reasoning.encrypted_content"])
        expect(JSON.stringify(capture.body.input)).toContain("You are a helpful assistant.")
        expect(capture.body.input).toContainEqual({ role: "user", content: [{ type: "input_text", text: "Hello" }] })
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  it.instance(
    "uses injected native request executor for tool calls",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-injected-tool", call_id: "call-injected-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-injected-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-injected-tool",
              call_id: "call-injected-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        let captured: Record<string, unknown> | undefined
        let executed: unknown
        const executor = Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                captured = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
                return HttpClientResponse.fromWeb(request, createEventResponse(chunks, true))
              }),
          }),
        )

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-injected-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor(executor, { experimentalNativeLlm: true }), {
          user: {
            id: MessageID.make("msg_user-native-injected-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        expect(captured?.model).toBe(model.id)
        expect(captured?.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-injected-tool" })
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, "https://injected-openai.test/v1") },
  )

  it.instance(
    "executes OpenAI tool calls through native runtime",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item-native-tool", call_id: "call-native-tool", name: "lookup" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-native-tool",
            delta: '{"query":"weather"}',
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item-native-tool",
              call_id: "call-native-tool",
              name: "lookup",
              arguments: '{"query":"weather"}',
            },
          },
          {
            type: "response.completed",
            response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        let executed: unknown

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-native-tool")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        yield* drainWith(llmLayerWithExecutor(RequestExecutor.defaultLayer, { experimentalNativeLlm: true }), {
          user: {
            id: MessageID.make("msg_user-native-tool"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
          } satisfies SessionV1.User,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: [{ role: "user", content: "Use lookup" }],
          tools: {
            lookup: tool({
              description: "Lookup data",
              inputSchema: z.object({ query: z.string() }),
              execute: async (args, options) => {
                executed = { args, toolCallId: options.toolCallId }
                return { output: "looked up" }
              },
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.body.tools).toEqual([
          {
            type: "function",
            name: "lookup",
            description: "Lookup data",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
              $schema: "http://json-schema.org/draft-07/schema#",
            },
          },
        ])
        expect(executed).toEqual({ args: { query: "weather" }, toolCallId: "call-native-tool" })
      }),
    {
      config: () => {
        const model = loadFixture("openai", "gpt-5.2").model
        return {
          enabled_providers: ["openai"],
          provider: {
            openai: {
              name: "OpenAI",
              env: ["OPENAI_API_KEY"],
              npm: "@ai-sdk/openai",
              api: "https://api.openai.com/v1",
              models: { [model.id]: JSON.parse(JSON.stringify(model)) as ConfigModel },
              options: { apiKey: "test-openai-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  it.instance(
    "accepts user image attachments as data URLs for OpenAI models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("openai", "gpt-5.2").model
        const chunks = [
          {
            type: "response.created",
            response: {
              id: "resp-data-url",
              created_at: Math.floor(Date.now() / 1000),
              model: model.id,
              service_tier: null,
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "item-data-url", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "item-data-url",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "item-data-url",
            delta: "Looks good",
            logprobs: null,
          },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
        const request = waitRequest("/responses", createEventResponse(chunks, true))
        const image = `data:image/png;base64,${Buffer.from(
          yield* Effect.promise(() =>
            Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
          ),
        ).toString("base64")}`

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.openai, ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("openai"), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                { type: "file", mediaType: "image/png", filename: "large-image.png", data: image },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      }),
    { config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`) },
  )

  const minimaxFixture = { providerID: "minimax", modelID: "MiniMax-M2.5" }
  it.instance(
    "sends messages API payload for Anthropic Compatible models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(minimaxFixture.providerID, minimaxFixture.modelID).model

        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-1",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(minimaxFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("minimax"), modelID: ModelV2.ID.make("MiniMax-M2.5") },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      }),
    {
      config: () => ({
        enabled_providers: [minimaxFixture.providerID],
        provider: {
          [minimaxFixture.providerID]: {
            options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
          },
        },
      }),
    },
  )

  it.instance(
    "sends anthropic tool_use blocks with tool_result immediately after them",
    () =>
      Effect.gen(function* () {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        const chunks = [
          {
            type: "message_start",
            message: {
              id: "msg-tool-order",
              model: model.id,
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
          { type: "message_stop" },
        ]
        const request = waitRequest("/messages", createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(ProviderV2.ID.make("anthropic"), ModelV2.ID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies SessionV1.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        const modelMessages = yield* Effect.promise(() => MessageV2.toModelMessages(input as any, resolved))
        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: modelMessages,
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({ filePath: z.string() }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
        expect(messages[0]?.role).toBe("user")
        expect(messages[0]?.content[0]).toMatchObject({
          type: "text",
          text: "Can you check whether there are any PDF files in my home directory?",
        })
        expect(messages.some((message) => message.content.some((part) => "cache_control" in part))).toBe(true)
        const toolUseIndex = messages.findIndex((message) => message.content.some((part) => part.type === "tool_use"))
        expect(toolUseIndex).toBeGreaterThan(0)
        expect(messages[toolUseIndex].role).toBe("assistant")
        expect(messages[toolUseIndex].content.filter((part) => part.type === "tool_use")).toMatchObject([
          {
            type: "tool_use",
            id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
            name: "read",
            input: { filePath: "/root" },
          },
          {
            type: "tool_use",
            id: "toolu_01APxrADs7VozN8uWzw9WwHr",
            name: "glob",
            input: { pattern: "**/*.pdf", path: "/root" },
          },
        ])
        expect(messages[toolUseIndex + 1]).toMatchObject({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT", content: "<path>/root</path>" },
            { type: "tool_result", tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr", content: "No files found" },
          ],
        })
      }),
    {
      config: () => {
        const model = loadFixture("anthropic", "claude-opus-4-6").model
        return {
          enabled_providers: ["anthropic"],
          provider: {
            anthropic: {
              name: "Anthropic",
              env: ["ANTHROPIC_API_KEY"],
              npm: "@ai-sdk/anthropic",
              api: "https://api.anthropic.com/v1",
              models: { [model.id]: configModel(model) as ConfigModel },
              options: { apiKey: "test-anthropic-key", baseURL: `${state.server!.url.origin}/v1` },
            },
          },
        }
      },
    },
  )

  const geminiFixture = { providerID: "google", modelID: "gemini-2.5-flash" }
  it.instance(
    "sends Google API payload for Gemini models",
    () =>
      Effect.gen(function* () {
        const model = loadFixture(geminiFixture.providerID, geminiFixture.modelID).model
        const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

        const chunks = [
          {
            candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          },
        ]
        const request = waitRequest(pathSuffix, createEventResponse(chunks))

        const resolved = yield* Provider.use.getModel(
          ProviderV2.ID.make(geminiFixture.providerID),
          ModelV2.ID.make(model.id),
        )
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderV2.ID.make(geminiFixture.providerID), modelID: resolved.id },
        } satisfies SessionV1.User

        yield* drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: [{ type: "reasoning", text: "" }] },
          ],
          tools: {},
        })

        const capture = yield* Effect.promise(() => request)
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }])
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      }),
    {
      config: () => ({
        enabled_providers: [geminiFixture.providerID],
        provider: {
          [geminiFixture.providerID]: {
            options: { apiKey: "test-google-key", baseURL: `${state.server!.url.origin}/v1beta` },
          },
        },
      }),
    },
  )
})
