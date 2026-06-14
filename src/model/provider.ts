import { redactText } from "../logging/redaction"

/** Role names normalized across provider APIs before request adaptation. */
export type ModelMessageRole = "system" | "user" | "assistant" | "tool"

export interface ModelMessage {
  readonly id?: string
  readonly role: ModelMessageRole
  readonly content: string
  readonly toolCallId?: string
}

export interface ModelToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

export interface ModelToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ModelTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export interface ModelInfo {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly supportsTools?: boolean
  readonly supportsReasoning?: boolean
}

/** Provider-agnostic request shape consumed by every model backend. */
export interface ModelRequest {
  readonly sessionId: string
  readonly modelId: string
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly signal: AbortSignal
  readonly providerOptions?: Record<string, unknown>
}

export interface ModelContext {
  readonly requestId: string
  readonly providerId: string
  readonly startedAt: Date
  readonly metadata?: Record<string, unknown>
}

/** Incremental events emitted by providers while a model response streams. */
export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCall }
  | { readonly type: "usage"; readonly usage: ModelTokenUsage }
  | { readonly type: "done" }

export type ModelErrorClassification =
  | "cancelled"
  | "auth"
  | "rate_limit"
  | "quota"
  | "provider_unavailable"
  | "transient_network"
  | "invalid_request"
  | "context_overflow"
  | "content_policy"
  | "schema"
  | "unknown"

export interface ClassifiedModelError {
  readonly name: "ModelProviderError"
  readonly message: string
  readonly classification: ModelErrorClassification
  readonly retryable: boolean
  readonly providerId?: string
  readonly status?: number
}

/** Error wrapper that keeps provider failures classified and safe to persist/log. */
export class ModelProviderError extends Error implements ClassifiedModelError {
  override readonly name = "ModelProviderError"
  readonly classification: ModelErrorClassification
  readonly retryable: boolean
  readonly providerId?: string
  readonly status?: number
  override readonly cause?: unknown

  constructor(input: {
    readonly message: string
    readonly classification?: ModelErrorClassification
    readonly retryable?: boolean
    readonly providerId?: string
    readonly status?: number
    readonly cause?: unknown
  }) {
    super(input.message)
    this.classification = input.classification ?? classifyModelError(input.cause ?? input.status ?? input.message)
    this.retryable = input.retryable ?? isRetryableClassification(this.classification)
    this.providerId = input.providerId
    this.status = input.status
    this.cause = input.cause
  }

  toJSON(): ClassifiedModelError {
    return {
      name: this.name,
      message: redactText(this.message),
      classification: this.classification,
      retryable: this.retryable,
      providerId: this.providerId,
      status: this.status,
    }
  }
}

/** Minimal contract implemented by local, fake, and remote model providers. */
export interface ModelProvider {
  readonly id: string
  readonly name: string
  listModels(): Promise<readonly ModelInfo[]>
  stream(request: ModelRequest, context: ModelContext): AsyncIterable<ModelEvent>
}

/** Returns whether the classified provider failure is likely to succeed on retry. */
export const isRetryableClassification = (classification: ModelErrorClassification): boolean =>
  classification === "rate_limit" || classification === "provider_unavailable" || classification === "transient_network"

/** Best-effort classifier for heterogeneous provider, HTTP, DOM, and thrown errors. */
export const classifyModelError = (error: unknown): ModelErrorClassification => {
  if (error instanceof ModelProviderError) {
    return error.classification
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "cancelled"
  }
  if (typeof error === "object" && error !== null) {
    const status = "status" in error && typeof error.status === "number" ? error.status : undefined
    const code = "code" in error && typeof error.code === "string" ? error.code.toLowerCase() : ""
    if (status === 401 || status === 403 || code.includes("auth") || code.includes("permission")) {
      return "auth"
    }
    if (status === 429 || code.includes("rate")) {
      return "rate_limit"
    }
    if (status === 402 || code.includes("quota")) {
      return "quota"
    }
    if (status === 400 || status === 422 || code.includes("invalid")) {
      return "invalid_request"
    }
    if (status === 413 || code.includes("context") || code.includes("token")) {
      return "context_overflow"
    }
    if (status !== undefined && status >= 500) {
      return "provider_unavailable"
    }
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes("abort") || message.includes("cancel")) {
    return "cancelled"
  }
  if (message.includes("api key") || message.includes("unauthorized") || message.includes("auth")) {
    return "auth"
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limit"
  }
  if (message.includes("quota")) {
    return "quota"
  }
  if (message.includes("content policy") || message.includes("safety")) {
    return "content_policy"
  }
  if (message.includes("schema") || message.includes("tool validation")) {
    return "schema"
  }
  if (message.includes("context") || message.includes("token limit")) {
    return "context_overflow"
  }
  if (message.includes("network") || message.includes("econnreset") || message.includes("timeout")) {
    return "transient_network"
  }
  return "unknown"
}

/** Converts any thrown value into the normalized provider error used by callers. */
export const toModelProviderError = (error: unknown, providerId?: string): ModelProviderError => {
  if (error instanceof ModelProviderError) {
    return error
  }
  const classification = classifyModelError(error)
  return new ModelProviderError({
    message: error instanceof Error ? error.message : String(error),
    classification,
    providerId,
    cause: error,
  })
}
