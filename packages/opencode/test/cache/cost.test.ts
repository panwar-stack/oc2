import { describe, expect, test } from "bun:test"
import { CacheTelemetry, Usage } from "@oc2-ai/llm"
import { Session } from "@/session/session"
import type { Provider } from "@/provider/provider"

const model = (input: {
  providerID: string
  id: string
  cost: Provider.Model["cost"]
}): Provider.Model =>
  ({
    id: input.id,
    providerID: input.providerID,
    name: input.id,
    limit: { context: 128_000, output: 16_000 },
    cost: input.cost,
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    api: { npm: "@ai-sdk/openai" },
    options: {},
    headers: {},
    release_date: "",
  }) as Provider.Model

const priced = model({
  providerID: "openai",
  id: "gpt-5",
  cost: { input: 10, output: 0, cache: { read: 1, write: 12 } },
})

describe("cache cost accounting", () => {
  test("adds provider/model-matched cache cost impact to telemetry", () => {
    const result = Session.getUsage({
      model: priced,
      usage: new Usage({
        inputTokens: 1000,
        outputTokens: 0,
        nonCachedInputTokens: 400,
        cacheReadInputTokens: 600,
        cacheTelemetry: CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 1000,
          cacheReadTokens: 600,
        }),
      }),
    })

    expect(result.cost).toBe(0.0046)
    expect(result.cacheTelemetry).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      estimatedCacheCost: 0.0046,
      estimatedUncachedCost: 0.01,
      estimatedSavings: 0.0054,
    })
  })

  test("keeps cost impact unavailable when telemetry is missing or belongs to another provider", () => {
    expect(
      Session.getUsage({
        model: priced,
        usage: new Usage({ inputTokens: 1000, outputTokens: 0 }),
      }).cacheTelemetry,
    ).toBeUndefined()

    const result = Session.getUsage({
      model: priced,
      usage: new Usage({
        inputTokens: 1000,
        outputTokens: 0,
        nonCachedInputTokens: 400,
        cacheReadInputTokens: 600,
        cacheTelemetry: CacheTelemetry.normalize({
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          inputTokens: 1000,
          cacheReadTokens: 600,
        }),
      }),
    })

    expect(result.cacheTelemetry).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      estimatedCacheCost: null,
      estimatedUncachedCost: null,
      estimatedSavings: null,
    })
  })

  test("reports unexpected miss impact when provider telemetry and pricing are calculable", () => {
    const result = Session.getUsage({
      model: priced,
      usage: new Usage({
        inputTokens: 1000,
        outputTokens: 0,
        nonCachedInputTokens: 1000,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        cacheTelemetry: CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          warmupRequestNumber: 2,
        }),
      }),
    })

    expect(result.cacheTelemetry).toMatchObject({
      classification: "unexpected_cache_miss",
      estimatedCacheCost: 0.001,
      estimatedUncachedCost: 0.01,
      estimatedSavings: 0.009,
    })
  })

  test("allows negative savings when cache writes cost more than uncached input", () => {
    const result = Session.getUsage({
      model: priced,
      usage: new Usage({
        inputTokens: 1000,
        outputTokens: 0,
        nonCachedInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 1000,
        cacheTelemetry: CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 1000,
          cacheReadTokens: 0,
          cacheWriteTokens: 1000,
        }),
      }),
    })

    expect(result.cacheTelemetry).toMatchObject({
      estimatedCacheCost: 0.012,
      estimatedUncachedCost: 0.01,
      estimatedSavings: -0.002,
    })
  })
})
