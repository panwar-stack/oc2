import type { AssistantMessage } from "@oc2-ai/sdk/v2"

export function assistantTurnTokenCount(messages: readonly Pick<AssistantMessage, "tokens">[]) {
  return messages.reduce((sum, message) => {
    const usage = message.tokens
    return sum + (usage.total ?? usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write)
  }, 0)
}
