import { describe, expect, test } from "bun:test"
import { CacheTelemetry, LLMEvent } from "@oc2-ai/llm"

describe("cache telemetry classification", () => {
  test("preserves missing fields as null and derives uncached tokens only from reported fields", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 100,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    })

    expect(telemetry).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheMissTokens: null,
      uncachedInputTokens: null,
      metricsAvailable: false,
      classification: "cache_telemetry_unavailable",
    })
  })

  test("classifies cache hits and writes from reported positive fields", () => {
    expect(
      CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 100, cacheReadTokens: 40 })
        .classification,
    ).toBe("cache_hit")
    expect(
      CacheTelemetry.normalize({ provider: "anthropic", model: "claude-sonnet-4-5", inputTokens: 100, cacheWriteTokens: 40 })
        .classification,
    ).toBe("cache_write")
  })

  test("classifies unsupported, configuration, and provider errors", () => {
    expect(
      CacheTelemetry.normalize({ provider: "unknown", model: "future", inputTokens: 100, cacheReadTokens: 0 })
        .classification,
    ).toBe("cache_unsupported")
    expect(CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", configurationError: true }).classification).toBe(
      "cache_configuration_error",
    )
    expect(CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", providerError: true }).classification).toBe(
      "provider_error",
    )
  })

  test("provider and configuration errors override stale cache token evidence", () => {
    expect(
      CacheTelemetry.normalize({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 100,
        cacheReadTokens: 40,
        providerError: true,
      }),
    ).toMatchObject({ classification: "provider_error", verified: false })
    expect(
      CacheTelemetry.normalize({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 100,
        cacheWriteTokens: 40,
        configurationError: true,
      }),
    ).toMatchObject({ classification: "cache_configuration_error", verified: false })
  })

  test("provider error events force cache telemetry classification on usage", () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      nonCachedInputTokens: 60,
      cacheReadInputTokens: 40,
      cacheTelemetry: CacheTelemetry.normalize({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 100,
        cacheReadTokens: 40,
      }),
    }

    expect(LLMEvent.providerError({ message: "failed", usage }).usage?.cacheTelemetry).toMatchObject({
      classification: "provider_error",
      verified: false,
    })
    expect(
      LLMEvent.providerError({ message: "too long", classification: "context-overflow", usage }).usage?.cacheTelemetry,
    ).toMatchObject({
      classification: "cache_configuration_error",
      verified: false,
    })
  })

  test("treats Moonshot telemetry absence as unavailable and unverified", () => {
    const telemetry = CacheTelemetry.normalize({ provider: "moonshot", model: "kimi-k2", inputTokens: 100 })

    expect(telemetry.classification).toBe("cache_telemetry_unavailable")
    expect(telemetry.verified).toBe(false)
    expect(telemetry.metricsAvailable).toBe(false)
  })

  test("classifies conclusive zero-read misses as unexpected after warmup", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupRequestNumber: 2,
    })

    expect(telemetry.classification).toBe("unexpected_cache_miss")
    expect(telemetry.verified).toBe(true)
    expect(telemetry.uncachedInputTokens).toBe(100)
  })

  test("keeps DeepSeek misses expected during warmup and without strong evidence", () => {
    expect(
      CacheTelemetry.normalize({
        provider: "deepseek",
        model: "deepseek-chat",
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheMissTokens: 100,
        warmupRequestNumber: 1,
      }).classification,
    ).toBe("expected_cache_miss")
    expect(
      CacheTelemetry.normalize({
        provider: "deepseek",
        model: "deepseek-chat",
        inputTokens: 100,
        cacheReadTokens: 0,
        warmupRequestNumber: 2,
      }).classification,
    ).toBe("expected_cache_miss")
    expect(
      CacheTelemetry.normalize({
        provider: "deepseek",
        model: "deepseek-chat",
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheMissTokens: 100,
      }).classification,
    ).toBe("expected_cache_miss")
  })

  test("classifies DeepSeek reported misses as unexpected only after warmup", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "deepseek",
      model: "deepseek-chat",
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheMissTokens: 100,
      warmupRequestNumber: 2,
    })

    expect(telemetry.classification).toBe("unexpected_cache_miss")
    expect(telemetry.uncachedInputTokens).toBe(100)
  })

  test("preserves DeepSeek reported zero miss telemetry", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "deepseek",
      model: "deepseek-chat",
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheMissTokens: 0,
      warmupRequestNumber: 2,
    })

    expect(telemetry).toMatchObject({
      cacheMissTokens: 0,
      uncachedInputTokens: 0,
      metricsAvailable: true,
      classification: "expected_cache_miss",
    })
  })
})
