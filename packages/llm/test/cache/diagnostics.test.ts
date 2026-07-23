import { describe, expect, test } from "bun:test"
import { CacheTelemetry } from "@oc2-ai/llm"
import { diagnoseUnexpectedMiss } from "@oc2-ai/llm/cache/diagnostics"
import type { CachePlan } from "@oc2-ai/llm/cache/capability"

const current: CachePlan = {
  provider: "openai",
  model: "gpt-5",
  mode: "automatic",
  cacheKey: "oc2-cache-key",
  trafficPartition: null,
  stablePrefixFingerprint: "sha256:current",
  componentFingerprints: { system: "sha256:system-current", tools: "sha256:tools" },
  prefixTokenCount: 4096,
  minimumPrefixTokens: 1024,
  eligible: true,
  breakpoints: [],
  duration: null,
}

const previous: CachePlan = {
  ...current,
  stablePrefixFingerprint: "sha256:previous",
  componentFingerprints: { system: "sha256:system-previous", tools: "sha256:tools" },
}

describe("cache diagnostics", () => {
  test("builds safe diagnostics for verified unexpected misses without prompt content", () => {
    const diagnostic = diagnoseUnexpectedMiss({
      plan: current,
      previous,
      telemetry: CacheTelemetry.normalize({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 4096,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        warmupRequestNumber: 2,
      }),
    })

    expect(diagnostic).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      classification: "unexpected_cache_miss",
      stablePrefixFingerprint: "sha256:current",
      previousStablePrefixFingerprint: "sha256:previous",
      reason: "Stable prefix fingerprint changed before an expected cache hit.",
    })
    expect(diagnostic?.components).toEqual([
      { component: "system", fingerprint: "sha256:system-current", previousFingerprint: "sha256:system-previous", changed: true },
      { component: "tools", fingerprint: "sha256:tools", previousFingerprint: "sha256:tools", changed: false },
    ])
    expect(JSON.stringify(diagnostic)).not.toContain("You are")
    expect(JSON.stringify(diagnostic)).not.toContain("secret prompt")
  })

  test("returns null for expected misses and cache writes", () => {
    expect(
      diagnoseUnexpectedMiss({
        plan: current,
        telemetry: CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 4096,
          cacheReadTokens: 0,
          warmupRequestNumber: 1,
        }),
      }),
    ).toBeNull()
    expect(
      diagnoseUnexpectedMiss({
        plan: current,
        telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 4096, cacheWriteTokens: 4096 }),
      }),
    ).toBeNull()
  })
})
