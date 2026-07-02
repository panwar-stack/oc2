import { describe, expect, test } from "bun:test"
import { buildStatsQuery, toGeoAggregate, toModelAggregate, toProviderAggregate } from "./inference"
import { modelAuthor, normalizeInferenceModel, statModel, statProvider } from "./model-normalization"

describe("inference stat normalization", () => {
  test("normalizes model suffixes used by router/provider variants", () => {
    expect(normalizeInferenceModel("deepseek-v4-flash-free")).toBe("deepseek-v4-flash")
    expect(normalizeInferenceModel("deepseek-v4-flash:global")).toBe("deepseek-v4-flash")
    expect(normalizeInferenceModel("mimo-v2.5-free")).toBe("mimo-v2.5")
    expect(normalizeInferenceModel("nemotron-3-super-free")).toBe("nemotron-3-super")
    expect(normalizeInferenceModel("mimo-v2.5-free:global")).toBe("mimo-v2.5")
  })

  test("maps normalized model ids to public authors", () => {
    expect(modelAuthor("big-pickle")).toBe("unknown")
    expect(modelAuthor("claude-sonnet-4-5")).toBe("anthropic")
    expect(modelAuthor("deepseek-v4-pro")).toBe("deepseek")
    expect(modelAuthor("gemini-3.5-flash")).toBe("google")
    expect(modelAuthor("glm-5.1")).toBe("zhipu")
    expect(modelAuthor("gpt-5.5-pro")).toBe("openai")
    expect(modelAuthor("grok-build-0.1")).toBe("xai")
    expect(modelAuthor("hy3-preview")).toBe("tencent")
    expect(modelAuthor("kimi-k2.6")).toBe("moonshot")
    expect(modelAuthor("mimo-v2-omni")).toBe("xiaomi")
    expect(modelAuthor("minimax-m2.7")).toBe("minimax")
    expect(modelAuthor("nemotron-3-super-free")).toBe("nvidia")
    expect(modelAuthor("qwen3.7-max")).toBe("qwen")
    expect(modelAuthor("alpha-gpt-next")).toBeUndefined()
  })

  test("uses provider.model to resolve opencode route providers", () => {
    expect(statModel("big-pickle", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(statModel("big-pickle", "gpt-5-free")).toBe("gpt-5")
    expect(statModel("big-pickle", "")).toBe("unknown")
    expect(statProvider("big-pickle", "claude-sonnet-4-5", "opencode")).toBe("anthropic")
    expect(statProvider("big-pickle", "gpt-5", "opencode")).toBe("openai")
    expect(statProvider("big-pickle", "", "opencode")).toBe("unknown")
    expect(statProvider("unknown", "", "custom-provider")).toBe("custom-provider")
  })

  test("model aggregates prefer provider.model and use normalized model", () => {
    expect(toModelAggregate(aggregate("alpha-gpt-next", "openai"))).toEqual([])

    expect(toModelAggregate(aggregate("deepseek-v4-flash-free", "not-public-provider"))).toMatchObject([
      {
        period_key: "2026-05-20",
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
    ])

    expect(
      toModelAggregate({ ...aggregate("big-pickle", "opencode"), provider_model: "claude-sonnet-4-5" }),
    ).toMatchObject([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        provider_model: "claude-sonnet-4-5",
      },
    ])
  })

  test("provider aggregates never keep opencode as the provider", () => {
    expect(toProviderAggregate({ ...aggregate("big-pickle", "opencode"), provider_model: "gpt-5" })).toMatchObject([
      { provider: "openai" },
    ])
    expect(toProviderAggregate(aggregate("big-pickle", "opencode"))).toMatchObject([{ provider: "unknown" }])
  })

  test("geo aggregates never keep opencode or big-pickle dimensions", () => {
    expect(toGeoAggregate({ ...aggregate("big-pickle", "opencode"), country: "US" })).toMatchObject([
      { provider: "unknown", model: "unknown", country: "US" },
    ])
  })

  test("model aggregates use ISO week period keys", () => {
    expect(
      toModelAggregate({
        ...aggregate("gpt-5.5-pro", "openai"),
        grain: "week",
        period_key: "2026-W20",
      }),
    ).toMatchObject([{ period_key: "2026-W20" }])
  })

  test("aggregate query exposes cache write tokens separately", () => {
    process.env.SST_RESOURCE_App = "{}"
    process.env.SST_RESOURCE_InferenceEvent = JSON.stringify({ catalog: "catalog", database: "database", table: "table" })
    process.env.SST_RESOURCE_StatsSyncConfig = JSON.stringify({ dataset: "zen" })

    const query = buildStatsQuery(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-31T00:00:00Z"), "model")
    expect(query).toContain(
      "COALESCE(SUM(COALESCE(tokens_cache_write_5m, 0) + COALESCE(tokens_cache_write_1h, 0)), 0) AS cache_write_tokens",
    )
    expect(query).toContain(
      "tokens_cache_read,\n    tokens_cache_write_5m,\n    tokens_cache_write_1h,\n    COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_write_5m, 0) + COALESCE(tokens_cache_write_1h, 0) + COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) AS tokens_total",
    )
  })

  test("aggregates map cache write tokens separately from cache read tokens", () => {
    const row = {
      ...aggregate("gpt-5.5-pro", "openai"),
      cache_read_tokens: "10",
      cache_write_tokens: "7",
      total_tokens: "100",
    }

    expect(toModelAggregate(row)).toMatchObject([{ cache_read_tokens: 10, cache_write_tokens: 7, total_tokens: 100 }])
    expect(toProviderAggregate(row)).toMatchObject([{ cache_read_tokens: 10, cache_write_tokens: 7 }])
    expect(toGeoAggregate({ ...row, country: "US" })).toMatchObject([
      { cache_read_tokens: 10, cache_write_tokens: 7 },
    ])
  })
})

function aggregate(model: string, provider: string) {
  return {
    grain: "day",
    period_key: "2026-05-20",
    dataset: "zen",
    tier: "Paid",
    provider,
    model,
    sessions: "1",
    requests: "1",
    sample_count: "1",
  }
}
