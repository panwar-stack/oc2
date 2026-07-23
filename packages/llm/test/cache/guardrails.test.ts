import { describe, expect, test } from "bun:test"
import type { CachePlan } from "@oc2-ai/llm/cache/capability"
import {
  checkBreakpointOverflow,
  checkIncompatibleCacheKeyReuse,
  checkInvalidDuration,
  checkProviderFieldLeakage,
  checkRetryPrefixChange,
  checkUnsupportedFields,
  checkUnstablePrefixChange,
  combine,
} from "@oc2-ai/llm/cache/guardrails"

const breakpoints = (count: number): CachePlan["breakpoints"] =>
  Array.from({ length: count }, (_, index) => ({ component: "system", contentType: "system", index }))

describe("cache guardrails", () => {
  test("fails only definitely unsupported provider request fields", () => {
    const openai = checkUnsupportedFields({ provider: "openai", model: "gpt-5", fields: ["prompt_cache_key"] })
    const anthropic = checkUnsupportedFields({ provider: "anthropic", model: "claude-sonnet-4-5", fields: ["prompt_cache_key"] })
    const unknown = checkUnsupportedFields({ provider: "future", model: "future-model", fields: ["cache_control"] })

    expect(openai).toMatchObject({ valid: true, errors: [] })
    expect(anthropic).toMatchObject({
      valid: false,
      errors: [{ code: "unsupported_field", severity: "error", field: "prompt_cache_key" }],
    })
    expect(unknown).toMatchObject({
      valid: true,
      warnings: [{ code: "unsupported_field", severity: "warning", field: "cache_control" }],
    })
  })

  test("rejects invalid or provider-unsupported durations", () => {
    expect(checkInvalidDuration({ provider: "anthropic", model: "claude-sonnet-4-5", duration: "1h" })).toMatchObject({
      valid: true,
    })
    expect(checkInvalidDuration({ provider: "anthropic", model: "claude-sonnet-4-5", duration: "30m" })).toMatchObject({
      valid: false,
      errors: [{ code: "invalid_duration", severity: "error" }],
    })
    expect(checkInvalidDuration({ provider: "openai", model: "gpt-5", duration: "1h" })).toMatchObject({
      valid: false,
      errors: [{ code: "invalid_duration", severity: "error" }],
    })
    expect(checkInvalidDuration({ provider: "future", model: "future-model", duration: "1h" })).toMatchObject({
      valid: true,
      warnings: [{ code: "invalid_duration", severity: "warning" }],
    })
  })

  test("warns rather than fails when breakpoint count exceeds provider cap", () => {
    const result = checkBreakpointOverflow({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      breakpoints: breakpoints(5),
    })

    expect(result).toMatchObject({
      valid: true,
      warnings: [{ code: "breakpoint_overflow", severity: "warning" }],
      errors: [],
    })
  })

  test("fails provider field leakage across provider families", () => {
    const result = checkProviderFieldLeakage({ provider: "deepseek", model: "deepseek-chat", fields: ["prompt_cache_key"] })

    expect(result).toMatchObject({
      valid: false,
      errors: [{ code: "provider_field_leakage", severity: "error", field: "prompt_cache_key" }],
    })
  })

  test("fails incompatible cache key reuse", () => {
    const result = checkIncompatibleCacheKeyReuse({
      previous: {
        provider: "openai",
        model: "gpt-5",
        cacheKey: "shared-key",
        stablePrefixFingerprint: "fp-a",
        trafficPartition: null,
      },
      current: {
        provider: "openai",
        model: "gpt-5",
        cacheKey: "shared-key",
        stablePrefixFingerprint: "fp-b",
        trafficPartition: null,
      },
    })

    expect(result).toMatchObject({
      valid: false,
      errors: [{ code: "incompatible_cache_key_reuse", severity: "error", field: "cacheKey" }],
    })
  })

  test("warns for unstable prefix changes and retry prefix changes", () => {
    const previous = {
      provider: "openai",
      model: "gpt-5",
      stablePrefixFingerprint: "fp-a",
      trafficPartition: "tenant-a",
      componentFingerprints: { system: "sys-a", tools: "tools-a" },
    }
    const current = {
      provider: "openai",
      model: "gpt-5",
      stablePrefixFingerprint: "fp-b",
      trafficPartition: "tenant-a",
      componentFingerprints: { system: "sys-b", tools: "tools-a" },
    }

    expect(checkUnstablePrefixChange({ previous, current })).toMatchObject({
      valid: true,
      warnings: [{ code: "unstable_prefix_change", severity: "warning" }],
    })
    expect(checkRetryPrefixChange({ original: previous, retry: current, retryID: "prompt-1" })).toMatchObject({
      valid: true,
      warnings: [{ code: "retry_prefix_change", severity: "warning" }],
    })
  })

  test("combines errors and warnings without losing validity", () => {
    const result = combine(
      checkBreakpointOverflow({ provider: "anthropic", model: "claude-sonnet-4-5", breakpoints: breakpoints(5) }),
      checkProviderFieldLeakage({ provider: "deepseek", model: "deepseek-chat", fields: ["cache_control"] }),
    )

    expect(result.valid).toBe(false)
    expect(result.warnings.map((item) => item.code)).toEqual(["breakpoint_overflow"])
    expect(result.errors.map((item) => item.code)).toEqual(["provider_field_leakage"])
  })
})
