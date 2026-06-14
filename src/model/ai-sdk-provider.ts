import {
  ModelProviderError,
  toModelProviderError,
  type ModelContext,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelTokenUsage,
  type ModelToolCall,
  type ModelToolDefinition,
} from "./provider"

/** Configuration variants supported by the OpenAI-compatible/Anthropic adapter. */
export type ModelProviderConfig =
  | { readonly type: "fake"; readonly enabled?: boolean }
  | { readonly type: "openai"; readonly apiKeyEnv?: string; readonly baseURL?: string }
  | { readonly type: "anthropic"; readonly apiKeyEnv?: string; readonly baseURL?: string }
  | {
      readonly type: "openai-compatible"
      readonly id: string
      readonly baseURL: string
      readonly apiKeyEnv?: string
      readonly allowUnauthenticated?: boolean
    }
  | {
      readonly type: "local"
      readonly id: string
      readonly baseURL: string
      readonly apiKeyEnv?: string
      readonly allowUnauthenticated?: boolean
    }

export interface ProviderGateResult {
  readonly ok: boolean
  readonly providerId: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
  readonly missingApiKey?: boolean
  readonly reason?: string
}

export type ModelFetch = typeof fetch

const defaultApiKeyEnv = (config: ModelProviderConfig): string | undefined => {
  if (config.type === "openai") {
    return config.apiKeyEnv ?? "OPENAI_API_KEY"
  }
  if (config.type === "anthropic") {
    return config.apiKeyEnv ?? "ANTHROPIC_API_KEY"
  }
  if (config.type === "openai-compatible" || config.type === "local") {
    return config.apiKeyEnv
  }
  return undefined
}

/** Resolves the stable provider id exposed to the rest of the model layer. */
export const providerIdFromConfig = (config: ModelProviderConfig): string => {
  if (config.type === "openai-compatible" || config.type === "local") {
    return config.id
  }
  return config.type
}

/** Validates provider config before any network call is attempted. */
export const checkProviderGate = (
  config: ModelProviderConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderGateResult => {
  const providerId = providerIdFromConfig(config)
  if (config.type === "fake") {
    return { ok: config.enabled ?? true, providerId, reason: config.enabled === false ? "Provider is disabled" : undefined }
  }

  const apiKeyEnv = defaultApiKeyEnv(config)
  const baseURL = "baseURL" in config ? config.baseURL : undefined
  const allowsUnauthenticated =
    (config.type === "openai-compatible" || config.type === "local") && config.allowUnauthenticated === true

  if (!baseURL && (config.type === "openai-compatible" || config.type === "local")) {
    return { ok: false, providerId, apiKeyEnv, baseURL, reason: "Provider requires baseURL" }
  }
  if (apiKeyEnv && !env[apiKeyEnv]) {
    return { ok: false, providerId, apiKeyEnv, baseURL, missingApiKey: true, reason: `Missing ${apiKeyEnv}` }
  }
  if (!apiKeyEnv && !allowsUnauthenticated && (config.type === "openai-compatible" || config.type === "local")) {
    return { ok: false, providerId, baseURL, reason: "Provider requires apiKeyEnv or allowUnauthenticated" }
  }
  return { ok: true, providerId, apiKeyEnv, baseURL }
}

/** Streams model output from Anthropic or OpenAI-compatible HTTP APIs. */
export class AiSdkModelProvider implements ModelProvider {
  readonly id: string
  readonly name: string
  private readonly config: Exclude<ModelProviderConfig, { readonly type: "fake" }>
  private readonly env: Record<string, string | undefined>
  private readonly fetch: ModelFetch

  constructor(
    config: Exclude<ModelProviderConfig, { readonly type: "fake" }>,
    env: Record<string, string | undefined> = process.env,
    fetchImplementation: ModelFetch = fetch,
  ) {
    this.config = config
    this.id = providerIdFromConfig(config)
    this.name = config.type === "openai-compatible" || config.type === "local" ? config.id : config.type
    this.env = env
    this.fetch = fetchImplementation
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const gate = this.assertGateOpen()
    const response = await this.fetch(`${this.baseURL(gate).replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: this.headers(gate),
    })
    await assertOk(response, this.id)
    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return []
    }
    return body.data.flatMap((model): ModelInfo[] => {
      if (!isRecord(model) || typeof model.id !== "string") {
        return []
      }
      return [{ id: model.id, name: typeof model.name === "string" ? model.name : undefined }]
    })
  }

  async *stream(request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {
    const gate = this.assertGateOpen()
    try {
      if (this.config.type === "anthropic") {
        yield* this.streamAnthropic(request, gate)
        return
      }
      yield* this.streamOpenAICompatible(request, gate)
    } catch (error) {
      throw toModelProviderError(error, this.id)
    }
  }

  private assertGateOpen(): ProviderGateResult {
    const gate = checkProviderGate(this.config, this.env)
    if (!gate.ok) {
      throw new ModelProviderError({
        message: gate.reason ?? `Provider ${this.id} is not available`,
        classification: gate.missingApiKey ? "auth" : "invalid_request",
        retryable: false,
        providerId: this.id,
      })
    }
    return gate
  }

  private baseURL(gate: ProviderGateResult): string {
    if (gate.baseURL) {
      return gate.baseURL
    }
    return this.config.type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"
  }

  private headers(gate: ProviderGateResult, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra }
    if (gate.apiKeyEnv) {
      const apiKey = this.env[gate.apiKeyEnv]
      if (apiKey) {
        if (this.config.type === "anthropic") {
          headers["x-api-key"] = apiKey
          headers["anthropic-version"] = "2023-06-01"
        } else {
          headers.authorization = `Bearer ${apiKey}`
        }
      }
    }
    return headers
  }

  private async *streamOpenAICompatible(request: ModelRequest, gate: ProviderGateResult): AsyncIterable<ModelEvent> {
    const response = await this.fetch(`${this.baseURL(gate).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: this.headers(gate, { "content-type": "application/json" }),
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        tools: request.tools.length ? request.tools.map(toOpenAITool) : undefined,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    })
    await assertOk(response, this.id)

    const toolCalls = new Map<number, { id: string; name: string; argumentsText: string }>()
    for await (const data of readSseData(response, request.signal)) {
      if (data === "[DONE]") {
        yield { type: "done" }
        return
      }
      const chunk = parseJsonRecord(data)
      if (!chunk) {
        continue
      }
      const usage = readUsage(chunk.usage)
      if (usage) {
        yield { type: "usage", usage }
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : []
      for (const choice of choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) {
          continue
        }
        const delta = choice.delta
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text-delta", text: delta.content }
        }
        const reasoning = readString(delta.reasoning_content) ?? readString(delta.reasoning)
        if (reasoning) {
          yield { type: "reasoning-delta", text: reasoning }
        }
        if (Array.isArray(delta.tool_calls)) {
          // Tool call arguments can arrive over multiple SSE chunks, so keep accumulating by index.
          yield* readOpenAIToolCalls(delta.tool_calls, toolCalls)
        }
        if (choice.finish_reason === "stop") {
          yield { type: "done" }
        }
      }
    }
  }

  private async *streamAnthropic(request: ModelRequest, gate: ProviderGateResult): AsyncIterable<ModelEvent> {
    const response = await this.fetch(`${this.baseURL(gate).replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: this.headers(gate, { "content-type": "application/json" }),
      body: JSON.stringify({
        model: request.modelId,
        messages: request.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role, content: message.content })),
        system: request.messages.find((message) => message.role === "system")?.content,
        tools: request.tools.length ? request.tools.map(toAnthropicTool) : undefined,
        temperature: request.temperature,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      }),
      signal: request.signal,
    })
    await assertOk(response, this.id)

    for await (const data of readSseData(response, request.signal)) {
      const chunk = parseJsonRecord(data)
      if (!chunk) {
        continue
      }
      if (chunk.type === "content_block_delta" && isRecord(chunk.delta)) {
        if (chunk.delta.type === "text_delta" && typeof chunk.delta.text === "string") {
          yield { type: "text-delta", text: chunk.delta.text }
        }
        if (chunk.delta.type === "thinking_delta" && typeof chunk.delta.thinking === "string") {
          yield { type: "reasoning-delta", text: chunk.delta.thinking }
        }
      }
      if (chunk.type === "content_block_start" && isRecord(chunk.content_block) && chunk.content_block.type === "tool_use") {
        const input = isRecord(chunk.content_block.input) ? chunk.content_block.input : {}
        yield {
          type: "tool-call",
          call: {
            id: readString(chunk.content_block.id) ?? crypto.randomUUID(),
            name: readString(chunk.content_block.name) ?? "unknown",
            arguments: input,
          },
        }
      }
      if (chunk.type === "message_delta" && isRecord(chunk.usage)) {
        const usage = readUsage(chunk.usage)
        if (usage) {
          yield { type: "usage", usage }
        }
      }
      if (chunk.type === "message_stop") {
        yield { type: "done" }
      }
    }
  }
}

/** Convenience factory for constructing a configured remote model provider. */
export const createConfiguredProvider = (
  config: Exclude<ModelProviderConfig, { readonly type: "fake" }>,
  env?: Record<string, string | undefined>,
  fetchImplementation?: ModelFetch,
): AiSdkModelProvider => new AiSdkModelProvider(config, env, fetchImplementation)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const readString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)

const parseJsonRecord = (text: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const readUsage = (value: unknown): ModelTokenUsage | undefined => {
  const usage = isRecord(value) ? value : undefined
  const inputTokens = readNumber(usage?.input_tokens) ?? readNumber(usage?.prompt_tokens)
  const outputTokens = readNumber(usage?.output_tokens) ?? readNumber(usage?.completion_tokens)
  return inputTokens !== undefined || outputTokens !== undefined
    ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
    : undefined
}

const readNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

const assertOk = async (response: Response, providerId: string): Promise<void> => {
  if (response.ok) {
    return
  }
  const message = await response.text().catch(() => response.statusText)
  throw new ModelProviderError({
    message: message || response.statusText || `Provider ${providerId} request failed`,
    classification: response.status === 401 || response.status === 403 ? "auth" : undefined,
    status: response.status,
    providerId,
  })
}

async function* readSseData(response: Response, signal: AbortSignal): AsyncIterable<string> {
  if (!response.body) {
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      if (signal.aborted) {
        throw new ModelProviderError({ message: "Model request was cancelled", classification: "cancelled", retryable: false })
      }
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      // SSE messages are separated by blank lines; retain the incomplete tail for the next chunk.
      const parts = buffer.split("\n\n")
      buffer = parts.pop() ?? ""
      for (const part of parts) {
        const data = part
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (data) {
          yield data
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function* readOpenAIToolCalls(
  toolCallDeltas: readonly unknown[],
  toolCalls: Map<number, { id: string; name: string; argumentsText: string }>,
): Iterable<ModelEvent> {
  for (const toolCallDelta of toolCallDeltas) {
    if (!isRecord(toolCallDelta)) {
      continue
    }
    const index = typeof toolCallDelta.index === "number" ? toolCallDelta.index : 0
    const previous = toolCalls.get(index) ?? { id: crypto.randomUUID(), name: "unknown", argumentsText: "" }
    const fn = isRecord(toolCallDelta.function) ? toolCallDelta.function : {}
    const next = {
      id: readString(toolCallDelta.id) ?? previous.id,
      name: readString(fn.name) ?? previous.name,
      argumentsText: previous.argumentsText + (readString(fn.arguments) ?? ""),
    }
    toolCalls.set(index, next)
    const parsedArguments = parseJsonRecord(next.argumentsText)
    if (parsedArguments) {
      const call: ModelToolCall = { id: next.id, name: next.name, arguments: parsedArguments }
      yield { type: "tool-call", call }
    }
  }
}

const toOpenAITool = (tool: ModelToolDefinition): Record<string, unknown> => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
})

const toAnthropicTool = (tool: ModelToolDefinition): Record<string, unknown> => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
})
