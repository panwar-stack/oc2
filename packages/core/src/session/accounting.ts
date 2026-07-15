import { ModelV2 } from "../model"

export type Usage = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

export type Pricing = {
  readonly source: "provider" | "catalog"
  readonly amount: number
  readonly providerAmount?: number
  readonly estimateAmount?: number
  readonly rate?: ModelV2.Cost
}

export const calculate = (input: {
  readonly model: {
    readonly cost: ReadonlyArray<ModelV2.Cost>
    readonly request?: { readonly variant?: string }
    readonly variants?: ReadonlyArray<{
      readonly id: string
      readonly cost?: ReadonlyArray<ModelV2.Cost>
    }>
  }
  readonly variant?: string
  readonly usage: Usage
  readonly providerAmount?: number
}): Pricing | undefined => {
  const variantID =
    input.variant === "default" || input.variant === undefined ? input.model.request?.variant : input.variant
  const rates = input.model.variants?.find((item) => item.id === variantID)?.cost ?? input.model.cost
  const context = input.usage.input + input.usage.cache.read + input.usage.cache.write
  const base = rates.find((item) => item.tier === undefined)
  const rate = rates.reduce<ModelV2.Cost | undefined>((selected, item) => {
    if (!item.tier || context <= item.tier.size) return selected
    if (!selected?.tier || item.tier.size > selected.tier.size) return item
    return selected
  }, base)
  const estimate = rate
    ? (input.usage.input * rate.input +
        input.usage.output * rate.output +
        input.usage.reasoning * rate.output +
        input.usage.cache.read * rate.cache.read +
        input.usage.cache.write * rate.cache.write) /
      1_000_000
    : undefined
  const estimateAmount = estimate === undefined ? undefined : Number.isFinite(estimate) ? Math.max(0, estimate) : 0
  const providerAmount =
    typeof input.providerAmount === "number" && Number.isFinite(input.providerAmount) && input.providerAmount >= 0
      ? input.providerAmount
      : undefined
  if (providerAmount !== undefined)
    return {
      source: "provider",
      amount: providerAmount,
      providerAmount,
      ...(estimateAmount === undefined ? {} : { estimateAmount, rate }),
    }
  if (estimateAmount === undefined || !rate) return undefined
  return { source: "catalog", amount: estimateAmount, estimateAmount, rate }
}

export * as SessionAccounting from "./accounting"
