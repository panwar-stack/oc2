import type { ContentPart, JsonSchema, LLMRequest, ProviderMetadata } from "@oc2-ai/llm"
import type { CachePlan } from "@oc2-ai/llm/cache/planner"
import { CacheHint, LLM, Message, SystemPart, ToolCallPart, ToolDefinition, ToolResultPart } from "@oc2-ai/llm"
import {
  AmazonBedrock,
  Anthropic,
  Azure,
  Google,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
} from "@oc2-ai/llm/providers"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"

type ToolInput = {
  readonly description?: string
  readonly inputSchema?: unknown
  readonly providerOptions?: unknown
}

export type RequestInput = {
  readonly model: Provider.Model
  readonly apiKey?: string
  readonly baseURL?: string
  readonly system?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools?: Record<string, ToolInput>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: LLMRequest["providerOptions"]
  readonly headers?: Record<string, string>
  readonly cachePlan?: CachePlan
}

const providerMetadata = (value: unknown): ProviderMetadata | undefined => {
  if (!isRecord(value)) return undefined
  const result = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

// Stored AI SDK parts historically kept provider-owned continuation metadata in
// `providerOptions`; native parts now use `providerMetadata` directly.
const partProviderMetadata = (part: Record<string, unknown>) =>
  providerMetadata(part.providerMetadata) ?? providerMetadata(part.providerOptions)

const cacheHint = (model: Provider.Model, value: unknown): CacheHint | undefined => {
  if (model.api.npm !== "@ai-sdk/anthropic" && model.api.npm !== "@ai-sdk/google-vertex/anthropic") return undefined
  if (!isRecord(value)) return undefined
  for (const key of new Set(["anthropic", String(model.providerID)])) {
    const options = value[key]
    if (!isRecord(options)) continue
    const control = options.cacheControl ?? options.cache_control
    if (!isRecord(control) || control.type !== "ephemeral") continue
    if (control.ttl !== undefined && control.ttl !== "5m" && control.ttl !== "1h") continue
    return new CacheHint({
      type: "ephemeral",
      ttlSeconds: control.ttl === "1h" ? 3600 : control.ttl === "5m" ? 300 : undefined,
    })
  }
  return undefined
}

const textPart = (part: Record<string, unknown>, model: Provider.Model) => ({
  type: "text" as const,
  text: typeof part.text === "string" ? part.text : "",
  cache: cacheHint(model, part.providerOptions),
  providerMetadata: partProviderMetadata(part),
})

const mediaPart = (part: Record<string, unknown>) => {
  if (typeof part.data !== "string" && !(part.data instanceof Uint8Array))
    throw new Error("Native LLM request adapter only supports file parts with string or Uint8Array data")
  return {
    type: "media" as const,
    mediaType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream",
    data: part.data,
    filename: typeof part.filename === "string" ? part.filename : undefined,
  }
}

const toolResult = (part: Record<string, unknown>, model: Provider.Model) => {
  const output = isRecord(part.output) ? part.output : { type: "json", value: part.output }
  const type = output.type === "text" ? "text" : output.type === "error-text" ? "error" : "json"
  const outputProviderOptions =
    output.providerOptions ??
    (output.type === "content" && Array.isArray(output.value)
      ? output.value.find((item) => isRecord(item) && item.providerOptions !== undefined)?.providerOptions
      : undefined)
  return ToolResultPart.make({
    id: typeof part.toolCallId === "string" ? part.toolCallId : "",
    name: typeof part.toolName === "string" ? part.toolName : "",
    result: "value" in output ? output.value : output,
    resultType: type,
    cache: cacheHint(model, part.providerOptions) ?? cacheHint(model, outputProviderOptions),
    providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
    providerMetadata: partProviderMetadata(part),
  })
}

const contentPart = (part: unknown, model: Provider.Model) => {
  if (!isRecord(part)) throw new Error("Native LLM request adapter only supports object content parts")
  if (part.type === "text") return textPart(part, model)
  if (part.type === "file") return mediaPart(part)
  if (part.type === "reasoning")
    return {
      type: "reasoning" as const,
      text: typeof part.text === "string" ? part.text : "",
      providerMetadata: partProviderMetadata(part),
    }
  if (part.type === "tool-call")
    return ToolCallPart.make({
      id: typeof part.toolCallId === "string" ? part.toolCallId : "",
      name: typeof part.toolName === "string" ? part.toolName : "",
      input: part.input,
      providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
      providerMetadata: partProviderMetadata(part),
    })
  if (part.type === "tool-result") return toolResult(part, model)
  throw new Error(`Native LLM request adapter does not support ${String(part.type)} content parts`)
}

const content = (value: ModelMessage["content"], model: Provider.Model): ContentPart[] =>
  typeof value === "string"
    ? [{ type: "text" as const, text: value, cache: undefined }]
    : value.map((part) => contentPart(part, model))

const messages = (input: readonly ModelMessage[], model: Provider.Model) => {
  const system = input.flatMap((message) =>
    message.role === "system"
      ? [{ ...SystemPart.make(message.content), cache: cacheHint(model, message.providerOptions) }]
      : [],
  )
  const messages = input.flatMap((message) => {
    if (message.role === "system") return []
    const converted = content(message.content, model)
    const messageCache = cacheHint(model, message.providerOptions)
    if (messageCache) {
      const index = converted.findLastIndex((part) => part.type === "text" || part.type === "tool-result")
      const part = converted[index]
      if (part?.type === "text" && !part.cache) converted[index] = { ...part, cache: messageCache }
      if (part?.type === "tool-result" && !part.cache) converted[index] = { ...part, cache: messageCache }
    }
    return [
      Message.make({
        role: message.role,
        content: converted,
        native: isRecord(message.providerOptions) ? { providerOptions: message.providerOptions } : undefined,
      }),
    ]
  })
  return { system, messages }
}

const schema = (value: unknown): JsonSchema => {
  if (!isRecord(value)) return { type: "object", properties: {} }
  if (isRecord(value.jsonSchema)) return value.jsonSchema
  return value
}

const tools = (input: Record<string, ToolInput> | undefined, model: Provider.Model): ToolDefinition[] =>
  Object.entries(input ?? {}).map(([name, item]) =>
    ToolDefinition.make({
      name,
      description: item.description ?? "",
      inputSchema: schema(item.inputSchema),
      cache: cacheHint(model, item.providerOptions),
    }),
  )

const generation = (input: RequestInput) => {
  const result = {
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxTokens: input.maxOutputTokens,
  }
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

const baseURL = (input: Provider.Model | RequestInput) =>
  "model" in input ? (input.baseURL ?? (input.model.api.url || undefined)) : input.api.url || undefined

const requireBaseURL = (model: Provider.Model, url: string | undefined) => {
  if (url) return url
  throw new Error(`Native LLM request adapter requires a base URL for ${model.providerID}/${model.id}`)
}

export const model = (input: Provider.Model | RequestInput, headers?: Record<string, string>) => {
  const model = "model" in input ? input.model : input
  const url = baseURL(input)
  const options = {
    ...("model" in input && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(url ? { baseURL: url } : {}),
    headers: Object.keys({ ...model.headers, ...headers }).length === 0 ? undefined : { ...model.headers, ...headers },
    limits: {
      context: model.limit.context,
      output: model.limit.output,
    },
  }
  if (model.api.npm === "@ai-sdk/openai") return OpenAI.configure(options).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/azure")
    return Azure.configure({ ...options, baseURL: requireBaseURL(model, url) }).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/anthropic") return Anthropic.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/google") return Google.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return AmazonBedrock.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/openai-compatible")
    return OpenAICompatible.configure({
      ...options,
      provider: String(model.providerID),
      baseURL: requireBaseURL(model, url),
    }).model(model.api.id)
  if (model.api.npm === "@openrouter/ai-sdk-provider") return OpenRouter.configure(options).model(model.api.id)
  throw new Error(`Native LLM request adapter does not support provider package ${model.api.npm}`)
}

export const request = (input: RequestInput) => {
  const converted = messages(input.messages, input.model)
  // This is the only native adapter boundary that should construct canonical
  // @oc2-ai/llm request objects from opencode's session/AI SDK-shaped data.
  return LLM.request({
    model: model(input, input.headers),
    system: [...(input.system ?? []).map(SystemPart.make), ...converted.system],
    messages: converted.messages,
    tools: tools(input.tools, input.model),
    toolChoice: input.toolChoice,
    generation: generation(input),
    providerOptions: input.providerOptions,
    metadata: input.cachePlan ? { cachePlan: input.cachePlan } : undefined,
  })
}

export * as LLMNative from "./native-request"
