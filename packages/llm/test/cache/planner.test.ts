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

  test("plans inline breakpoints for explicit Anthropic cache policy", () => {
    const planned = planCacheRequest(
      LLM.request({
        model: anthropicModel,
        system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
        tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {} } }],
        messages: [Message.user("dynamic user")],
        cache: { tools: true, system: true, messages: "latest-user-message", ttlSeconds: 3600 },
      }),
    )

    expect(planned.plan.mode).toBe("explicit")
    expect(planned.plan.duration).toBe("1h")
    expect(planned.plan.breakpoints).toEqual([
      { component: "tools", contentType: "tool", index: 0 },
      { component: "system", contentType: "system", index: 0 },
    ])
    expect(planned.stable.messages).toEqual([])
    expect(planned.dynamic.messages).toEqual([0])
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
