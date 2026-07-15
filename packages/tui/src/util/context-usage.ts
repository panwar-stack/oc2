import type { AssistantMessage, Message } from "@oc2-ai/sdk/v2"

export function consumedTokens(tokens: AssistantMessage["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function currentContextMessage(messages: readonly Message[]): AssistantMessage | undefined {
  return messages.findLast(
    (message): message is AssistantMessage => message.role === "assistant" && consumedTokens(message.tokens) > 0,
  )
}
