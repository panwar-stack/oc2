import { describe, expect, test } from "bun:test"
import type { CachePlan } from "@oc2-ai/llm/cache/capability"
import { createRegressionChecker, createStore, type CacheExpectationKey } from "@oc2-ai/llm/cache/state"
import { CacheTelemetry } from "@oc2-ai/llm/cache/telemetry"

const plan = (input: Partial<CachePlan> & Pick<CachePlan, "provider" | "model" | "stablePrefixFingerprint">): CachePlan => ({
  mode: "automatic",
  cacheKey: `key-${input.stablePrefixFingerprint}`,
  trafficPartition: null,
  componentFingerprints: { system: `system-${input.stablePrefixFingerprint}` },
  prefixTokenCount: null,
  minimumPrefixTokens: null,
  eligible: true,
  breakpoints: [],
  duration: null,
  ...input,
})

const key = (item: CachePlan): CacheExpectationKey => ({
  provider: item.provider,
  model: item.model,
  stablePrefixFingerprint: item.stablePrefixFingerprint,
  trafficPartition: item.trafficPartition,
})

describe("cache expectation state", () => {
  test("tracks first and last observation, eligible requests, reads, writes, misses, and warmup", () => {
    let now = 1_000
    const store = createStore({ now: () => now })
    const item = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-a" })

    const first = store.observe({
      plan: item,
      telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 100, cacheWriteTokens: 70 }),
    })

    expect(first).toMatchObject({
      firstObservedAt: 1_000,
      lastObservedAt: 1_000,
      eligibleRequestCount: 1,
      readCount: 0,
      writeCount: 1,
      missCount: 0,
      telemetryGapCount: 0,
      warmup: { policy: "first_request", requests: 1, remaining: 0, active: true },
    })

    now = 2_000
    const second = store.observe({
      plan: item,
      telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 100, cacheReadTokens: 70 }),
    })

    expect(second).toMatchObject({
      firstObservedAt: 1_000,
      lastObservedAt: 2_000,
      eligibleRequestCount: 2,
      readCount: 1,
      writeCount: 1,
      missCount: 0,
      warmup: { active: false, remaining: 0 },
    })
    expect(store.get(key(item))).toMatchObject({ lastObservedAt: 2_000 })
  })

  test("records misses, telemetry gaps, expiration warnings, and bounded warnings", () => {
    let now = 10_000
    const store = createStore({ maxWarningsPerEntry: 2, now: () => now })
    const item = plan({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      mode: "explicit",
      stablePrefixFingerprint: "fp-expire",
      duration: "5m",
      breakpoints: [{ component: "system", contentType: "system", index: 0 }],
    })

    store.observe({
      plan: item,
      telemetry: CacheTelemetry.normalize({ provider: "anthropic", model: "claude-sonnet-4-5", inputTokens: 100, cacheWriteTokens: 80 }),
    })
    now = 311_000
    const gap = store.observe({
      plan: item,
      telemetry: CacheTelemetry.normalize({ provider: "anthropic", model: "claude-sonnet-4-5", inputTokens: 100 }),
      warnings: [{ code: "unexpected_miss", message: "manual warning" }],
    })

    expect(gap.missCount).toBe(0)
    expect(gap.telemetryGapCount).toBe(1)
    expect(gap.expiration).toMatchObject({ policy: "fixed", seconds: 300, expiredBeforeObservation: true })
    expect(gap.warnings.map((warning) => warning.code)).toEqual(["expiration", "telemetry_gap"])

    now = 312_000
    const miss = store.observe({
      plan: item,
      telemetry: CacheTelemetry.normalize({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        warmupRequestNumber: 2,
      }),
    })

    expect(miss.missCount).toBe(1)
    expect(miss.telemetryGapCount).toBe(1)
    expect(miss.warnings.map((warning) => warning.code)).toEqual(["telemetry_gap", "unexpected_miss"])
  })

  test("bounds entries and uses traffic partition as part of the key", () => {
    const store = createStore({ maxEntries: 2 })
    const a = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-a", trafficPartition: "p1" })
    const b = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-a", trafficPartition: "p2" })
    const c = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-c", trafficPartition: "p1" })

    store.observe({ plan: a })
    store.observe({ plan: b })
    expect(store.get(key(a))).toBeDefined()
    store.observe({ plan: c })

    expect(store.size()).toBe(2)
    expect(store.get(key(a))).toBeDefined()
    expect(store.get(key(b))).toBeUndefined()
    expect(store.get(key(c))).toBeDefined()
  })

  test("warns when configuration fingerprints change for an existing expectation key", () => {
    const store = createStore()
    const item = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-config" })

    store.observe({ plan: item, configurationFingerprints: { route: "a" } })
    const changed = store.observe({ plan: item, configurationFingerprints: { route: "b" } })

    expect(changed.configurationFingerprints.route).toBe("b")
    expect(changed.warnings.at(-1)).toMatchObject({ code: "configuration_change", observedAt: expect.any(Number) })
  })

  test("classifies runtime expectations without storing prompt content", () => {
    const checker = createRegressionChecker()
    const item = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-runtime" })

    checker.register({ sessionID: "ses-runtime", requestID: "msg-1", plan: item })
    expect(
      checker.complete({
        sessionID: "ses-runtime",
        requestID: "msg-1",
        plan: item,
        telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 100, cacheWriteTokens: 70 }),
      }),
    ).toMatchObject({
      status: "warmup",
      sessionID: "ses-runtime",
      providerID: "openai",
      modelID: "gpt-5",
      stablePrefixHash: "fp-runtime",
      cacheStatus: "cache_write",
      cacheWriteTokens: 70,
    })

    const miss = checker.complete({
      sessionID: "ses-runtime",
      requestID: "msg-2",
      plan: item,
      telemetry: CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    })

    expect(miss.status).toBe("unexpected_miss")
    expect(miss.diagnostic).toMatchObject({ stablePrefixFingerprint: "fp-runtime" })
    expect(JSON.stringify(miss)).not.toContain("secret prompt")
    expect(JSON.stringify(miss)).not.toContain("secret message")
  })

  test("keeps expected misses authoritative before telemetry availability", () => {
    const checker = createRegressionChecker()
    const item = plan({ provider: "openai", model: "gpt-5", stablePrefixFingerprint: "fp-expected" })

    checker.register({ sessionID: "ses-runtime", plan: item })

    expect(
      checker.complete({
        sessionID: "ses-runtime",
        plan: item,
        telemetry: null,
        expectedMiss: true,
      }),
    ).toMatchObject({ status: "expected_miss", cacheStatus: "cache_telemetry_unavailable" })
  })

  test("marks retry and compaction telemetry as expected without losing provider errors", () => {
    expect(
      CacheTelemetry.withExpectedMiss(
        CacheTelemetry.normalize({
          provider: "openai",
          model: "gpt-5",
          inputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          warmupRequestNumber: 2,
        }),
        { provider: "openai", model: "gpt-5" },
      ),
    ).toMatchObject({ expected: true, classification: "expected_cache_miss", verified: false })
    expect(
      CacheTelemetry.withExpectedMiss(
        CacheTelemetry.normalize({ provider: "openai", model: "gpt-5", providerError: true }),
        { provider: "openai", model: "gpt-5" },
      ),
    ).toMatchObject({ expected: true, classification: "provider_error", verified: false })
  })
})
