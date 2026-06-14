import { ModelProviderError, type ModelEvent, type ModelTokenUsage, type ModelToolCall } from "./provider"

export interface CollectedModelStream {
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: readonly ModelToolCall[]
  readonly usage?: ModelTokenUsage
  readonly events: readonly ModelEvent[]
  readonly done: boolean
}

export const assertNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new ModelProviderError({ message: "Model request was cancelled", classification: "cancelled", retryable: false })
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    if (signal) {
      assertNotAborted(signal)
    }
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timeout: Timer | undefined
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
      }
      signal?.removeEventListener("abort", onAbort)
    }
    const onResolve = () => {
      cleanup()
      resolve()
    }
    const onAbort = () => {
      cleanup()
      reject(new ModelProviderError({ message: "Model request was cancelled", classification: "cancelled", retryable: false }))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    timeout = setTimeout(onResolve, ms)
  })
}

export async function* abortableModelStream(
  events: Iterable<ModelEvent>,
  signal: AbortSignal,
  delayMs = 0,
): AsyncIterable<ModelEvent> {
  for (const event of events) {
    assertNotAborted(signal)
    await sleep(delayMs, signal)
    assertNotAborted(signal)
    yield event
  }
}

export const collectModelStream = async (stream: AsyncIterable<ModelEvent>): Promise<CollectedModelStream> => {
  let text = ""
  let reasoning = ""
  let usage: ModelTokenUsage | undefined
  let done = false
  const toolCalls: ModelToolCall[] = []
  const events: ModelEvent[] = []

  for await (const event of stream) {
    events.push(event)
    switch (event.type) {
      case "text-delta":
        text += event.text
        break
      case "reasoning-delta":
        reasoning += event.text
        break
      case "tool-call":
        toolCalls.push(event.call)
        break
      case "usage":
        usage = event.usage
        break
      case "done":
        done = true
        break
    }
  }

  return { text, reasoning, toolCalls, usage, events, done }
}
