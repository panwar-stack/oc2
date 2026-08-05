import { describe, expect, test } from "bun:test"
import { Auth, LLM, Message } from "@oc2-ai/llm"
import { planCache, planCacheRequest } from "@oc2-ai/llm/cache/planner"
import * as AnthropicMessages from "@oc2-ai/llm/protocols/anthropic-messages"
import * as OpenAIResponses from "@oc2-ai/llm/protocols/openai-responses"

const openaiModel = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-5" })

const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const anthropicResponsesModel = OpenAIResponses.route
  .with({
    provider: "anthropic",
    endpoint: { baseURL: "https://api.anthropic.test/v1/" },
    auth: Auth.header("x-api-key", "test"),
  })
  .model({ id: "claude-sonnet-4-5" })

describe("cache planner", () => {
  test("separates stable system and tools from dynamic user turn content", () => {
    const planned = planCache({
      provider: "openai",
      model: "gpt-5",
      cachePolicy: "auto",
      system: [
        { type: "text", text: "stable repo", metadata: { cache: { stable: true, version: 1, fingerprint: "repo-v1" } } },
        { type: "text", text: "today", metadata: { cache: { stable: false, version: 1 } } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "do the task" }] },
        { role: "assistant", content: [{ type: "tool-call", id: "call", name: "read", input: { path: "a.ts" } }] },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "call", name: "read", result: { type: "text", value: "secret" } }],
        },
      ],
      tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
    })

    expect(planned.stable).toEqual({ system: [0], tools: [0], messages: [] })
    expect(planned.dynamic).toEqual({ system: [1], tools: [], messages: [0, 1, 2] })
    expect(planned.plan.mode).toBe("automatic")
    expect(planned.plan.cacheKey).toMatch(/^oc2-v1-[0-9a-f]{64}$/)
    expect(planned.plan.breakpoints).toEqual([])
    expect(planned.plan.stablePrefixFingerprint).not.toContain("do the task")
    expect(planned.plan.stablePrefixFingerprint).not.toContain("secret")
  })

  test("treats unmarked system parts as dynamic by default", () => {
    const planned = planCache({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      routeID: "anthropic-messages",
      cachePolicy: "auto",
      system: [
        { type: "text", text: "stable repo", metadata: { cache: { stable: true, version: 1 } } },
        { type: "text", text: "Generated at 2026-07-22T12:00:00Z" },
      ],
    })

    expect(planned.stable.system).toEqual([0])
    expect(planned.dynamic.system).toEqual([1])
    expect(planned.plan.breakpoints).toEqual([{ component: "system", contentType: "system", index: 0 }])
    expect(planned.plan.componentFingerprints.system).not.toContain("2026-07-22")
  })

  test("request-level planning excludes unmarked system strings from cacheable sections", () => {
    const planned = planCacheRequest(
      LLM.request({
        model: anthropicModel,
        system: "Generated at 2026-07-22T12:00:00Z",
        prompt: "hi",
        cache: "auto",
      }),
    )

    expect(planned.stable.system).toEqual([])
    expect(planned.dynamic.system).toEqual([0])
    expect(planned.plan.eligible).toBe(false)
    expect(planned.plan.breakpoints).toEqual([])
    expect(planned.plan.componentFingerprints.system).not.toContain("2026-07-22")
  })

  test("dynamic messages do not affect stable prefix fingerprint", () => {
    const base = planCache({
      provider: "openai",
      model: "gpt-5",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
    })
    const changed = planCache({
      provider: "openai",
      model: "gpt-5",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    })

    expect(changed.plan.stablePrefixFingerprint).toBe(base.plan.stablePrefixFingerprint)
    expect(changed.plan.cacheKey).toBe(base.plan.cacheKey)
  })

  test("OpenAI-compatible GPT-like providers get OpenAI cache keys", () => {
    const planned = planCache({
      provider: "github-copilot",
      model: "gpt-5.5",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
    })

    expect(planned.plan).toMatchObject({
      provider: "github-copilot",
      model: "gpt-5.5",
      mode: "automatic",
      eligible: true,
      minimumPrefixTokens: 1024,
    })
    expect(planned.plan.cacheKey).toMatch(/^oc2-v1-[0-9a-f]{64}$/)
  })

  test("volatile cache routing fields do not affect stable prefix fingerprint", () => {
    const base = planCache({
      provider: "openai",
      model: "gpt-5",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
      providerConfig: { openai: { promptCacheKey: "session-a", requestID: "req-a", store: false } },
    })
    const changed = planCache({
      provider: "openai",
      model: "gpt-5",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
      providerConfig: { openai: { promptCacheKey: "session-b", requestID: "req-b", store: false } },
    })

    expect(changed.plan.stablePrefixFingerprint).toBe(base.plan.stablePrefixFingerprint)
    expect(changed.plan.componentFingerprints.providerConfig).toBe(base.plan.componentFingerprints.providerConfig)
  })

  test("marked stable system messages can participate but ordinary user messages cannot", () => {
    const planned = planCache({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      routeID: "anthropic-messages",
      cachePolicy: { messages: { tail: 3 } },
      messages: [
        { role: "system", metadata: { cache: { stable: true, version: 1 } }, content: [{ type: "text", text: "stable" }] },
        { role: "user", metadata: { cache: { stable: true, version: 1 } }, content: [{ type: "text", text: "user" }] },
      ],
    })

    expect(planned.stable.messages).toEqual([0])
    expect(planned.dynamic.messages).toEqual([1])
    expect(planned.plan.breakpoints).toEqual([{ component: "messages", contentType: "message", index: 0 }])
  })

  test("plans automatic request caching and inline breakpoints for Anthropic", () => {
    const planned = planCacheRequest(
      LLM.request({
        model: anthropicModel,
        system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
        tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
        messages: [Message.user("dynamic user")],
        cache: { tools: true, system: true, messages: "latest-user-message", ttlSeconds: 3600 },
      }),
    )

    expect(planned.plan.mode).toBe("automatic_and_explicit")
    expect(planned.plan.duration).toBe("1h")
    expect(planned.plan.requestCacheControl).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(planned.plan.breakpoints).toEqual([
      { component: "tools", contentType: "tool", index: 0 },
      { component: "system", contentType: "system", index: 0 },
    ])
    expect(planned.stable.messages).toEqual([])
    expect(planned.dynamic.messages).toEqual([0])
  })

  test("defaults Anthropic request cache control to implicit 5m TTL", () => {
    const planned = planCache({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      protocolID: "anthropic-messages",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
    })

    expect(planned.plan).toMatchObject({
      mode: "automatic_and_explicit",
      duration: "5m",
      requestCacheControl: { type: "ephemeral" },
    })
    expect(planned.plan.requestCacheControl).not.toHaveProperty("ttl")
  })

  test("keeps four explicit Anthropic slots and skips automatic request caching", () => {
    const planned = planCache({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      protocolID: "anthropic-messages",
      cachePolicy: "auto",
      system: Array.from({ length: 4 }, (_, index) => ({
        type: "text",
        text: `stable-${index}`,
        cache: { type: "ephemeral" },
        metadata: { cache: { stable: true, version: 1 } },
      })),
    })

    expect(planned.plan.mode).toBe("explicit")
    expect(planned.plan.requestCacheControl).toBeUndefined()
    expect(planned.plan.breakpoints).toEqual([{ component: "system", contentType: "system", index: 3 }])
  })

  test("accepts three distinct explicit slots plus automatic caching and deduplicates planned boundaries", () => {
    const planned = planCache({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      protocolID: "anthropic-messages",
      cachePolicy: { tools: true, system: true, messages: { tail: 1 } },
      tools: [{ name: "read", description: "Read", inputSchema: {}, cache: { type: "ephemeral" } }],
      system: [
        {
          type: "text",
          text: "stable system",
          cache: { type: "ephemeral" },
          metadata: { cache: { stable: true, version: 1 } },
        },
      ],
      messages: [
        {
          role: "system",
          metadata: { cache: { stable: true, version: 1 } },
          content: [{ type: "text", text: "stable message", cache: { type: "ephemeral" } }],
        },
      ],
    })

    expect(planned.plan.mode).toBe("automatic_and_explicit")
    expect(planned.plan.requestCacheControl).toEqual({ type: "ephemeral" })
    expect(planned.plan.breakpoints).toEqual([
      { component: "tools", contentType: "tool", index: 0 },
      { component: "system", contentType: "system", index: 0 },
      { component: "messages", contentType: "message", index: 0 },
    ])
  })

  test("does not plan automatic Anthropic caching on unsupported protocols", () => {
    const planned = planCacheRequest(
      LLM.request({
        model: anthropicResponsesModel,
        system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
        prompt: "hi",
        cache: "auto",
      }),
    )

    expect(planned.plan.mode).toBe("explicit")
    expect(planned.plan.requestCacheControl).toBeUndefined()
  })

  test("does not plan Anthropic request cache control for non-Anthropic providers", () => {
    const planned = planCache({
      provider: "openai",
      model: "gpt-5",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
    })

    expect(planned.plan.mode).toBe("automatic")
    expect(planned.plan.requestCacheControl).toBeUndefined()
  })

  test("plans explicit breakpoints for Alibaba Qwen models", () => {
    const planned = planCache({
      provider: "alibaba",
      model: "qwen-plus",
      protocolID: "openai-chat",
      cachePolicy: { system: true, tools: true, messages: "latest-user-message" },
      system: [{ type: "text", text: "SYS", metadata: { cache: { stable: true } } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Q" }] }],
      tools: [],
    })

    expect(planned.plan).toMatchObject({
      provider: "alibaba",
      model: "qwen-plus",
      mode: "explicit",
      eligible: true,
      minimumPrefixTokens: 1024,
    })
    expect(planned.plan.breakpoints).toEqual([{ component: "system", contentType: "system", index: 0 }])
    expect(planned.plan.requestCacheControl).toBeUndefined()
    expect(planned.plan.duration).toBeNull()
    expect(planned.plan.cacheKey).toBeNull()
  })

  test("unknown provider plans stay disabled", () => {
    const planned = planCache({
      provider: "alibaba",
      model: "non-qwen-model",
      protocolID: "openai-chat",
      cachePolicy: { system: true, tools: true, messages: "latest-user-message" },
      system: [{ type: "text", text: "SYS", metadata: { cache: { stable: true } } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Q" }] }],
      tools: [],
    })

    expect(planned.plan.mode).toBe("disabled")
    expect(planned.plan.eligible).toBe(false)
    expect(planned.plan.breakpoints).toEqual([])
  })

  test("unknown models are conservative but still get non-content fingerprints", () => {
    const planned = planCache({
      provider: "unknown-provider",
      model: "future-model",
      cachePolicy: "auto",
      system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
    })

    expect(planned.plan.mode).toBe("disabled")
    expect(planned.plan.eligible).toBe(false)
    expect(planned.plan.cacheKey).toBeNull()
    expect(planned.plan.minimumPrefixTokens).toBeNull()
    expect(planned.plan.stablePrefixFingerprint).toMatch(/^cache:stable-prefix:v1:sha256:[0-9a-f]{64}$/)
  })
})
