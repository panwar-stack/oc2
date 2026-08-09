import type { AssistantMessage, Message } from "@oc2-ai/sdk/v2"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const cacheStatusLabels = {
  cache_hit: "hit",
  cache_write: "write",
  expected_cache_miss: "expected miss",
  unexpected_cache_miss: "unexpected miss",
  cache_unsupported: "unsupported",
  cache_telemetry_unavailable: "unavailable",
  cache_configuration_error: "error",
  provider_error: "error",
} satisfies Record<NonNullable<AssistantMessage["cacheStatus"]>["classification"], string>

export function consumedTokens(tokens: AssistantMessage["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function currentContextMessage(messages: readonly Message[]): AssistantMessage | undefined {
  return messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant" && consumedTokens(message.tokens) > 0,
  )
}

export function formatCacheStatus(messages: readonly Message[]): string | undefined {
  const last = currentContextMessage(messages)
  if (!last) return undefined

  const totals = messages.reduce(
    (result, message) => {
      if (message.role !== "assistant") return result
      const input = validTokens(message.tokens.input)
      const read = validTokens(message.tokens.cache.read)
      const write = validTokens(message.tokens.cache.write)
      result.input += input
      result.read += read
      result.write += write

      if (read + write === 0) return result
      const savings = message.cacheStatus?.savings
      if (typeof savings !== "number" || !Number.isFinite(savings)) result.savingsAvailable = false
      else if (message.cacheStatus?.classification !== "unexpected_cache_miss" || savings < 0) result.savings += savings
      return result
    },
    { input: 0, read: 0, write: 0, savings: 0, savingsAvailable: true },
  )
  const prompt = totals.input + totals.read + totals.write
  const rate = (totals.read / prompt) * 100
  const hitRate = prompt > 0 ? `${Math.min(rate, totals.read < prompt ? 99.9 : 100).toFixed(1)}% cached` : undefined
  const savingsText = !totals.savingsAvailable
    ? undefined
    : totals.savings > 0
      ? `saved ${money.format(totals.savings)}`
      : totals.savings < 0
        ? `extra ${money.format(-totals.savings)}`
        : undefined
  const parts = [
    last.cacheStatus ? cacheStatusLabels[last.cacheStatus.classification] : undefined,
    hitRate,
    savingsText,
  ].filter((part): part is string => !!part)

  return parts.length > 0 ? `cache ${parts.join(" · ")}` : undefined
}

function validTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}
