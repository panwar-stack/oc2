import { abortableModelStream } from "./stream"
import { ModelProviderError, type ModelContext, type ModelEvent, type ModelInfo, type ModelProvider, type ModelRequest } from "./provider"

export interface FakeModelProviderOptions {
  readonly id?: string
  readonly name?: string
  readonly models?: readonly ModelInfo[]
  readonly events?: readonly ModelEvent[]
  readonly delayMs?: number
  readonly failWith?: unknown
}

const defaultFakeEvents: readonly ModelEvent[] = [
  { type: "text-delta", text: "fake response" },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
  { type: "done" },
]

export class FakeModelProvider implements ModelProvider {
  readonly id: string
  readonly name: string
  private readonly models: readonly ModelInfo[]
  private readonly events: readonly ModelEvent[]
  private readonly delayMs: number
  private readonly failWith?: unknown

  constructor(options: FakeModelProviderOptions = {}) {
    this.id = options.id ?? "fake"
    this.name = options.name ?? "Fake"
    this.models = options.models ?? [{ id: "test", name: "Fake Test", supportsReasoning: true, supportsTools: true }]
    this.events = options.events ?? defaultFakeEvents
    this.delayMs = options.delayMs ?? 0
    this.failWith = options.failWith
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models
  }

  async *stream(request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {
    if (this.failWith !== undefined) {
      throw this.failWith instanceof Error
        ? this.failWith
        : new ModelProviderError({ message: String(this.failWith), classification: "unknown" })
    }

    yield* abortableModelStream(this.events, request.signal, this.delayMs)
  }
}

export const createFakeModelProvider = (options?: FakeModelProviderOptions): FakeModelProvider => new FakeModelProvider(options)
