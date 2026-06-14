import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import type { TaskScheduler } from "../scheduler/scheduler"
import { createFakeModelProvider } from "./fake-provider"
import { collectModelStream, type CollectedModelStream } from "./stream"
import {
  toModelProviderError,
  type ModelContext,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
} from "./provider"

export interface ModelServiceOptions {
  readonly providers?: readonly ModelProvider[]
  readonly events?: RuntimeEventBus<unknown>
  readonly scheduler?: TaskScheduler
}

export interface ModelService {
  register(provider: ModelProvider): void
  get(providerId: string): ModelProvider | undefined
  listProviders(): readonly ModelProvider[]
  listModels(providerId: string): Promise<readonly ModelInfo[]>
  stream(providerId: string, request: ModelRequest): AsyncIterable<ModelEvent>
  collect(providerId: string, request: ModelRequest): Promise<CollectedModelStream>
}

export const createModelContext = (providerId: string): ModelContext => ({
  requestId: crypto.randomUUID(),
  providerId,
  startedAt: new Date(),
})

export const createModelService = (options: ModelServiceOptions = {}): ModelService => {
  const providers = new Map<string, ModelProvider>()
  const initialProviders = options.providers?.length ? options.providers : [createFakeModelProvider()]
  for (const provider of initialProviders) {
    providers.set(provider.id, provider)
  }

  const requireProvider = (providerId: string): ModelProvider => {
    const provider = providers.get(providerId)
    if (!provider) {
      throw new RuntimeError({
        code: "unknown",
        message: `Unknown model provider: ${providerId}`,
        recoverable: true,
        details: { providerId },
      })
    }
    return provider
  }

  async function* streamFromProvider(providerId: string, request: ModelRequest): AsyncIterable<ModelEvent> {
    const provider = requireProvider(providerId)
    const context = createModelContext(providerId)
    options.events?.publish({
      type: "model.started",
      payload: { sessionId: request.sessionId, taskId: context.requestId, model: request.modelId },
    })

    try {
      for await (const event of provider.stream(request, context)) {
        if (event.type === "text-delta" || event.type === "reasoning-delta") {
          options.events?.publish({
            type: "model.delta",
            payload: { sessionId: request.sessionId, taskId: context.requestId, delta: event.text, modelEvent: event },
          })
        }
        yield event
      }
      options.events?.publish({ type: "model.completed", payload: { sessionId: request.sessionId, taskId: context.requestId } })
    } catch (error) {
      const providerError = toModelProviderError(error, providerId)
      const safeError = providerError.toJSON()
      const runtimeError = new RuntimeError({
        code: providerError.classification === "cancelled" ? "cancelled" : "task_failed",
        message: safeError.message,
        recoverable: providerError.retryable,
        details: { ...safeError },
        taskId: context.requestId,
        kind: "model",
      })
      options.events?.publish({
        type: "model.failed",
        payload: { sessionId: request.sessionId, taskId: context.requestId, error: runtimeError.toJSON() },
      })
      throw providerError
    }
  }

  const collect = async (providerId: string, request: ModelRequest): Promise<CollectedModelStream> => {
    if (!options.scheduler) {
      return collectModelStream(streamFromProvider(providerId, request))
    }
    const handle = options.scheduler.schedule({
      kind: "model",
      timeoutMs: request.providerOptions?.timeoutMs as number | undefined,
      parent: request.signal,
      run: async ({ signal }) => {
        const controller = new AbortController()
        const onAbort = () => controller.abort(signal.reason)
        try {
          if (request.signal.aborted || signal.aborted) {
            controller.abort(request.signal.reason ?? signal.reason)
          }
          request.signal.addEventListener("abort", onAbort, { once: true })
          signal.addEventListener("abort", onAbort, { once: true })
          const scheduledRequest = { ...request, signal: controller.signal }
          return await collectModelStream(streamFromProvider(providerId, scheduledRequest))
        } finally {
          request.signal.removeEventListener("abort", onAbort)
          signal.removeEventListener("abort", onAbort)
        }
      },
    })
    const result = await handle.result
    if ("error" in result) {
      throw result.error
    }
    if (result.value === undefined) {
      throw new RuntimeError({ code: "unknown", message: "Model task completed without a result", kind: "model" })
    }
    return result.value
  }

  return {
    register(provider: ModelProvider): void {
      providers.set(provider.id, provider)
    },
    get(providerId: string): ModelProvider | undefined {
      return providers.get(providerId)
    },
    listProviders(): readonly ModelProvider[] {
      return [...providers.values()]
    },
    listModels(providerId: string): Promise<readonly ModelInfo[]> {
      return requireProvider(providerId).listModels()
    },
    stream(providerId: string, request: ModelRequest): AsyncIterable<ModelEvent> {
      return streamFromProvider(providerId, request)
    },
    collect,
  }
}
