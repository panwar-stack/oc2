import { describe, expect, test } from "bun:test"
import { CacheTelemetry } from "@oc2-ai/llm"
import { notification, shouldNotify } from "@oc2-ai/llm/cache/warnings"
import type { CachePlan } from "@oc2-ai/llm/cache/capability"

const plan = (patch: Partial<CachePlan> = {}): CachePlan => ({
  provider: "openai",
  model: "gpt-5",
  mode: "automatic",
  cacheKey: "oc2-cache-key",
  trafficPartition: null,
  stablePrefixFingerprint: "sha256:stable",
  componentFingerprints: { system: "sha256:system" },
  prefixTokenCount: 4096,
  minimumPrefixTokens: 1024,
  eligible: true,
  breakpoints: [],
  duration: null,
  ...patch,
})

describe("cache warning notifications", () => {
  test("notifies only for verified unexpected misses", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 4096,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupRequestNumber: 2,
    })

    expect(notification({ telemetry, plan: plan() })).toMatchObject({
      code: "unexpected_cache_miss",
      severity: "warning",
    })
    expect(shouldNotify({ telemetry, plan: plan() })).toBe(true)
  })

  test("suppresses first writes, warmup, below-threshold, expected, and unavailable telemetry", () => {
    expect(
      notification({
        telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 4096, cacheWriteTokens: 4096 }),
        plan: plan(),
      }),
    ).toBeNull()
    expect(
      notification({
        telemetry: CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 4096,
          cacheReadTokens: 0,
          warmupRequestNumber: 1,
        }),
        plan: plan(),
      }),
    ).toBeNull()
    expect(
      notification({
        telemetry: CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 512,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          warmupRequestNumber: 2,
        }),
        plan: plan({ prefixTokenCount: 512 }),
      }),
    ).toBeNull()
    expect(
      notification({
        telemetry: CacheTelemetry.normalize({ provider: "deepseek", model: "deepseek-chat", inputTokens: 4096, cacheReadTokens: 0 }),
        plan: plan({ provider: "deepseek", model: "deepseek-chat" }),
      }),
    ).toBeNull()
    expect(
      notification({
        telemetry: CacheTelemetry.normalize({ provider: "moonshot", model: "kimi-k2", inputTokens: 4096 }),
        plan: plan({ provider: "moonshot", model: "kimi-k2" }),
      }),
    ).toBeNull()
  })

  test("suppresses compaction, expected expiration, and best-effort single misses", () => {
    const telemetry = CacheTelemetry.normalize({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 4096,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      warmupRequestNumber: 2,
    })

    expect(notification({ telemetry, plan: plan(), compaction: true })).toBeNull()
    expect(notification({ telemetry, plan: plan(), expectedExpiration: true })).toBeNull()
    expect(notification({ telemetry, plan: plan(), bestEffortSingleMiss: true })).toBeNull()
  })

  test("notifies for invalid cache configuration and provider failures", () => {
    expect(notification({ configurationError: true })).toMatchObject({
      code: "cache_configuration_error",
      severity: "error",
    })
    expect(notification({ providerFailure: true })).toMatchObject({
      code: "provider_error",
      severity: "error",
    })
  })
})
