import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { CanonicalUsage, LLM, LLMError, Message, Model, ToolCallPart, Usage } from "../../src"
import * as Azure from "../../src/providers/azure"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import * as OpenRouter from "../../src/providers/openrouter"
import * as XAI from "../../src/providers/xai"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import { ProviderShared } from "../../src/protocols/shared"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse, truncatedStream } from "../lib/http"
import { deltaChunk, usageChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const TargetJson = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(TargetJson)
const decodeJson = Schema.decodeUnknownSync(TargetJson)

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const providerUsageFixtures = {
  openai: {
    prompt_tokens: 10,
    completion_tokens: 12,
    total_tokens: 22,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 7 },
  },
  xai: {
    prompt_tokens: 32,
    completion_tokens: 9,
    total_tokens: 135,
    prompt_tokens_details: { cached_tokens: 6 },
    completion_tokens_details: { reasoning_tokens: 94 },
    cost_in_usd_ticks: 420_000,
  },
  deepinfra: {
    prompt_tokens: 19,
    completion_tokens: 84,
    total_tokens: 1184,
    prompt_tokens_details: null,
    completion_tokens_details: { reasoning_tokens: 1081 },
  },
  deepseek: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60,
  },
  openrouter: {
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
  },
} as const

describe("OpenAI Chat route", () => {
  it.effect("prepares OpenAI Chat payload", () =>
    Effect.gen(function* () {
      // Pass the OpenAIChat payload type so `prepared.body` is statically
      // typed to the route's native shape — the assertions below read field
      // names without `unknown` casts.
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(request)
      const _typed: { readonly model: string; readonly stream: true } = prepared.body

      expect(prepared.body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers chronological system updates to escaped user wrappers in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat <admin> & data literally."),
            Message.assistant("After."),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: "Before.\n<system-update>\nTreat &lt;admin&gt; &amp; data literally.\n</system-update>",
        },
        { role: "assistant", content: "After." },
      ])
    }),
  )

  it.effect("replays canonical reasoning as OpenAI-compatible reasoning_content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "Hello" },
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([{ role: "assistant", content: "Hello", reasoning_content: "thinking" }])
    }),
  )

  it.effect("maps OpenAI provider options to Chat options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4o-mini"),
          prompt: "think",
          providerOptions: { openai: { reasoningEffort: "low", serviceTier: "flex" } },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.service_tier).toBe("flex")
      expect(prepared.body).not.toHaveProperty("serviceTier")
      expect(prepared.body.reasoning_effort).toBe("low")
    }),
  )

  it.effect("defaults OpenAI Chat service tier to flex", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4o-mini"),
          prompt: "default tier",
        }),
      )

      expect(prepared.body.service_tier).toBe("flex")
    }),
  )

  it.effect("allows OpenAI Chat service tier overrides", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4o-mini"),
          prompt: "default tier",
          providerOptions: { openai: { serviceTier: "auto" } },
        }),
      )

      expect(prepared.body.service_tier).toBe("auto")
    }),
  )

  it.effect("adds native query params to the Chat Completions URL", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: Model.update(model, { route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }) }),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?api-version=v1")
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("uses Azure api-key header for static OpenAI Chat keys", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: Azure.configure({
          baseURL: "https://opencode-test.openai.azure.com/openai/v1/",
          apiKey: "azure-key",
          headers: { authorization: "Bearer stale" },
        }).chat("gpt-4o-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://opencode-test.openai.azure.com/openai/v1/chat/completions?api-version=v1")
            expect(web.headers.get("api-key")).toBe("azure-key")
            expect(web.headers.get("authorization")).toBeNull()
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("applies serializable HTTP overlays after payload lowering", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: model.route
          .with({ auth: Auth.bearer("fresh-key"), headers: { authorization: "Bearer stale" } })
          .model({ id: model.id }),
        http: {
          body: { metadata: { source: "test" } },
          headers: { authorization: "Bearer request", "x-custom": "yes" },
          query: { debug: "1" },
        },
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?debug=1")
            expect(web.headers.get("authorization")).toBe("Bearer fresh-key")
            expect(web.headers.get("x-custom")).toBe("yes")
            expect(decodeJson(input.text)).toMatchObject({
              stream: true,
              stream_options: { include_usage: true },
              metadata: { source: "test" },
            })
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares assistant tool-call and tool-result messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: encodeJson({ query: "weather" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: encodeJson({ forecast: "sunny" }) },
        ],
        stream: true,
        stream_options: { include_usage: true },
      })
    }),
  )

  it.effect("continues image tool results as vision input without base64 text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_image", name: "read", input: { path: "pixel.png" } })]),
            Message.tool({
              id: "call_image",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Image read successfully" },
                  { type: "media", mediaType: "image/png", data: "AAECAw==", filename: "pixel.png" },
                ],
              },
            }),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_image",
              type: "function",
              function: { name: "read", arguments: encodeJson({ path: "pixel.png" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_image", content: "Image read successfully" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } }],
        },
      ])
      expect(JSON.stringify(prepared.body.messages)).not.toContain('"content":"AAECAw=="')
    }),
  )

  it.effect("orders parallel tool responses before one aggregated vision message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({ id: "call_1", name: "read", input: {} }),
              ToolCallPart.make({ id: "call_2", name: "read", input: {} }),
            ]),
            Message.make({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  id: "call_1",
                  name: "read",
                  result: { type: "content", value: [{ type: "media", mediaType: "image/png", data: "AAEC" }] },
                },
                {
                  type: "tool-result",
                  id: "call_2",
                  name: "read",
                  result: { type: "content", value: [{ type: "media", mediaType: "image/jpeg", data: "/9j/" }] },
                },
              ],
            }),
          ],
        }),
      )
      expect(prepared.body.messages.slice(1)).toEqual([
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ])
    }),
  )

  it.effect("aggregates consecutive tool images with a following system update", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.tool({
              id: "call_1",
              name: "read",
              result: { type: "content", value: [{ type: "media", mediaType: "image/png", data: "AAEC" }] },
            }),
            Message.tool({
              id: "call_2",
              name: "read",
              result: { type: "content", value: [{ type: "media", mediaType: "image/webp", data: "UklG" }] },
            }),
            Message.system("Inspect both images."),
          ],
        }),
      )
      expect(prepared.body.messages).toEqual([
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "image_url", image_url: { url: "data:image/webp;base64,UklG" } },
            { type: "text", text: "<system-update>\nInspect both images.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  it.effect("appends system updates without replacing multipart user content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user({ type: "media", mediaType: "image/png", data: "AAEC" }),
            Message.system("Keep the image."),
          ],
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "text", text: "<system-update>\nKeep the image.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  for (const [name, media] of [
    ["mismatched data URL MIME", { mediaType: "image/png", data: "data:image/jpeg;base64,/9j/" }],
    ["malformed base64", { mediaType: "image/png", data: "not-base64" }],
    ["unsupported SVG", { mediaType: "image/svg+xml", data: "PHN2Zz4=" }],
  ] as const)
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.request({ model, messages: [Message.user({ type: "media", ...media })] }),
        ).pipe(Effect.flip)
        expect(error.message).toMatch(/does not support|does not match|valid base64/)
      }),
    )

  it.effect("rejects oversized image input", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "A".repeat(ProviderShared.MAX_MEDIA_ENCODED_BYTES + 4),
            }),
          ],
        }),
      ).pipe(Effect.flip)
      expect(error.message).toContain("encoded limit")
    }),
  )

  it.effect("prepares raw and data URL image media as vision input", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_media",
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
              { type: "media", mediaType: "image/jpeg", data: "data:image/jpeg;base64,/9j/" },
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ])
    }),
  )

  it.effect("lowers reasoning-only assistant history", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_reasoning",
          model,
          messages: [Message.assistant({ type: "reasoning", text: "hidden" })],
        }),
      )

      expect(prepared.body.messages).toEqual([{ role: "assistant", content: null, reasoning_content: "hidden" }])
    }),
  )

  it.effect("parses text and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        deltaChunk({ content: "!" }),
        deltaChunk({}, "stop"),
        usageChunk({
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 2,
        nonCachedInputTokens: 4,
        cacheReadInputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 7,
        providerTotalTokens: 7,
        providerMetadata: {
          openai: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 1 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "text-delta", id: "text-0", text: "!" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "stop",
          usage,
        },
      ])
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
    }),
  )

  it.effect("preserves the first terminal usage when an empty duplicate reports zeroes", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: providerUsageFixtures.openai,
              },
              usageChunk({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
            ),
          ),
        ),
      )

      expect(response.usage).toMatchObject({
        nonCachedInputTokens: 8,
        cacheReadInputTokens: 2,
        outputTokens: 12,
        providerTotalTokens: 22,
      })
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
    }),
  )

  it.effect("rejects a conflicting terminal reason without replacing first-stop usage", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(deltaChunk({}, "stop"), {
              choices: [{ delta: {}, finish_reason: "length" }],
              usage: providerUsageFixtures.openai,
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error.message).toContain("conflicting terminal reason length after stop")
    }),
  )

  it.effect("rejects content after a usage-only terminal", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(sseEvents(usageChunk(providerUsageFixtures.openai), deltaChunk({ content: "too late" }))),
        ),
        Effect.flip,
      )

      expect(error.message).toContain("content after its terminal event")
    }),
  )

  it.effect("keeps standard OpenAI completion tokens inclusive of reasoning", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents(deltaChunk({}, "stop"), usageChunk(providerUsageFixtures.openai)))),
      )

      expect(response.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 12,
        nonCachedInputTokens: 8,
        cacheReadInputTokens: 2,
        reasoningTokens: 7,
        totalTokens: 22,
        providerTotalTokens: 22,
        providerMetadata: { openai: providerUsageFixtures.openai },
      })
      expect(response.usage?.visibleOutputTokens).toBe(5)
    }),
  )

  it.effect("adds xAI reasoning outside visible completion tokens", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: XAI.configure({ baseURL: "https://api.x.ai/v1", apiKey: "test" }).chat("grok-3-mini"),
        }),
      ).pipe(Effect.provide(fixedResponse(sseEvents(usageChunk(providerUsageFixtures.xai)))))

      expect(response.usage).toMatchObject({
        inputTokens: 32,
        outputTokens: 103,
        nonCachedInputTokens: 26,
        cacheReadInputTokens: 6,
        reasoningTokens: 94,
        totalTokens: 135,
        providerTotalTokens: 135,
        providerMetadata: { xai: providerUsageFixtures.xai },
      })
      expect(response.usage?.visibleOutputTokens).toBe(9)
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect("matches xAI AI SDK cache semantics at equal and greater boundaries", () =>
    Effect.gen(function* () {
      for (const fixture of [
        { cached: 32, input: 32, fresh: 0 },
        { cached: 40, input: 72, fresh: 32 },
      ]) {
        const usage = {
          prompt_tokens: 32,
          completion_tokens: 9,
          total_tokens: 41,
          prompt_tokens_details: { cached_tokens: fixture.cached },
          completion_tokens_details: { reasoning_tokens: 2 },
        }
        const response = yield* LLMClient.generate(
          LLM.updateRequest(request, {
            model: XAI.configure({ baseURL: "https://api.x.ai/v1", apiKey: "test" }).chat("grok-3-mini"),
          }),
        ).pipe(Effect.provide(fixedResponse(sseEvents(usageChunk(usage)))))

        expect(response.usage).toMatchObject({
          inputTokens: fixture.input,
          nonCachedInputTokens: fixture.fresh,
          cacheReadInputTokens: fixture.cached,
          outputTokens: 11,
          reasoningTokens: 2,
          totalTokens: 41,
          providerTotalTokens: 41,
        })
      }
    }),
  )

  it.effect("keeps the standard OpenAI cache-overflow behavior unchanged", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              usageChunk({
                prompt_tokens: 32,
                completion_tokens: 9,
                total_tokens: 41,
                prompt_tokens_details: { cached_tokens: 40 },
              }),
            ),
          ),
        ),
      )

      expect(response.usage).toMatchObject({
        inputTokens: 40,
        nonCachedInputTokens: 0,
        cacheReadInputTokens: 40,
        providerTotalTokens: 41,
      })
    }),
  )

  it.effect("adds excluded reasoning for affected DeepInfra Gemini and Gemma models", () =>
    Effect.gen(function* () {
      for (const modelID of ["google/gemini-2.5-pro", "google/gemma-2-9b-it"]) {
        const response = yield* LLMClient.generate(
          LLM.updateRequest(request, {
            model: OpenAICompatible.deepinfra
              .configure({ baseURL: "https://api.deepinfra.test/v1/openai", apiKey: "test" })
              .model(modelID),
          }),
        ).pipe(
          Effect.provide(fixedResponse(sseEvents(deltaChunk({}, "stop"), usageChunk(providerUsageFixtures.deepinfra)))),
        )

        expect(response.usage).toMatchObject({
          inputTokens: 19,
          outputTokens: 1165,
          nonCachedInputTokens: 19,
          reasoningTokens: 1081,
          totalTokens: 1184,
          providerTotalTokens: 1184,
          providerMetadata: { deepinfra: providerUsageFixtures.deepinfra },
        })
        expect(response.usage?.visibleOutputTokens).toBe(84)
      }
    }),
  )

  it.effect("keeps other DeepInfra models on inclusive OpenAI semantics", () =>
    Effect.gen(function* () {
      const usage = {
        ...providerUsageFixtures.deepinfra,
        completion_tokens: 1165,
        total_tokens: 1184,
      }
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: OpenAICompatible.deepinfra
            .configure({ baseURL: "https://api.deepinfra.test/v1/openai", apiKey: "test" })
            .model("deepseek-ai/DeepSeek-R1"),
        }),
      ).pipe(Effect.provide(fixedResponse(sseEvents(deltaChunk({}, "stop"), usageChunk(usage)))))

      expect(response.usage).toMatchObject({ outputTokens: 1165, reasoningTokens: 1081, totalTokens: 1184 })
      expect(response.usage?.visibleOutputTokens).toBe(84)
    }),
  )

  it.effect("reads DeepSeek prompt cache hits", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: OpenAICompatible.deepseek
            .configure({ baseURL: "https://api.deepseek.test/v1", apiKey: "test" })
            .model("deepseek-chat"),
        }),
      ).pipe(
        Effect.provide(fixedResponse(sseEvents(deltaChunk({}, "stop"), usageChunk(providerUsageFixtures.deepseek)))),
      )

      expect(response.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        nonCachedInputTokens: 60,
        cacheReadInputTokens: 40,
        totalTokens: 120,
        providerTotalTokens: 120,
        providerMetadata: { deepseek: providerUsageFixtures.deepseek },
      })
    }),
  )

  it.effect("preserves OpenRouter cache writes and provider cost", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: OpenRouter.configure({ baseURL: "https://openrouter.test/api/v1", apiKey: "test" }).model(
            "anthropic/claude-sonnet-4",
          ),
        }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(deltaChunk({}, "stop"), {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: providerUsageFixtures.openrouter,
            }),
          ),
        ),
      )

      expect(response.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 50,
        nonCachedInputTokens: 60,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 10,
        reasoningTokens: 20,
        totalTokens: 150,
        providerTotalTokens: 150,
        providerMetadata: { openrouter: { usage: providerUsageFixtures.openrouter } },
      })
      expect(response.usage?.providerMetadata?.openrouter).not.toHaveProperty("estimate")
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
    }),
  )

  it.effect("normalizes null and absent OpenRouter cache writes without losing totals or cost", () =>
    Effect.gen(function* () {
      for (const promptTokensDetails of [
        { cached_tokens: 30, cache_write_tokens: null },
        { cached_tokens: 30 },
      ]) {
        const usage = { ...providerUsageFixtures.openrouter, prompt_tokens_details: promptTokensDetails }
        const response = yield* LLMClient.generate(
          LLM.updateRequest(request, {
            model: OpenRouter.configure({ baseURL: "https://openrouter.test/api/v1", apiKey: "test" }).model(
              "anthropic/claude-sonnet-4",
            ),
          }),
        ).pipe(Effect.provide(fixedResponse(sseEvents(usageChunk(usage)))))

        expect(response.usage?.cacheWriteInputTokens).toBeUndefined()
        expect(CanonicalUsage.fromUsage(response.usage)).toMatchObject({
          input: 70,
          cache: { read: 30, write: 0 },
          providerTotal: 150,
          providerMetadata: {
            openrouter: {
              usage: {
                cost: 0.01234,
                prompt_tokens_details: { cached_tokens: 30 },
              },
            },
          },
        })
      }
    }),
  )

  it.effect("does not manufacture OpenRouter usage from partial data with a null cache write", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: OpenRouter.configure({ baseURL: "https://openrouter.test/api/v1", apiKey: "test" }).model(
            "anthropic/claude-sonnet-4",
          ),
        }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              usageChunk({
                prompt_tokens: 100,
                total_tokens: 150,
                cost: 0.01234,
                prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: null },
              }),
            ),
          ),
        ),
      )

      expect(response.usage).toBeUndefined()
    }),
  )

  it.effect("keeps incomplete usage absent", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(sseEvents(deltaChunk({}, "stop"), usageChunk({ prompt_tokens: 5, total_tokens: 7 }))),
        ),
      )

      expect(response.usage).toBeUndefined()
      expect(response.events.flatMap((event) => ("usage" in event ? [event.usage] : [])).every((usage) => !usage)).toBe(
        true,
      )
    }),
  )

  it.effect("does not treat partial usage-only chunks as terminal", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents(usageChunk({ prompt_tokens: 5, total_tokens: 7 })))),
      )

      expect(response.usage).toBeUndefined()
      expect(response.events).toEqual([])
    }),
  )

  it.effect("does not retain non-terminal cumulative usage observations", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                choices: [{ delta: { content: "Hello" }, finish_reason: null }],
                usage: providerUsageFixtures.openai,
              },
              deltaChunk({}, "stop"),
            ),
          ),
        ),
      )

      expect(response.text).toBe("Hello")
      expect(response.usage).toBeUndefined()
      expect(response.events.flatMap((event) => ("usage" in event ? [event.usage] : [])).every((usage) => !usage)).toBe(
        true,
      )
    }),
  )

  it.effect("parses OpenAI-compatible reasoning content deltas", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { choices: [{ delta: { reasoning_content: "thinking" } }] },
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", text: "thinking" },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("assembles streamed tool call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
        deltaChunk({}, "tool_calls"),
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup", providerMetadata: undefined },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
        { type: "tool-input-end", id: "call_1", name: "lookup", providerMetadata: undefined },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage: undefined, providerMetadata: undefined },
        { type: "finish", reason: "tool-calls", usage: undefined },
      ])
    }),
  )

  it.effect("does not finalize streamed tool calls without a finish reason", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup", providerMetadata: undefined },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
      ])
      expect(response.toolCalls).toEqual([])
    }),
  )

  it.effect("fails on malformed stream events", () =>
    Effect.gen(function* () {
      const body = sseEvents(deltaChunk({ content: 123 }))
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error.message).toContain("Invalid openai/openai-chat stream event")
    }),
  )

  it.effect("emits one provider error when transport fails before terminal usage", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(truncatedStream([])))

      expect(response.events).toMatchObject([
        { type: "provider-error", message: "Failed to read openai/openai-chat stream", retryable: true },
      ])
      expect(response.events.filter((event) => event.type === "provider-error")).toHaveLength(1)
      expect(response.events.some((event) => event.type === "finish" || event.type === "step-finish")).toBeFalse()
      expect(response.usage).toBeUndefined()
    }),
  )

  it.effect("replaces a pending Chat terminal with one transport error carrying its usage", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          truncatedStream([
            sseEvents({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: providerUsageFixtures.openai,
            }),
          ]),
        ),
      )

      expect(response.events).toMatchObject([
        {
          type: "provider-error",
          message: "Failed to read openai/openai-chat stream",
          retryable: true,
          usage: {
            nonCachedInputTokens: 8,
            cacheReadInputTokens: 2,
            reasoningTokens: 7,
            providerTotalTokens: 22,
          },
        },
      ])
      expect(response.events.filter((event) => event.type === "provider-error")).toHaveLength(1)
      expect(response.events.some((event) => event.type === "finish" || event.type === "step-finish")).toBeFalse()
      expect(response.usage).toMatchObject({ nonCachedInputTokens: 8, providerTotalTokens: 22 })
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"message":"Bad request","type":"invalid_request_error"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("HTTP 400")
    }),
  )

  it.effect("short-circuits the upstream stream when the consumer takes a prefix", () =>
    Effect.gen(function* () {
      // The body has more chunks than we'll consume. If `Stream.take(1)` did
      // not interrupt the upstream HTTP body the test would hang waiting for
      // the rest of the stream to drain.
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        deltaChunk({ content: " world" }),
        deltaChunk({}, "stop"),
      )

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.take(1), Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      expect(events.map((event) => event.type)).toEqual(["step-start"])
    }),
  )
})
