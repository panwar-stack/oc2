import type { AssistantMessage, Message } from "@oc2-ai/sdk/v2"
import { Locale } from "./locale"

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

export function formatCacheStatus(
  status: AssistantMessage["cacheStatus"] | undefined,
  tokens: AssistantMessage["tokens"] | undefined,
): string | undefined {
  const read = status?.read ?? tokens?.cache.read ?? 0
  const write = status?.write ?? tokens?.cache.write ?? 0
  const tokenText =
    read > 0 && write > 0
      ? `${Locale.number(read)} read/${Locale.number(write)} write`
      : read > 0
        ? `${Locale.number(read)} read`
        : write > 0
          ? `${Locale.number(write)} write`
          : undefined
  const savingsText = status?.savings && status.savings > 0 ? `saved ${money.format(status.savings)}` : undefined
  const parts = [status ? cacheStatusLabels[status.classification] : undefined, tokenText, savingsText].filter(
    (part): part is string => !!part,
  )

  return parts.length > 0 ? `cache ${parts.join(" · ")}` : undefined
}
