import type { ModelContext, ModelEvent, ModelInfo, ModelProvider, ModelRequest } from "../../src/model/provider"

export interface ScriptedProvider extends ModelProvider {
  readonly requests: ModelRequest[]
}

/** Creates a deterministic provider that consumes one event batch per model request. */
export function createScriptedModelProvider(
  batches: readonly (readonly ModelEvent[])[],
  options: {
    readonly delayMs?: number
    readonly id?: string
    readonly name?: string
    readonly models?: readonly ModelInfo[]
  } = {},
): ScriptedProvider {
  const requests: ModelRequest[] = []
  return {
    id: options.id ?? "fake",
    name: options.name ?? "Scripted Fake",
    requests,
    async listModels(): Promise<readonly ModelInfo[]> {
      return options.models ?? [{ id: "test", supportsTools: true }]
    },
    async *stream(request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {
      requests.push(request)
      const batch = batches[Math.min(requests.length - 1, batches.length - 1)] ?? []
      for (const event of batch) {
        if (options.delayMs) await Bun.sleep(options.delayMs)
        if (request.signal.aborted) throw request.signal.reason
        yield event
      }
    },
  }
}

export const simpleAssistantEvents: readonly ModelEvent[] = [
  { type: "text-delta", text: "fake response" },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
  { type: "done" },
]
