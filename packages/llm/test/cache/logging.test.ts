import { describe, expect, test } from "bun:test"
import { CacheTelemetry } from "@oc2-ai/llm"
import { event } from "@oc2-ai/llm/cache/logging"
import type { CachePlan } from "@oc2-ai/llm/cache/capability"

const plan: CachePlan = {
  provider: "openai",
  model: "gpt-5",
  mode: "automatic",
  cacheKey: "oc2-cache-key",
  trafficPartition: "tenant-a",
  stablePrefixFingerprint: "sha256:stable",
  componentFingerprints: { system: "sha256:system", tools: "sha256:tools" },
  prefixTokenCount: 4096,
  minimumPrefixTokens: 1024,
  eligible: true,
  breakpoints: [],
  duration: null,
}

describe("cache invocation logging", () => {
  test("creates a structured cache event for a model invocation", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 4096,
      cacheReadTokens: 2048,
      cacheWriteTokens: 0,
      providerRawUsageFieldNames: ["prompt_tokens_details.cached_tokens"],
      estimatedCacheCost: 0.01,
      estimatedUncachedCost: 0.04,
    })

    expect(event({ requestID: "request-1", route: "openai-chat", plan, telemetry })).toEqual({
      type: "cache-invocation",
      requestID: "request-1",
      provider: "openai",
      model: "gpt-5",
      route: "openai-chat",
      mode: "automatic",
      eligible: true,
      classification: "cache_hit",
      verified: true,
      metricsAvailable: true,
      stablePrefixFingerprint: "sha256:stable",
      componentFingerprints: { system: "sha256:system", tools: "sha256:tools" },
      cacheKey: "oc2-cache-key",
      trafficPartition: "tenant-a",
      prefixTokenCount: 4096,
      minimumPrefixTokens: 1024,
      inputTokens: 4096,
      cacheReadTokens: 2048,
      cacheWriteTokens: 0,
      cacheMissTokens: null,
      uncachedInputTokens: 2048,
      providerRawUsageFieldNames: ["prompt_tokens_details.cached_tokens"],
      warmupRequestNumber: null,
      estimatedCacheCost: 0.01,
      estimatedUncachedCost: 0.04,
      estimatedSavings: 0.03,
      notification: null,
      diagnostic: null,
    })
  })

  test("includes warning notification only for verified unexpected misses", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 4096,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupRequestNumber: 2,
    })

    expect(event({ plan, telemetry }).notification).toMatchObject({ code: "unexpected_cache_miss" })
    expect(
      event({
        plan,
        telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 4096, cacheWriteTokens: 4096 }),
      }).notification,
    ).toBeNull()
  })

  test("honors explicit null notifications", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 4096,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupRequestNumber: 2,
    })

    expect(event({ plan, telemetry }).notification).toMatchObject({ code: "unexpected_cache_miss" })
    expect(event({ plan, telemetry, notification: null }).notification).toBeNull()
  })
})
