import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  type FinishReason,
  type LLMRequest,
  type LLMError,
  type MediaPart,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolResultContentPart,
  type Usage,
} from "../schema"
import { isRecord, JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { CacheTelemetry } from "../cache/telemetry"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "openai-chat"
const IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/chat/completions"

// =============================================================================
// Request Body Schema
// =============================================================================
// The body schema is the provider-native JSON body. `fromRequest` below builds
// this shape from the common `LLMRequest`, then `Route.make` validates and
// JSON-encodes it before transport.
const OpenAIChatFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
})

const OpenAIChatTool = Schema.Struct({
  type: Schema.tag("function"),
  function: OpenAIChatFunction,
})
type OpenAIChatTool = Schema.Schema.Type<typeof OpenAIChatTool>

const OpenAIChatAssistantToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.tag("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
})
type OpenAIChatAssistantToolCall = Schema.Schema.Type<typeof OpenAIChatAssistantToolCall>

const OpenAIChatUserContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image_url"),
    image_url: Schema.Struct({ url: Schema.String }),
  }),
])

const OpenAIChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(OpenAIChatUserContent)]),
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: optionalArray(OpenAIChatAssistantToolCall),
    reasoning_content: Schema.optional(Schema.String),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String, content: Schema.String }),
]).pipe(Schema.toTaggedUnion("role"))
type OpenAIChatMessage = Schema.Schema.Type<typeof OpenAIChatMessage>

const OpenAIChatToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    type: Schema.tag("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
])

export const bodyFields = {
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  tools: optionalArray(OpenAIChatTool),
  tool_choice: Schema.optional(OpenAIChatToolChoice),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Boolean })),
  store: Schema.optional(Schema.Boolean),
  service_tier: Schema.optional(OpenAIOptions.OpenAIServiceTier),
  reasoning_effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
  prompt_cache_key: Schema.optional(Schema.String),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: optionalArray(Schema.String),
}
const OpenAIChatBody = Schema.Struct(bodyFields)
export type OpenAIChatBody = Schema.Schema.Type<typeof OpenAIChatBody>

// =============================================================================
// Streaming Event Schema
// =============================================================================
// The event schema is one decoded SSE `data:` payload. `Framing.sse` splits the
// byte stream into strings, then `Protocol.jsonEvent` decodes each string into
// this provider-native event shape.
const OpenAIChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  prompt_cache_hit_tokens: Schema.optional(Schema.Number),
  prompt_cache_miss_tokens: Schema.optional(Schema.Number),
  cost: optionalNull(Schema.Number),
  is_byok: Schema.optional(Schema.Boolean),
  cost_in_usd_ticks: Schema.optional(Schema.Number),
  prompt_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
      cache_write_tokens: optionalNull(Schema.Number),
    }),
  ),
  completion_tokens_details: optionalNull(
    Schema.Struct({
      reasoning_tokens: Schema.optional(Schema.Number),
    }),
  ),
  cost_details: optionalNull(
    Schema.Struct({
      upstream_inference_cost: optionalNull(Schema.Number),
      upstream_inference_prompt_cost: optionalNull(Schema.Number),
      upstream_inference_completions_cost: optionalNull(Schema.Number),
    }),
  ),
})

const OpenAIChatToolCallDeltaFunction = Schema.Struct({
  name: optionalNull(Schema.String),
  arguments: optionalNull(Schema.String),
})

const OpenAIChatToolCallDelta = Schema.Struct({
  index: Schema.Number,
  id: optionalNull(Schema.String),
  function: optionalNull(OpenAIChatToolCallDeltaFunction),
})
type OpenAIChatToolCallDelta = Schema.Schema.Type<typeof OpenAIChatToolCallDelta>

const OpenAIChatDelta = Schema.Struct({
  content: optionalNull(Schema.String),
  reasoning_content: optionalNull(Schema.String),
  tool_calls: optionalNull(Schema.Array(OpenAIChatToolCallDelta)),
})

const OpenAIChatChoice = Schema.Struct({
  delta: optionalNull(OpenAIChatDelta),
  finish_reason: optionalNull(Schema.String),
})

const OpenAIChatEvent = Schema.Struct({
  choices: Schema.Array(OpenAIChatChoice),
  usage: optionalNull(OpenAIChatUsage),
})
type OpenAIChatEvent = Schema.Schema.Type<typeof OpenAIChatEvent>
type OpenAIChatRequestMessage = LLMRequest["messages"][number]

interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly toolCallEvents: ReadonlyArray<LLMEvent>
  readonly usage?: Usage
  readonly usageProfile: OpenAIChatUsageProfile
  readonly finishReason?: FinishReason
  readonly lifecycle: Lifecycle.State
}

interface OpenAIChatUsageProfile {
  readonly providerMetadata: string
  readonly cacheProvider: string
  readonly model?: string
  readonly completionTokens: "inclusive" | "exclusive"
  readonly cacheRead: "prompt-details" | "deepseek"
  readonly cacheInput: "inclusive" | "xai-conditional"
  readonly cacheWrite: boolean
  readonly metadataShape: "direct" | "usage"
}

const OPENAI_USAGE_PROFILE: OpenAIChatUsageProfile = {
  providerMetadata: "openai",
  cacheProvider: "openai",
  completionTokens: "inclusive",
  cacheRead: "prompt-details",
  cacheInput: "inclusive",
  cacheWrite: false,
  metadataShape: "direct",
}

const XAI_USAGE_PROFILE: OpenAIChatUsageProfile = {
  ...OPENAI_USAGE_PROFILE,
  providerMetadata: "xai",
  completionTokens: "exclusive",
  cacheInput: "xai-conditional",
}

const DEEPINFRA_USAGE_PROFILE: OpenAIChatUsageProfile = {
  ...OPENAI_USAGE_PROFILE,
  providerMetadata: "deepinfra",
}

const DEEPINFRA_EXCLUDED_REASONING_USAGE_PROFILE: OpenAIChatUsageProfile = {
  ...DEEPINFRA_USAGE_PROFILE,
  completionTokens: "exclusive",
}

const DEEPSEEK_USAGE_PROFILE: OpenAIChatUsageProfile = {
  ...OPENAI_USAGE_PROFILE,
  providerMetadata: "deepseek",
  cacheProvider: "deepseek",
  cacheRead: "deepseek",
}

const OPENROUTER_USAGE_PROFILE: OpenAIChatUsageProfile = {
  ...OPENAI_USAGE_PROFILE,
  providerMetadata: "openrouter",
  cacheWrite: true,
  metadataShape: "usage",
}

const openAIChatUsageProfile = (request: LLMRequest): OpenAIChatUsageProfile => {
  const provider = String(request.model.provider)
  const model = String(request.model.id)
  if (provider === "xai") return { ...XAI_USAGE_PROFILE, model }
  if (provider === "deepseek") return { ...DEEPSEEK_USAGE_PROFILE, model }
  if (provider === "openrouter") return { ...OPENROUTER_USAGE_PROFILE, model }
  if (provider !== "deepinfra") return { ...OPENAI_USAGE_PROFILE, cacheProvider: provider, model }
  const normalizedModel = model.toLowerCase()
  return normalizedModel.startsWith("google/gemini-") || normalizedModel.startsWith("google/gemma-")
    ? { ...DEEPINFRA_EXCLUDED_REASONING_USAGE_PROFILE, model }
    : { ...DEEPINFRA_USAGE_PROFILE, model }
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
// Lowering is the only place that knows how common LLM messages map onto the
// OpenAI Chat wire format. Keep provider quirks here instead of leaking native
// fields into `LLMRequest`.
const lowerTool = (tool: ToolDefinition): OpenAIChatTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: ProviderShared.openAiToolInputSchema(tool.inputSchema),
  },
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("OpenAI Chat", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({ type: "function" as const, function: { name } }),
  })

const lowerToolCall = (part: ToolCallPart): OpenAIChatAssistantToolCall => ({
  id: part.id,
  type: "function",
  function: {
    name: part.name,
    arguments: ProviderShared.encodeJson(part.input),
  },
})

const lowerMedia = Effect.fn("OpenAIChat.lowerMedia")(function* (
  part: Extract<MediaPart | ToolResultContentPart, { type: "media" }>,
) {
  const media = yield* ProviderShared.validateMedia("OpenAI Chat", part, IMAGE_MIMES)
  return { type: "image_url" as const, image_url: { url: media.dataUrl } }
})

const openAICompatibleReasoningContent = (native: unknown) =>
  isRecord(native) && typeof native.reasoning_content === "string" ? native.reasoning_content : undefined

const lowerUserMessage = Effect.fn("OpenAIChat.lowerUserMessage")(function* (message: OpenAIChatRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "media") {
      content.push(yield* lowerMedia(part))
      continue
    }
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "user", ["text", "media"])
  }
  if (content.every((part) => part.type === "text"))
    return { role: "user" as const, content: content.map((part) => part.text).join("") }
  return { role: "user" as const, content }
})

const lowerAssistantMessage = Effect.fn("OpenAIChat.lowerAssistantMessage")(function* (
  message: OpenAIChatRequestMessage,
) {
  const content: TextPart[] = []
  const reasoning: ReasoningPart[] = []
  const toolCalls: OpenAIChatAssistantToolCall[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "assistant", ["text", "reasoning", "tool-call"])
    if (part.type === "text") {
      content.push(part)
      continue
    }
    if (part.type === "reasoning") {
      reasoning.push(part)
      continue
    }
    if (part.type === "tool-call") {
      toolCalls.push(lowerToolCall(part))
      continue
    }
  }
  return {
    role: "assistant" as const,
    content: content.length === 0 ? null : ProviderShared.joinText(content),
    tool_calls: toolCalls.length === 0 ? undefined : toolCalls,
    reasoning_content:
      reasoning.length > 0
        ? reasoning.map((part) => part.text).join("")
        : openAICompatibleReasoningContent(message.native?.openaiCompatible),
  }
})

const lowerToolMessages = Effect.fn("OpenAIChat.lowerToolMessages")(function* (message: OpenAIChatRequestMessage) {
  const messages: OpenAIChatMessage[] = []
  const images: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["tool-result"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "tool", ["tool-result"])
    if (part.result.type !== "content") {
      messages.push({ role: "tool", tool_call_id: part.id, content: ProviderShared.toolResultText(part) })
      continue
    }
    const content: ReadonlyArray<ToolResultContentPart> = part.result.value
    const text = content.filter((item) => item.type === "text").map((item) => item.text)
    messages.push({ role: "tool", tool_call_id: part.id, content: text.join("\n") })
    const media = content.filter(
      (item): item is Extract<ToolResultContentPart, { type: "media" }> => item.type === "media",
    )
    images.push(...(yield* Effect.forEach(media, lowerMedia)))
  }
  return { messages, images }
})

const lowerMessage = Effect.fn("OpenAIChat.lowerMessage")(function* (message: OpenAIChatRequestMessage) {
  if (message.role === "user") return [yield* lowerUserMessage(message)]
  if (message.role === "assistant") return [yield* lowerAssistantMessage(message)]
  return (yield* lowerToolMessages(message)).messages
})

const lowerMessages = Effect.fn("OpenAIChat.lowerMessages")(function* (request: LLMRequest) {
  const system: OpenAIChatMessage[] =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  const messages = [...system]
  const pendingImages: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    messages.push({ role: "user", content: pendingImages.splice(0) })
  }
  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Chat", message)
      if (pendingImages.length > 0) {
        messages.push({ role: "user", content: [...pendingImages.splice(0), { type: "text", text: part.text }] })
        continue
      }
      const previous = messages.at(-1)
      if (previous?.role === "user" && typeof previous.content === "string")
        messages[messages.length - 1] = { role: "user", content: `${previous.content}\n${part.text}` }
      else if (previous?.role === "user" && Array.isArray(previous.content))
        messages[messages.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "text", text: part.text }],
        }
      else messages.push({ role: "user", content: part.text })
      continue
    }
    if (message.role === "tool") {
      const lowered = yield* lowerToolMessages(message)
      messages.push(...lowered.messages)
      pendingImages.push(...lowered.images)
      continue
    }
    flushImages()
    messages.push(...(yield* lowerMessage(message)))
  }
  flushImages()
  return messages
})

const lowerOptions = Effect.fn("OpenAIChat.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  const serviceTier = OpenAIOptions.serviceTier(request)
  const promptCacheKey = OpenAIOptions.promptCacheKey(request)
  const reasoningEffort = OpenAIOptions.reasoningEffort(request)
  if (reasoningEffort && !OpenAIOptions.isReasoningEffort(reasoningEffort))
    return yield* invalid(`OpenAI Chat does not support reasoning effort ${reasoningEffort}`)
  return {
    ...(store !== undefined ? { store } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIChat.fromRequest")(function* (request: LLMRequest) {
  // `fromRequest` returns the provider body only. Endpoint, auth, framing,
  // validation, and HTTP execution are composed by `Route.make`.
  const generation = request.generation
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request),
    tools: request.tools.length === 0 ? undefined : request.tools.map(lowerTool),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
    stream: true as const,
    stream_options: { include_usage: true },
    max_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    frequency_penalty: generation?.frequencyPenalty,
    presence_penalty: generation?.presencePenalty,
    seed: generation?.seed,
    stop: generation?.stop,
    ...(yield* lowerOptions(request)),
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Streaming parsers are small state machines: every event returns a new state
// plus the common `LLMEvent`s produced by that event. Tool calls are accumulated
// because OpenAI streams JSON arguments across multiple deltas.
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "stop") return "stop"
  if (reason === "length") return "length"
  if (reason === "content_filter") return "content-filter"
  if (reason === "function_call" || reason === "tool_calls") return "tool-calls"
  return "unknown"
}

const mapUsage = (profile: OpenAIChatUsageProfile, usage: OpenAIChatEvent["usage"]): Usage | undefined => {
  if (!usage) return undefined
  if (usage.prompt_tokens === undefined || usage.completion_tokens === undefined) return undefined
  const cached =
    profile.cacheRead === "deepseek"
      ? (usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens)
      : usage.prompt_tokens_details?.cached_tokens
  const cacheWrite = profile.cacheWrite ? (usage.prompt_tokens_details?.cache_write_tokens ?? undefined) : undefined
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const freshInput =
    profile.cacheInput === "xai-conditional" && cached !== undefined && cached > usage.prompt_tokens
      ? usage.prompt_tokens
      : ProviderShared.subtractTokens(usage.prompt_tokens, cached)
  const nonCached = ProviderShared.subtractTokens(freshInput, cacheWrite)
  const sanitized = {
    ...(usage.prompt_tokens === undefined ? {} : { prompt_tokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { completion_tokens: usage.completion_tokens }),
    ...(usage.total_tokens === undefined ? {} : { total_tokens: usage.total_tokens }),
    ...(usage.prompt_cache_hit_tokens === undefined ? {} : { prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens }),
    ...(usage.prompt_cache_miss_tokens === undefined
      ? {}
      : { prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens }),
    ...(usage.cost === undefined ? {} : { cost: usage.cost }),
    ...(usage.is_byok === undefined ? {} : { is_byok: usage.is_byok }),
    ...(usage.cost_in_usd_ticks === undefined ? {} : { cost_in_usd_ticks: usage.cost_in_usd_ticks }),
    ...(usage.prompt_tokens_details === undefined
      ? {}
      : {
          prompt_tokens_details:
            usage.prompt_tokens_details === null
              ? null
              : {
                  ...(usage.prompt_tokens_details.cached_tokens === undefined
                    ? {}
                    : { cached_tokens: usage.prompt_tokens_details.cached_tokens }),
                  ...(usage.prompt_tokens_details.cache_write_tokens == null
                    ? {}
                    : { cache_write_tokens: usage.prompt_tokens_details.cache_write_tokens }),
                },
        }),
    ...(usage.completion_tokens_details === undefined
      ? {}
      : {
          completion_tokens_details:
            usage.completion_tokens_details === null
              ? null
              : usage.completion_tokens_details.reasoning_tokens === undefined
                ? {}
                : { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens },
        }),
    ...(usage.cost_details === undefined
      ? {}
      : {
          cost_details:
            usage.cost_details === null
              ? null
              : {
                  ...(usage.cost_details.upstream_inference_cost === undefined
                    ? {}
                    : { upstream_inference_cost: usage.cost_details.upstream_inference_cost }),
                  ...(usage.cost_details.upstream_inference_prompt_cost === undefined
                    ? {}
                    : { upstream_inference_prompt_cost: usage.cost_details.upstream_inference_prompt_cost }),
                  ...(usage.cost_details.upstream_inference_completions_cost === undefined
                    ? {}
                    : { upstream_inference_completions_cost: usage.cost_details.upstream_inference_completions_cost }),
                },
        }),
  }
  const providerMetadata =
    profile.metadataShape === "usage"
      ? { [profile.providerMetadata]: { usage: sanitized } }
      : { [profile.providerMetadata]: sanitized }
  return ProviderShared.usage(
    {
      input: nonCached ?? 0,
      output:
        profile.completionTokens === "exclusive"
          ? usage.completion_tokens
          : (ProviderShared.subtractTokens(usage.completion_tokens, reasoning) ?? 0),
      reasoning: reasoning ?? 0,
      cache: { read: cached ?? 0, write: cacheWrite ?? 0 },
      providerTotal: usage.total_tokens,
      providerMetadata,
    },
    {
      cacheRead: cached !== undefined,
      cacheWrite: cacheWrite !== undefined,
      reasoning: reasoning !== undefined,
      cacheTelemetry: CacheTelemetry.normalize({
        provider: profile.cacheProvider,
        model: profile.model ?? "",
        inputTokens: usage.prompt_tokens,
        cacheReadTokens: cached ?? null,
        cacheWriteTokens: cacheWrite ?? null,
        cacheMissTokens: usage.prompt_cache_miss_tokens ?? null,
        providerRawUsageFieldNames: [
          "prompt_tokens",
          ...(cached === undefined
            ? []
            : [profile.cacheRead === "deepseek" && usage.prompt_cache_hit_tokens !== undefined
                ? "prompt_cache_hit_tokens"
                : "prompt_tokens_details.cached_tokens"]),
          ...(cacheWrite === undefined ? [] : ["prompt_tokens_details.cache_write_tokens"]),
          ...(usage.prompt_cache_miss_tokens === undefined ? [] : ["prompt_cache_miss_tokens"]),
        ],
      }),
    },
  )
}

const step = (state: ParserState, event: OpenAIChatEvent) =>
  Effect.gen(function* () {
    const events: LLMEvent[] = []
    const choice = event.choices[0]
    const eventFinishReason = choice?.finish_reason ? mapFinishReason(choice.finish_reason) : undefined
    const delta = choice?.delta
    const toolDeltas = delta?.tool_calls ?? []
    const hasOutput = Boolean(delta?.content || delta?.reasoning_content || toolDeltas.length)
    const eventUsage = mapUsage(state.usageProfile, event.usage)

    if (state.finishReason !== undefined) {
      if (hasOutput)
        return yield* Effect.fail(
          ProviderShared.eventError(ADAPTER, "OpenAI Chat received content after its terminal event"),
        )
      if (eventFinishReason !== undefined && eventFinishReason !== state.finishReason)
        return yield* Effect.fail(
          ProviderShared.eventError(
            ADAPTER,
            `OpenAI Chat received conflicting terminal reason ${eventFinishReason} after ${state.finishReason}`,
          ),
        )
      const expectedSupplement = event.choices.length === 0 || eventFinishReason === state.finishReason
      if (state.usage === undefined && eventUsage && expectedSupplement)
        return [{ ...state, usage: eventUsage }, events] as const
      return [state, events] as const
    }

    const terminalUsage = event.choices.length === 0 || eventFinishReason !== undefined ? eventUsage : undefined
    const finishReason = eventFinishReason ?? (terminalUsage && event.choices.length === 0 ? "stop" : undefined)
    let tools = state.tools

    let lifecycle = state.lifecycle

    if (delta?.reasoning_content)
      lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", delta.reasoning_content)

    if (delta?.content) lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", delta.content)

    for (const tool of toolDeltas) {
      const result = ToolStream.appendOrStart(
        ADAPTER,
        tools,
        tool.index,
        { id: tool.id ?? undefined, name: tool.function?.name ?? undefined, text: tool.function?.arguments ?? "" },
        "OpenAI Chat tool call delta is missing id or name",
      )
      if (ToolStream.isError(result)) return yield* result
      tools = result.tools
      if (result.events.length) lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(...result.events)
    }

    // Finalize accumulated tool inputs eagerly when finish_reason arrives so
    // JSON parse failures fail the stream at the boundary rather than at halt.
    const finished =
      finishReason !== undefined && state.finishReason === undefined && Object.keys(tools).length > 0
        ? yield* ToolStream.finishAll(ADAPTER, tools)
        : undefined

    return [
      {
        tools: finished?.tools ?? tools,
        toolCallEvents: finished?.events ?? state.toolCallEvents,
        usage: terminalUsage,
        usageProfile: state.usageProfile,
        finishReason,
        lifecycle,
      },
      events,
    ] as const
  })

const finishEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  const hasToolCalls = state.toolCallEvents.length > 0
  const reason = state.finishReason === "stop" && hasToolCalls ? "tool-calls" : state.finishReason
  const lifecycle = state.toolCallEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...state.toolCallEvents)
  if (reason) Lifecycle.finish(lifecycle, events, { reason, usage: state.usage })
  return events
}

const onFailure = (state: ParserState, error: LLMError): ReadonlyArray<LLMEvent> | undefined => {
  if (error.reason._tag !== "InvalidProviderOutput" && error.reason._tag !== "Transport") return undefined
  return [
    LLMEvent.providerError({
      message: error.reason.message,
      retryable: true,
      usage: state.usage,
    }),
  ]
}

// =============================================================================
// Protocol And OpenAI Route
// =============================================================================
/**
 * The OpenAI Chat protocol — request body construction, body schema, and the
 * streaming-event state machine. Reused by every route that speaks OpenAI Chat
 * over HTTP+SSE: native OpenAI, DeepSeek, TogetherAI, Cerebras, Baseten,
 * Fireworks, DeepInfra, and (once added) Azure OpenAI Chat.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIChatBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIChatEvent),
    initial: (request) => ({
      tools: ToolStream.empty<number>(),
      toolCallEvents: [],
      usageProfile: openAIChatUsageProfile(request),
      lifecycle: Lifecycle.initial(),
    }),
    step,
    onHalt: finishEvents,
    onFailure,
  },
})

export const httpTransport = HttpTransport.sseJson.with<OpenAIChatBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as OpenAIChat from "./openai-chat"
