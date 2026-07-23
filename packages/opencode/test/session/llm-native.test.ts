import { describe, expect, test } from "bun:test"
import { LLMEvent, ToolFailure } from "@oc2-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor, type LLMClientShape } from "@oc2-ai/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { ProviderTimingLifecycle } from "@/session/llm/provider-timing"
import type { Provider } from "@/provider/provider"

import { OAUTH_DUMMY_KEY } from "@/auth"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { ModelV2 } from "@oc2-ai/core/model"
import providerParityInventory from "../../../core/test/fixtures/provider-parity-inventory.json"
import { compareParityRuns, NativeDirectUnsupportedError, type ProviderParityCassette } from "../lib/provider-parity"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    input: 128_000,
    output: 32_000,
  },
  status: "active",
  options: {},
  headers: {
    "x-model": "model-header",
  },
  release_date: "2026-01-01",
}

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
)

function responsesStream(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

type NativeRequestInput = Parameters<typeof LLMNative.request>[0]

const sessionText = (text: string) => ({ type: "text" as const, text })

const sessionOpenAIReasoning = (
  text: string,
  options: {
    readonly storedAs: "providerMetadata" | "providerOptions"
    readonly itemId: string
    readonly encryptedContent: string | null
  },
) => {
  const metadata = {
    openai: { itemId: options.itemId, reasoningEncryptedContent: options.encryptedContent },
  }
  if (options.storedAs === "providerMetadata")
    return Object.assign({ type: "reasoning" as const, text }, { providerMetadata: metadata })
  return Object.assign({ type: "reasoning" as const, text }, { providerOptions: metadata })
}

type SessionAssistantPart = ReturnType<typeof sessionText> | ReturnType<typeof sessionOpenAIReasoning>

const storedSession = {
  user: (content: string): ModelMessage => ({ role: "user", content }),
  assistant: (content: SessionAssistantPart[]): ModelMessage => ({ role: "assistant", content }),
  text: sessionText,
  openaiReasoning: sessionOpenAIReasoning,
}

const openAIResponses = {
  user: (text: string) => ({ role: "user", content: [{ type: "input_text", text }] }),
  assistant: (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] }),
  openaiReasoning: (text: string, options: { readonly itemId: string; readonly encryptedContent: string }) => ({
    type: "reasoning",
    id: options.itemId,
    encrypted_content: options.encryptedContent,
    summary: [{ type: "summary_text", text }],
  }),
}

const prepareNativeRequest = (input: NativeRequestInput) => LLMClient.prepare(LLMNative.request(input))

const expectOpenAIResponsesRequest = (input: {
  readonly history: NativeRequestInput["messages"]
  readonly providerOptions?: NativeRequestInput["providerOptions"]
  readonly maxOutputTokens?: NativeRequestInput["maxOutputTokens"]
  readonly headers?: NativeRequestInput["headers"]
  readonly expectedBody: unknown
}) =>
  Effect.gen(function* () {
    expect(
      yield* prepareNativeRequest({
        model: baseModel,
        apiKey: "test-openai-key",
        messages: input.history,
        providerOptions: input.providerOptions,
        maxOutputTokens: input.maxOutputTokens,
        headers: input.headers,
      }),
    ).toMatchObject({
      route: "openai-responses",
      protocol: "openai-responses",
      body: input.expectedBody,
    })
  })

describe("session.llm-native.request", () => {
  test("maps normalized stream inputs to a native LLM request", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "system from messages",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "file", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
            providerOptions: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ]

    const request = LLMNative.request({
      model: baseModel,
      system: ["agent system"],
      messages,
      tools: {
        bash: tool({
          description: "Run a shell command",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          }),
        }),
      },
      toolChoice: "required",
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      providerOptions: { openai: { store: false } },
      headers: { "x-request": "request-header" },
    })

    expect(request.model).toMatchObject({
      id: "gpt-5-mini",
      provider: "openai",
      route: { id: "openai-responses" },
    })
    expect(request.model.route.endpoint.baseURL).toBe("https://api.openai.com/v1")
    expect(request.model.route.defaults.headers).toEqual({
      "x-model": "model-header",
      "x-request": "request-header",
    })
    expect(request.model.route.defaults.limits).toMatchObject({
      context: 128_000,
      output: 32_000,
    })
    expect(request.system).toEqual([
      { type: "text", text: "agent system" },
      { type: "text", text: "system from messages" },
    ])
    expect(request.generation).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxTokens: 1024,
    })
    expect(request.providerOptions).toEqual({ openai: { store: false } })
    expect(request.toolChoice).toMatchObject({ type: "required" })
    expect(request.tools).toMatchObject([
      {
        name: "bash",
        description: "Run a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
    ])
    expect(request.messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerMetadata: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "media", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerMetadata: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            id: "call-1",
            name: "bash",
            input: { command: "ls" },
            providerMetadata: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "bash",
            result: { type: "text", value: "ok" },
            providerMetadata: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ])
  })

  test("maps stored provider metadata to native content metadata", () => {
    const reasoning = Object.assign(
      { type: "reasoning" as const, text: "thinking" },
      {
        providerMetadata: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-state",
          },
        },
      },
    )
    const request = LLMNative.request({
      model: baseModel,
      messages: [
        {
          role: "assistant",
          content: [reasoning],
        },
      ],
    })

    expect(request.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ],
      },
    ])
  })

  test("selects native request routes for provider packages", () => {
    const openai = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/openai" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openai.route.id).toBe("openai-responses")
    expect(openai.route.endpoint.baseURL).toBe("https://api.openai.com/v1")

    const anthropic = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/anthropic" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(anthropic.route.id).toBe("anthropic-messages")
    expect(anthropic.route.endpoint.baseURL).toBe("https://api.anthropic.com/v1")

    const google = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/google" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(google.route.id).toBe("gemini")
    expect(google.route.endpoint.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")

    const compatible = LLMNative.model({
      model: {
        ...baseModel,
        providerID: ProviderV2.ID.make("custom-compatible"),
        api: { ...baseModel.api, url: "https://ai.example.test/v1", npm: "@ai-sdk/openai-compatible" },
      },
      apiKey: "test-key",
      messages: [],
    })
    expect(compatible.route.id).toBe("openai-compatible-chat")
    expect(compatible.route.endpoint.baseURL).toBe("https://ai.example.test/v1")

    const openrouter = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@openrouter/ai-sdk-provider" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openrouter.route.id).toBe("openrouter")
    expect(openrouter.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")
  })

  it.effect("leaves unmarked native system context out of cache hints", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareNativeRequest({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("anthropic"),
          api: { ...baseModel.api, id: "claude-sonnet-4-5", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
        },
        apiKey: "test-key",
        system: ["Generated at 2026-07-22T12:00:00Z"],
        messages: [
          { role: "system", content: "Session timestamp 2026-07-22T12:00:01Z" },
          { role: "user", content: "hi" },
        ],
      })

      expect(prepared.body).toMatchObject({
        system: [
          { type: "text", text: "Generated at 2026-07-22T12:00:00Z", cache_control: undefined },
          { type: "text", text: "Session timestamp 2026-07-22T12:00:01Z", cache_control: undefined },
        ],
      })
      expect(JSON.stringify(prepared.body)).not.toContain("cache_control")
    }),
  )

  it.effect("lowers native OpenAI prompt cache key from the shared CachePlan", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareNativeRequest({
        model: baseModel,
        apiKey: "test-key",
        system: ["Stable system"],
        messages: [{ role: "user", content: "hi" }],
        tools: {
          bash: tool({
            description: "Run a command",
            inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } } }),
          }),
        },
        providerOptions: { openai: { promptCacheKey: "manual-key" } },
      })

      expect(prepared.body).toMatchObject({ prompt_cache_key: expect.stringMatching(/^oc2-v1-/) })
      expect((prepared.body as { prompt_cache_key?: string }).prompt_cache_key).not.toBe("manual-key")
    }),
  )

  it.effect("does not lower manual prompt cache keys for unsupported OpenAI-compatible models", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareNativeRequest({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("deepseek"),
          api: { ...baseModel.api, id: "deepseek-chat", url: "https://api.deepseek.com/v1", npm: "@ai-sdk/openai-compatible" },
        },
        apiKey: "test-key",
        system: ["Stable system"],
        messages: [{ role: "user", content: "hi" }],
        providerOptions: { openai: { promptCacheKey: "manual-key" } },
      })

      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache_key")
      expect(JSON.stringify(prepared.body)).not.toContain("cache_control")
    }),
  )

  it.effect("lowers native Anthropic CachePlan breakpoints without leaking cache hints", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareNativeRequest({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("anthropic"),
          api: { ...baseModel.api, id: "claude-sonnet-4-5", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
        },
        apiKey: "test-key",
        system: ["Stable system"],
        messages: [{ role: "user", content: "hi" }],
        tools: {
          bash: tool({
            description: "Run a command",
            inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } } }),
          }),
        },
      })

      expect(prepared.body).toMatchObject({
        tools: [{ name: "bash", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Stable system", cache_control: undefined }],
      })
    }),
  )

  test("fails fast for unsupported provider packages", () => {
    expect(() =>
      LLMNative.request({
        model: { ...baseModel, api: { ...baseModel.api, npm: "unknown-provider" } },
        messages: [],
      }),
    ).toThrow("Native LLM request adapter does not support provider package unknown-provider")
  })

  test("only enables native runtime for supported OpenAI API-key models", () => {
    expect(LLMNativeRuntime.status({ model: baseModel, provider: providerInfo, auth: undefined })).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.oc2 },
        provider: { ...providerInfo, id: ProviderV2.ID.oc2 },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "provider is not openai or anthropic" })
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("google") },
        provider: { ...providerInfo, id: ProviderV2.ID.make("google") },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "provider is not openai or anthropic" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: providerInfo,
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: async () => new Response() } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toMatchObject({ type: "supported", apiKey: OAUTH_DUMMY_KEY })

    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, api: { ...baseModel.api, npm: "@ai-sdk/google" } },
        provider: providerInfo,
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" })

    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {} },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "API key is not configured" })
  })

  test("fails all bespoke batch cells before transport or AI SDK fallback", async () => {
    const providers = providerParityInventory.providers.filter(
      (provider) => provider.batchID === "bespoke-sdk-gateway-01",
    )
    const emptyCassette: ProviderParityCassette = { version: 1, interactions: [] }
    let checked = 0
    for (const provider of providers) {
      for (const scenario of provider.scenarios) {
        if (scenario.status === "not-applicable") continue
        if (!scenario.modelID || !scenario.api) throw new Error(`Incomplete cell ${provider.id}/${scenario.id}`)
        let aiSdkCalled = false
        let transportCalls = 0
        const llmClient: LLMClientShape = {
          prepare: () => Effect.die("provider parity transport must not prepare"),
          stream: () => {
            transportCalls++
            return Stream.die("provider parity transport must not stream")
          },
          generate: () => Effect.die("provider parity transport must not generate"),
        }
        const failure = await compareParityRuns({
          cassette: emptyCassette,
          aiSdk: () => {
            aiSdkCalled = true
            throw new Error("AI SDK fallback must not run")
          },
          nativeDirect: () => ({
            model: {
              ...baseModel,
              id: ModelV2.ID.make(scenario.modelID),
              providerID: ProviderV2.ID.make(provider.id),
              api: {
                id: scenario.modelID,
                url: scenario.api.url ?? "",
                npm: scenario.api.package,
              },
            },
            provider: {
              ...providerInfo,
              id: ProviderV2.ID.make(provider.id),
              name: provider.id,
              env: provider.credentialSources.catalogEnv,
              options: { apiKey: "unused" },
            },
            auth: undefined,
            llmClient,
            messages: [],
            tools: {},
            headers: {},
            abort: new AbortController().signal,
          }),
        }).catch((cause: unknown) => cause)
        expect(failure).toBeInstanceOf(NativeDirectUnsupportedError)
        if (!(failure instanceof NativeDirectUnsupportedError)) throw failure
        expect(failure.context).toEqual({
          providerID: provider.id,
          modelID: scenario.modelID,
          effectiveAPI: { package: scenario.api.package, url: scenario.api.url },
          reason: "provider is not openai or anthropic",
        })
        expect(aiSdkCalled).toBeFalse()
        expect(transportCalls).toBe(0)
        checked++
      }
    }
    expect(checked).toBe(23)
  })

  test("enables native runtime for Anthropic API-key models", () => {
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("anthropic"),
          api: { ...baseModel.api, npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
        },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("anthropic"),
          name: "Anthropic",
          env: ["ANTHROPIC_API_KEY"],
          options: { apiKey: "test-anthropic-key" },
        },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: "test-anthropic-key" })
  })

  test("prefers provider api key over stored auth", () => {
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: {
          ...providerInfo,
          options: { apiKey: "console-token" },
          key: "stored-token",
        },
        auth: { type: "api", key: "stored-token" },
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "console-token",
    })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {}, key: "provider-key" },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "provider-key",
    })
  })

  it.effect("native tool wrapper converts thrown errors into typed ToolFailure", () =>
    Effect.gen(function* () {
      const wrapped = LLMNativeRuntime.nativeTools(
        {
          explode: {
            description: "always throws",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              throw new Error("boom")
            },
          } satisfies Tool,
        },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.explode.execute({}, { id: "call-1", name: "explode" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toBe("boom")
    }),
  )

  it.effect("native tool wrapper raises ToolFailure when the source tool has no execute handler", () =>
    Effect.gen(function* () {
      // The AI SDK Tool shape allows execute to be omitted (e.g., client-side / MCP tools).
      // The native runtime owns execution, so encountering such a tool here means upstream
      // wiring is wrong; we want a typed failure, not a silent skip or unhandled exception.
      const wrapped = LLMNativeRuntime.nativeTools(
        { incomplete: { description: "no execute", inputSchema: jsonSchema({ type: "object" }) } satisfies Tool },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.incomplete.execute({}, { id: "call-1", name: "incomplete" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("incomplete")
    }),
  )

  it.effect("emits native tool calls before overlapping local settlements complete", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      const started: string[] = []
      let release: (() => void) | undefined
      let notifyStarted: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const bothStarted = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const lookup = {
        description: "Lookup data",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (_args: unknown, options: { toolCallId: string }) => {
          started.push(options.toolCallId)
          if (started.length === 2) notifyStarted?.()
          await gate
          return { output: options.toolCallId }
        },
      } satisfies Tool
      let now = 100
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: (_request, options) =>
          Stream.fromIterable([
            LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
            LLMEvent.toolCall({ id: "call-2", name: "lookup", input: {} }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "step-finish") now = 150
              }),
            ),
            Stream.onStart(Effect.sync(() => options?.onDispatch?.())),
          ),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const timing = ProviderTimingLifecycle.makeProviderTiming(() => now)
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools: { lookup },
        headers: {},
        abort: new AbortController().signal,
        timing,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const fiber = yield* native.stream.pipe(
        Stream.runForEach((event) => Effect.sync(() => observed.push(event.type))),
        Effect.forkScoped,
      )
      yield* Effect.promise(() => bothStarted)

      expect(started).toEqual(["call-1", "call-2"])
      const provider = ProviderTimingLifecycle.takeProviderStep(timing, 0)
      expect(provider).toEqual({
        step: 0,
        started: 100,
        completed: 150,
        duration: 50,
        outcome: "success",
      })
      expect(observed).toEqual(["tool-call", "tool-call", "step-finish", "finish"])

      release?.()
      yield* Fiber.join(fiber)
      expect(provider).toEqual({
        step: 0,
        started: 100,
        completed: 150,
        duration: 50,
        outcome: "success",
      })
      expect(observed).toEqual(["tool-call", "tool-call", "step-finish", "finish", "tool-result", "tool-result"])
    }),
  )

  it.effect("emits one provider error for raw EOF before gated native tools settle", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      let release: (() => void) | undefined
      let notifyFailure: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const failed = new Promise<void>((resolve) => {
        notifyFailure = resolve
      })
      let now = 100
      const timing = ProviderTimingLifecycle.makeProviderTiming(() => now)
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient: {
          prepare: () => Effect.die("unused"),
          stream: (_request, options) =>
            Stream.make(LLMEvent.toolCall({ id: "call-eof", name: "lookup", input: {} })).pipe(
              Stream.tap(() => Effect.sync(() => (now = 175))),
              Stream.onStart(Effect.sync(() => options?.onDispatch?.())),
            ),
          generate: () => Effect.die("unused"),
        } as LLMClientShape,
        messages: [],
        tools: {
          lookup: {
            description: "Lookup data",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              await gate
              return { output: "done" }
            },
          } satisfies Tool,
        },
        headers: {},
        abort: new AbortController().signal,
        timing,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const fiber = yield* native.stream.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            observed.push(event.type)
            if (event.type === "provider-error") notifyFailure?.()
          }),
        ),
        Effect.forkScoped,
      )
      yield* Effect.promise(() => failed)

      expect(observed).toEqual(["tool-call", "provider-error"])
      expect(ProviderTimingLifecycle.takeProviderStep(timing, 0)).toEqual({
        step: 0,
        started: 100,
        completed: 175,
        duration: 75,
        outcome: "eof",
      })
      release?.()
      yield* Fiber.join(fiber)
      expect(observed).toEqual(["tool-call", "provider-error", "tool-result"])
    }),
  )

  it.effect("settles an active native transport attempt once on cancellation", () =>
    Effect.gen(function* () {
      let now = 100
      let notifyDispatch: (() => void) | undefined
      const dispatched = new Promise<void>((resolve) => {
        notifyDispatch = resolve
      })
      const timing = ProviderTimingLifecycle.makeProviderTiming(() => now)
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient: {
          prepare: () => Effect.die("unused"),
          stream: (_request, options) =>
            Stream.never.pipe(
              Stream.onStart(
                Effect.sync(() => {
                  options?.onDispatch?.()
                  notifyDispatch?.()
                }),
              ),
            ),
          generate: () => Effect.die("unused"),
        } as LLMClientShape,
        messages: [],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
        timing,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const fiber = yield* native.stream.pipe(Stream.runDrain, Effect.forkScoped)
      yield* Effect.promise(() => dispatched)
      now = 150
      yield* Fiber.interrupt(fiber)

      expect(ProviderTimingLifecycle.takeProviderStep(timing, 0)).toEqual({
        step: 0,
        started: 100,
        completed: 150,
        duration: 50,
        outcome: "interrupt",
      })
    }),
  )

  it.effect("does not resettle a final transport failure exposed as provider-error", () =>
    Effect.gen(function* () {
      let now = 100
      const timing = ProviderTimingLifecycle.makeProviderTiming(() => now)
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient: {
          prepare: () => Effect.die("unused"),
          stream: (_request, options) =>
            Stream.suspend(() => {
              options?.onDispatch?.()
              now = 125
              options?.onDispatchFailure?.()
              return Stream.make(LLMEvent.providerError({ message: "transport failed" }))
            }),
          generate: () => Effect.die("unused"),
        } as LLMClientShape,
        messages: [],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
        timing,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))
      expect(events).toMatchObject([{ type: "provider-error", message: "transport failed" }])
      expect(ProviderTimingLifecycle.takeProviderStep(timing, 0)).toEqual({
        step: 0,
        started: 100,
        completed: 125,
        duration: 25,
        outcome: "error",
      })
    }),
  )

  it.effect("compiles through the native OpenAI Responses route", () =>
    expectOpenAIResponsesRequest({
      history: [storedSession.user("hello")],
      providerOptions: { openai: { store: false, instructions: "You are concise." } },
      maxOutputTokens: 512,
      headers: { "x-request": "request-header" },
      expectedBody: {
        model: "gpt-5-mini",
        instructions: "You are concise.",
        input: [openAIResponses.user("hello")],
        max_output_tokens: 512,
        store: false,
        stream: true,
      },
    }),
  )

  it.effect("omits non-persisted OpenAI reasoning ids without encrypted state", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerOptions",
            itemId: "rs_1",
            encryptedContent: null,
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        store: false,
      },
    }),
  )

  it.effect("preserves encrypted OpenAI reasoning state through native request lowering", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.openaiReasoning("Checked the previous diff.", {
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("preserves empty encrypted OpenAI reasoning items before tool output", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
        ]),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-state" }],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("references stored OpenAI reasoning items by id", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: null,
          }),
        ]),
      ],
      providerOptions: { openai: { store: true } },
      expectedBody: {
        input: [{ type: "item_reference", id: "rs_1" }],
        store: true,
      },
    }),
  )

  it.effect("uses provider fetch override for native OpenAI OAuth requests", () =>
    Effect.gen(function* () {
      const captures: Array<{ url: string; body: unknown }> = []
      const customFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          captures.push({ url: request.url, body: await request.clone().json() })
          return responsesStream([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ])
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch

      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: customFetch } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        providerOptions: { instructions: "You are concise." },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)
      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))

      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        body: {
          model: "gpt-5-mini",
          instructions: "You are concise.",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
      })
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text-delta", text: "Hello" }),
          expect.objectContaining({ type: "finish" }),
        ]),
      )
    }),
  )
})
