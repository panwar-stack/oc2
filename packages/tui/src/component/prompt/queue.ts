import type { Prompt } from "@oc2-ai/sdk/v2"
import { Identifier } from "@oc2-ai/core/util/identifier"
import type { PromptInfo } from "../../prompt/history"

export function createQueueInputID() {
  return `msg_${Identifier.ascending()}`
}

export function toQueuedPrompt(text: string, parts: readonly PromptInfo["parts"][number][]): Prompt {
  const files = parts.flatMap((part) => {
    if (part.type !== "file") return []
    const source = part.source && "text" in part.source ? part.source.text : undefined
    return [
      {
        uri: part.url,
        mime: part.mime,
        name: part.filename,
        source: source ? { start: source.start, end: source.end, text: source.value } : undefined,
      },
    ]
  })
  const agents = parts.flatMap((part) =>
    part.type === "agent"
      ? [
          {
            name: part.name,
            source: part.source
              ? { start: part.source.start, end: part.source.end, text: part.source.value }
              : undefined,
          },
        ]
      : [],
  )
  return {
    text,
    files: files.length > 0 ? files : undefined,
    agents: agents.length > 0 ? agents : undefined,
  }
}

export function nextQueueAttempt(
  current: { id: string; key: string } | undefined,
  prompt: Prompt,
  createID: () => string,
) {
  const key = JSON.stringify(prompt)
  return current?.key === key ? current : { id: createID(), key }
}

export function acceptPendingSnapshot<T extends { revision: number }>(current: T | undefined, next: T) {
  return current && current.revision > next.revision ? current : next
}
