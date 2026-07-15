import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionAccounting } from "@oc2-ai/core/session/accounting"

const decode = Schema.decodeUnknownSync(ModelV2.Ref)

describe("ModelV2.Ref", () => {
  test("accepts a model selection without a variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic" })).toEqual({
      id: ModelV2.ID.make("claude-sonnet"),
      providerID: ProviderV2.ID.make("anthropic"),
    })
  })

  test("preserves an explicit model variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic", variant: "high" })).toEqual({
      id: ModelV2.ID.make("claude-sonnet"),
      providerID: ProviderV2.ID.make("anthropic"),
      variant: ModelV2.VariantID.make("high"),
    })
  })

  test("preserves optional variant pricing", () => {
    const base = ModelV2.Info.empty(ProviderV2.ID.make("anthropic"), ModelV2.ID.make("claude-sonnet"))
    const info = new ModelV2.Info({
      ...base,
      variants: [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: {},
          generation: {},
          options: {},
          cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }],
        },
        {
          id: ModelV2.VariantID.make("unpriced"),
          headers: {},
          body: {},
          generation: {},
          options: {},
        },
      ],
    })

    expect(info.variants[0]?.cost).toEqual([{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }])
    expect(info.variants[1]?.cost).toBeUndefined()
  })
})

describe("SessionAccounting.calculate", () => {
  const usage = (input: Partial<SessionAccounting.Usage> = {}): SessionAccounting.Usage => ({
    input: input.input ?? 0,
    output: input.output ?? 0,
    reasoning: input.reasoning ?? 0,
    cache: { read: input.cache?.read ?? 0, write: input.cache?.write ?? 0 },
  })
  const rate = (input: number, output: number, tier?: number): ModelV2.Cost => ({
    input,
    output,
    cache: { read: input / 10, write: input / 2 },
    ...(tier === undefined ? {} : { tier: { type: "context", size: tier } }),
  })

  test("prices disjoint cache and reasoning categories at their selected rates", () => {
    const selected = rate(2, 10)
    const result = SessionAccounting.calculate({
      model: { cost: [selected] },
      usage: usage({ input: 500_000, output: 100_000, reasoning: 50_000, cache: { read: 20_000, write: 10_000 } }),
    })

    expect(result).toEqual({
      source: "catalog",
      amount: 2.514,
      estimateAmount: 2.514,
      rate: selected,
    })
  })

  test("uses strict context thresholds, the greatest tier, and the first equal tier", () => {
    const base = rate(1, 1)
    const explicit200k = rate(2, 2, 200_000)
    const legacy200k = rate(20, 20, 200_000)
    const tier500k = rate(5, 5, 500_000)
    const model = { cost: [base, explicit200k, tier500k, legacy200k] }

    expect(
      SessionAccounting.calculate({
        model,
        usage: usage({ input: 150_000, cache: { read: 25_000, write: 25_000 } }),
      })?.rate,
    ).toBe(base)
    expect(
      SessionAccounting.calculate({
        model,
        usage: usage({ input: 150_001, cache: { read: 25_000, write: 25_000 } }),
      })?.rate,
    ).toBe(explicit200k)
    expect(SessionAccounting.calculate({ model, usage: usage({ input: 600_000 }) })?.rate).toBe(tier500k)
  })

  test("resolves explicit and default variants and falls back when a variant is unpriced", () => {
    const base = rate(1, 1)
    const high = rate(4, 8)
    const low = rate(0.5, 1)
    const model = {
      cost: [base],
      request: { variant: "high" },
      variants: [
        { id: "high", cost: [high] },
        { id: "low", cost: [low] },
        { id: "unpriced" },
      ],
    }

    expect(SessionAccounting.calculate({ model, usage: usage({ input: 1_000_000 }) })?.rate).toBe(high)
    expect(
      SessionAccounting.calculate({ model, variant: "default", usage: usage({ input: 1_000_000 }) })?.rate,
    ).toBe(high)
    expect(SessionAccounting.calculate({ model, variant: "low", usage: usage({ input: 1_000_000 }) })?.rate).toBe(low)
    expect(
      SessionAccounting.calculate({ model, variant: "unpriced", usage: usage({ input: 1_000_000 }) })?.rate,
    ).toBe(base)
  })

  test("prefers valid provider amounts while retaining the catalog estimate and rate", () => {
    const selected = rate(3, 15)
    const model = { cost: [selected] }
    const tokens = usage({ input: 1_000_000, output: 100_000 })

    expect(SessionAccounting.calculate({ model, usage: tokens, providerAmount: 0.25 })).toEqual({
      source: "provider",
      amount: 0.25,
      providerAmount: 0.25,
      estimateAmount: 4.5,
      rate: selected,
    })
    expect(SessionAccounting.calculate({ model, usage: tokens, providerAmount: Number.NaN })).toMatchObject({
      source: "catalog",
      amount: 4.5,
    })
    expect(SessionAccounting.calculate({ model: { cost: [] }, usage: tokens, providerAmount: -1 })).toBeUndefined()
  })
})
