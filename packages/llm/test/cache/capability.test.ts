import { describe, expect, test } from "bun:test"
import {
  CACHE_CAPABILITY_VERSION,
  cacheCapabilityRecords,
  getCacheCapabilities,
  getUnknownCacheCapabilities,
  unknownCacheCapabilities,
  type CacheClassification,
  type CacheDiagnostic,
  type CachePlan,
  type CacheTelemetry,
} from "@oc2-ai/llm/cache/capability"

describe("cache capability registry", () => {
  test("publishes versioned records for the PR1 providers", () => {
    expect([...new Set(cacheCapabilityRecords.map((record) => record.provider))]).toEqual([
      "openai",
      "anthropic",
      "moonshot",
      "deepseek",
    ])
    expect(cacheCapabilityRecords.every((record) => record.version === CACHE_CAPABILITY_VERSION)).toBe(true)
  })

  test("OpenAI supports automatic caching with explicit routing keys but no breakpoints", () => {
    const capabilities = getCacheCapabilities("openai", "gpt-4o-mini")

    expect(capabilities).toMatchObject({
      status: "known",
      promptCaching: "automatic_and_explicit",
      supportsCacheKey: true,
      supportsBreakpoints: false,
      supportsDuration: false,
      minimumPrefixTokens: 1024,
      reportsCacheReadTokens: true,
      reportsCacheWriteTokens: true,
      reportsCacheMissTokens: false,
      telemetryUnavailable: false,
      requestFields: ["prompt_cache_key"],
      responseUsageFields: [
        "input_tokens_details.cached_tokens",
        "input_tokens_details.cache_write_tokens",
        "prompt_tokens_details.cached_tokens",
        "prompt_tokens_details.cache_write_tokens",
      ],
    })
  })

  test("OpenAI gpt-5 models use the known prompt caching capabilities", () => {
    const gpt5 = getCacheCapabilities("openai", "gpt-5")
    const gpt55 = getCacheCapabilities("openai", "gpt-5.5")

    expect(gpt5).toBe(gpt55)
    expect(gpt55).toMatchObject({
      status: "known",
      modelPattern: "gpt-4.1*|gpt-4o*|gpt-5*|o1*|o3*|o4*",
      promptCaching: "automatic_and_explicit",
      supportsCacheKey: true,
      minimumPrefixTokens: 1024,
      requestFields: ["prompt_cache_key"],
    })
  })

  test("Anthropic supports explicit cache breakpoints and durations", () => {
    const capabilities = getCacheCapabilities("anthropic", "claude-sonnet-4-5")

    expect(capabilities).toMatchObject({
      status: "known",
      promptCaching: "explicit",
      supportsCacheKey: false,
      supportsBreakpoints: true,
      supportsDuration: true,
      minimumPrefixTokens: 1024,
      maximumBreakpoints: 4,
      supportedDurations: ["5m", "1h"],
      requestFields: ["cache_control"],
      responseUsageFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
    })
  })

  test("Anthropic Haiku models use the provider-specific minimum prefix threshold", () => {
    const haiku = getCacheCapabilities("anthropic", "claude-3-haiku-20240307")
    const sonnet = getCacheCapabilities("anthropic", "claude-sonnet-4-5")

    expect(haiku).not.toBe(sonnet)
    expect(haiku).toMatchObject({
      status: "known",
      modelPattern: "claude-*haiku*",
      promptCaching: "explicit",
      supportsBreakpoints: true,
      minimumPrefixTokens: 2048,
      requestFields: ["cache_control"],
    })
    expect(sonnet.minimumPrefixTokens).toBe(1024)
  })

  test("Moonshot AI and Kimi are provider-managed and telemetry-unavailable", () => {
    const capabilities = getCacheCapabilities("moonshot", "kimi-k2-0711-preview")
    const kimiAlias = getCacheCapabilities("kimi", "kimi-latest")

    expect(capabilities).toMatchObject({
      status: "known",
      promptCaching: "automatic",
      supportsCacheKey: false,
      supportsBreakpoints: false,
      telemetryUnavailable: true,
      requestFields: [],
      responseUsageFields: [],
      conclusiveVerification: false,
    })
    expect(kimiAlias).toBe(capabilities)
  })

  test("DeepSeek is automatic best-effort with hit and miss telemetry", () => {
    const capabilities = getCacheCapabilities("deepseek", "deepseek-chat")

    expect(capabilities).toMatchObject({
      status: "known",
      promptCaching: "automatic",
      supportsCacheKey: false,
      supportsBreakpoints: false,
      reportsCacheReadTokens: true,
      reportsCacheWriteTokens: false,
      reportsCacheMissTokens: true,
      responseUsageFields: ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"],
      conclusiveVerification: false,
    })
  })

  test("unknown models are conservative", () => {
    const capabilities = getCacheCapabilities("openai", "future-model")

    expect(capabilities).toEqual({
      ...unknownCacheCapabilities,
      provider: "openai",
      modelPattern: "future-model",
    })
    expect(capabilities).toEqual(getUnknownCacheCapabilities("openai", "future-model"))
    expect(capabilities).toMatchObject({
      status: "unknown",
      promptCaching: "unsupported",
      supportsCacheKey: false,
      supportsBreakpoints: false,
      minimumPrefixTokens: null,
      requestFields: [],
      conclusiveVerification: false,
    })
  })

  test("shared diagnostic, plan, telemetry, and classification types are usable", () => {
    const classification: CacheClassification = "cache_telemetry_unavailable"
    const plan: CachePlan = {
      provider: "moonshot",
      model: "kimi-k2",
      mode: "automatic",
      cacheKey: null,
      trafficPartition: null,
      stablePrefixFingerprint: "prefix:v1:fixture",
      componentFingerprints: { system: "component:v1:system" },
      prefixTokenCount: null,
      minimumPrefixTokens: null,
      eligible: true,
      breakpoints: [],
      duration: null,
    }
    const telemetry: CacheTelemetry = {
      provider: "moonshot",
      model: "kimi-k2",
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheMissTokens: null,
      uncachedInputTokens: null,
      metricsAvailable: false,
      eligible: true,
      expected: false,
      verified: false,
      classification,
      providerRawUsageFieldNames: [],
      warmupRequestNumber: null,
      estimatedCacheCost: null,
      estimatedUncachedCost: null,
      estimatedSavings: null,
    }
    const diagnostic: CacheDiagnostic = {
      provider: plan.provider,
      model: plan.model,
      classification,
      stablePrefixFingerprint: plan.stablePrefixFingerprint,
      previousStablePrefixFingerprint: null,
      components: [
        { component: "system", fingerprint: "component:v1:system", previousFingerprint: null, changed: false },
      ],
      reason: "provider telemetry is unavailable",
      correctiveAction: null,
    }

    expect(telemetry.classification).toBe(classification)
    expect(diagnostic.components[0]?.fingerprint).toBe(plan.componentFingerprints.system)
  })
})
