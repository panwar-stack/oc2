import { describe, expect, test } from "bun:test"
import type { CacheDiagnostic, CachePlan, CacheTelemetry } from "@oc2-ai/llm/cache/capability"
import type { CacheRegressionResult } from "@oc2-ai/llm/cache/state"
import { createPolicy } from "@oc2-ai/llm/cache/self-healing"

const plan = (input: Partial<CachePlan> = {}): CachePlan => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  mode: "explicit",
  cacheKey: "oc2-v1-stable-a",
  trafficPartition: null,
  stablePrefixFingerprint: "stable:a",
  componentFingerprints: { system: "system:a", tools: "tools:a", schemas: "schemas:a" },
  prefixTokenCount: null,
  minimumPrefixTokens: 1024,
  eligible: true,
  breakpoints: [{ component: "system", contentType: "system", index: 0 }],
  duration: "5m",
  ...input,
})

const result = (input: Partial<CacheRegressionResult> = {}): CacheRegressionResult => ({
  status: "unexpected_miss",
  sessionID: "ses",
  requestID: "msg",
  providerID: "anthropic",
  modelID: "claude-sonnet-4-5",
  stablePrefixHash: "stable:a",
  cacheStatus: "unexpected_cache_miss",
  ...input,
})

const telemetry = (classification: CacheTelemetry["classification"]): CacheTelemetry => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  inputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheMissTokens: null,
  uncachedInputTokens: null,
  metricsAvailable: true,
  eligible: true,
  expected: false,
  verified: true,
  classification,
  providerRawUsageFieldNames: [],
  warmupRequestNumber: 2,
  estimatedCacheCost: null,
  estimatedUncachedCost: null,
  estimatedSavings: null,
})

const diagnostic = (input: Partial<CacheDiagnostic> = {}): CacheDiagnostic => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  classification: "unexpected_cache_miss",
  stablePrefixFingerprint: "stable:a",
  previousStablePrefixFingerprint: "stable:previous",
  components: [
    { component: "system", fingerprint: "system:b", previousFingerprint: "system:a", changed: true },
    { component: "schemas", fingerprint: "schemas:b", previousFingerprint: "schemas:a", changed: true },
  ],
  reason: "Stable prefix fingerprint changed before an expected cache hit.",
  correctiveAction: null,
  ...input,
})

describe("cache self-healing policy", () => {
  test("defaults off while retaining counters for audit snapshots", () => {
    const policy = createPolicy()
    const item = plan()

    policy.observe({ result: result({ diagnostic: diagnostic() }), plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 1 })
    const decision = policy.observe({
      result: result({ diagnostic: diagnostic() }),
      plan: item,
      telemetry: telemetry("unexpected_cache_miss"),
      observedAt: 2,
    })

    expect(decision.mode).toBe("off")
    expect(decision.actions).toEqual([])
    expect(decision.counters.some((counter) => counter.reason === "stable_prefix_mismatch" && counter.count === 2)).toBe(true)
    expect(policy.applyPlan(item, 2)).toBe(item)
  })

  test("observes repeated provider errors without altering future plans", () => {
    const policy = createPolicy({ mode: "observe", providerErrorThreshold: 2, now: () => 1_000 })
    const item = plan()
    const providerError = result({ status: "inconclusive", cacheStatus: "provider_error" })

    expect(policy.observe({ result: providerError, plan: item, telemetry: telemetry("provider_error") }).actions).toEqual([])
    const decision = policy.observe({ result: providerError, plan: item, telemetry: telemetry("provider_error") })

    expect(decision.actions).toMatchObject([
      {
        kind: "disable_explicit_cache",
        reason: "provider_error",
        label: "prompt_cache.disable_explicit.provider_error",
        enforced: false,
      },
    ])
    expect(policy.applyPlan(item)).toBe(item)
  })

  test("can enforce temporary explicit-cache disablement only for future explicit plans", () => {
    const policy = createPolicy({ mode: "enforce", providerErrorThreshold: 2, actionTtlMs: 100, now: () => 1_000 })
    const item = plan()
    const providerError = result({ status: "inconclusive", cacheStatus: "provider_error" })

    policy.observe({ result: providerError, plan: item, telemetry: telemetry("provider_error") })
    policy.observe({ result: providerError, plan: item, telemetry: telemetry("provider_error") })

    expect(policy.applyPlan(item, 1_050)).toMatchObject({ mode: "disabled", eligible: false, cacheKey: null, breakpoints: [] })
    expect(policy.applyPlan(item, 1_101)).toBe(item)
    expect(policy.applyPlan(plan({ mode: "automatic" }), 1_050).mode).toBe("automatic")
  })

  test("rotates cache-key partition for future plans after repeated stable-prefix mismatches", () => {
    const policy = createPolicy({ mode: "enforce", repeatedMissThreshold: 2, maxCacheKeyLength: 40 })
    const item = plan({ provider: "openai", model: "gpt-5", mode: "automatic", cacheKey: "oc2-v1-abcdefghijklmnopqrstuvwxyz" })
    const miss = result({ providerID: "openai", modelID: "gpt-5", diagnostic: diagnostic({ provider: "openai", model: "gpt-5" }) })

    policy.observe({ result: miss, plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 1 })
    const decision = policy.observe({ result: miss, plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 2 })
    const action = decision.actions.find((candidate) => candidate.kind === "rotate_cache_partition")
    const patched = policy.applyPlan(item, 2)

    expect(action).toMatchObject({ reason: "stable_prefix_mismatch", enforced: true })
    expect(action?.partition).toBeDefined()
    const partition = action?.partition ?? "missing"
    expect(patched.trafficPartition).toBe(partition)
    expect(patched.cacheKey).toContain(`:${partition}`)
    expect(patched.cacheKey?.length).toBeLessThanOrEqual(40)
  })

  test("emits corrective labels for schema churn and volatile prefix with cooldown", () => {
    const policy = createPolicy({ mode: "observe", repeatedMissThreshold: 2, cooldownMs: 100 })
    const item = plan()
    const miss = result({ diagnostic: diagnostic() })

    policy.observe({ result: miss, plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 1 })
    const emitted = policy.observe({ result: miss, plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 2 })
    const cooledDown = policy.observe({ result: miss, plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 3 })
    const afterCooldown = policy.observe({ result: miss, plan: item, telemetry: telemetry("unexpected_cache_miss"), observedAt: 103 })

    expect(emitted.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "emit_warning", reason: "schema_churn", correctiveLabel: "prompt_cache.schema_churn.stabilize_tool_schema_order" }),
        expect.objectContaining({ kind: "emit_warning", reason: "volatile_prefix", correctiveLabel: "prompt_cache.volatile_prefix.move_dynamic_content_after_boundary" }),
      ]),
    )
    expect(cooledDown.actions.filter((action) => action.kind === "emit_warning")).toEqual([])
    expect(afterCooldown.actions.filter((action) => action.kind === "emit_warning")).toHaveLength(2)
  })
})
