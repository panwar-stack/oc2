import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CacheHint, LLM, Message } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as AnthropicMessages from "../../src/protocols/anthropic-messages"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import { OpenAICompatible } from "../../src/providers"
import { it } from "../lib/effect"

const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const openaiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const kimiModel = OpenAICompatible.configure({
  provider: "moonshot",
  baseURL: "https://api.moonshot.test/v1",
  apiKey: "test",
}).model("kimi-k2")

const kimiAliasModel = OpenAICompatible.configure({
  provider: "kimi",
  baseURL: "https://api.kimi.test/v1",
  apiKey: "test",
}).model("kimi-latest")

const deepseekModel = OpenAICompatible.configure({
  provider: "deepseek",
  baseURL: "https://api.deepseek.test/v1",
  apiKey: "test",
}).model("deepseek-chat")

const unknownModel = OpenAICompatible.configure({
  provider: "future",
  baseURL: "https://api.future.test/v1",
  apiKey: "test",
}).model("future-model")

describe("provider cache lowering", () => {
  it.effect("OpenAI derives prompt_cache_key from the CachePlan", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openaiModel,
          system: [{ type: "text", text: "Stable system", metadata: { cache: { stable: true, version: 1 } } }],
          prompt: "hi",
          providerOptions: { openai: { promptCacheKey: "manual-key" } },
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({ prompt_cache_key: expect.stringMatching(/^oc2-v1-/) })
      expect((prepared.body as { prompt_cache_key?: string }).prompt_cache_key).not.toBe("manual-key")
      expect(JSON.stringify(prepared.body)).not.toContain("cache_control")
    }),
  )

  it.effect("Moonshot/Kimi, DeepSeek, and unknown models do not receive explicit cache fields", () =>
    Effect.gen(function* () {
      const kimi = yield* LLMClient.prepare(
        LLM.request({ model: kimiModel, system: "Stable system", prompt: "hi", cache: "auto" }),
      )
      const kimiAlias = yield* LLMClient.prepare(
        LLM.request({ model: kimiAliasModel, system: "Stable system", prompt: "hi", cache: "auto" }),
      )
      const deepseek = yield* LLMClient.prepare(
        LLM.request({
          model: deepseekModel,
          system: "Stable system",
          prompt: "hi",
          providerOptions: { openai: { promptCacheKey: "manual-key" } },
          cache: "auto",
        }),
      )
      const unknown = yield* LLMClient.prepare(
        LLM.request({
          model: unknownModel,
          system: "Stable system",
          prompt: "hi",
          providerOptions: { openai: { promptCacheKey: "manual-key" } },
          cache: "auto",
        }),
      )

      for (const body of [kimi.body, kimiAlias.body, deepseek.body, unknown.body]) {
        expect(JSON.stringify(body)).not.toContain("prompt_cache_key")
        expect(JSON.stringify(body)).not.toContain("cache_control")
      }
    }),
  )

  it.effect("Anthropic lowers CachePlan breakpoints and duration without inline hints", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            { type: "text", text: "Stable system", metadata: { cache: { stable: true, version: 1 } } },
            { type: "text", text: "Dynamic system" },
          ],
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          providerOptions: { openai: { promptCacheKey: "manual-key" } },
          cache: { tools: true, system: true, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral", ttl: "1h" } }],
        system: [
          { type: "text", text: "Stable system", cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: "Dynamic system", cache_control: undefined },
        ],
      })
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache_key")
    }),
  )

  it.effect("Anthropic still honors manual CacheHints when no CachePlan breakpoint exists", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [{ type: "text", text: "Manual", cache: new CacheHint({ type: "ephemeral" }) }],
          messages: [Message.user("hi")],
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Manual", cache_control: { type: "ephemeral" } }],
      })
    }),
  )

  it.effect("Anthropic does not apply CachePlan duration to manual CacheHints on non-planned blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [{ type: "text", text: "Stable system", metadata: { cache: { stable: true, version: 1 } } }],
          messages: [
            Message.user([
              { type: "text", text: "manual user hint", cache: new CacheHint({ type: "ephemeral" }) },
              { type: "text", text: "latest dynamic user" },
            ]),
          ],
          cache: { system: true, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Stable system", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "manual user hint", cache_control: { type: "ephemeral" } },
              { type: "text", text: "latest dynamic user", cache_control: undefined },
            ],
          },
        ],
      })
    }),
  )

  it.effect("Anthropic preserves manual CacheHint ttlSeconds on planned breakpoints", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            {
              type: "text",
              text: "Stable system",
              cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }),
              metadata: { cache: { stable: true, version: 1 } },
            },
          ],
          prompt: "hi",
          cache: { system: true, ttlSeconds: 300 },
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Stable system", cache_control: { type: "ephemeral", ttl: "1h" } }],
      })
    }),
  )
})
