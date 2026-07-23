import { Schema } from "effect"
import { ContentBlockID, FinishReason, ProtocolID, ProviderMetadata, RouteID, ToolCallID } from "./ids"
import { ModelSchema } from "./options"
import { ToolOutput, ToolResultValue } from "./messages"
import { ProviderFailureClassification } from "./errors"
import { cacheClassifications, type CacheClassification } from "../cache/capability"
import { CacheTelemetry } from "../cache/telemetry"

const UsageToken = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const CacheTelemetrySchema = Schema.Struct({
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  inputTokens: Schema.NullOr(UsageToken),
  cacheReadTokens: Schema.NullOr(UsageToken),
  cacheWriteTokens: Schema.NullOr(UsageToken),
  cacheMissTokens: Schema.NullOr(UsageToken),
  uncachedInputTokens: Schema.NullOr(UsageToken),
  metricsAvailable: Schema.Boolean,
  eligible: Schema.Boolean,
  expected: Schema.Boolean,
  verified: Schema.Boolean,
  classification: Schema.Literals(cacheClassifications),
  providerRawUsageFieldNames: Schema.Array(Schema.String),
  warmupRequestNumber: Schema.NullOr(UsageToken),
  estimatedCacheCost: Schema.NullOr(Schema.Number),
  estimatedUncachedCost: Schema.NullOr(Schema.Number),
  estimatedSavings: Schema.NullOr(Schema.Number),
})

export class CanonicalUsage extends Schema.Class<CanonicalUsage>("LLM.CanonicalUsage")({
  input: UsageToken,
  output: UsageToken,
  reasoning: UsageToken,
  cache: Schema.Struct({
    read: UsageToken,
    write: UsageToken,
  }),
  providerTotal: Schema.optional(UsageToken),
  providerMetadata: Schema.optional(ProviderMetadata),
}) {
  static from(input: CanonicalUsageInput) {
    return decodeCanonicalUsage(input)
  }

  static fromUsage(input: UsageInput) {
    const usage = Usage.from(input)
    if ((usage.nonCachedInputTokens === undefined && usage.inputTokens === undefined) || usage.outputTokens === undefined)
      return undefined
    const cacheRead = usage.cacheReadInputTokens ?? 0
    const cacheWrite = usage.cacheWriteInputTokens ?? 0
    const reasoning = usage.reasoningTokens ?? 0
    return decodeCanonicalUsage({
      input: usage.nonCachedInputTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
      output: Math.max(0, (usage.outputTokens ?? 0) - reasoning),
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
      providerTotal: usage.providerTotalTokens,
      providerMetadata: usage.providerMetadata,
    })
  }
}

export type CanonicalUsageInput = ConstructorParameters<typeof CanonicalUsage>[0]

const UsageWrite = Schema.Struct({
  inputTokens: Schema.optional(UsageToken),
  outputTokens: Schema.optional(UsageToken),
  nonCachedInputTokens: Schema.optional(UsageToken),
  cacheReadInputTokens: Schema.optional(UsageToken),
  cacheWriteInputTokens: Schema.optional(UsageToken),
  reasoningTokens: Schema.optional(UsageToken),
  totalTokens: Schema.optional(UsageToken),
  providerTotalTokens: Schema.optional(UsageToken),
  providerMetadata: Schema.optional(ProviderMetadata),
  cacheTelemetry: Schema.optional(CacheTelemetrySchema),
})

/**
 * Token usage reported by an LLM provider.
 *
 * **Inclusive totals** (match AI SDK / OpenAI / LangChain convention — a
 * reader from any of those ecosystems sees the number they expect):
 *
 * - `inputTokens` — total prompt tokens, *including* cached reads/writes.
 * - `outputTokens` — total output tokens, *including* reasoning.
 * - `totalTokens` — provider-supplied total, or `inputTokens + outputTokens`.
 * - `providerTotalTokens` — provider-supplied total when its provenance is known.
 *
 * **Non-overlapping breakdown** (every field is independently meaningful;
 * consumers never have to subtract):
 *
 * - `nonCachedInputTokens` — the "fresh" portion of the prompt.
 * - `cacheReadInputTokens` — input tokens served from cache.
 * - `cacheWriteInputTokens` — input tokens written to cache.
 * - `reasoningTokens` — subset of `outputTokens` spent on hidden reasoning.
 *
 * **Invariant**: `nonCachedInputTokens + cacheReadInputTokens +
 * cacheWriteInputTokens = inputTokens`, and `reasoningTokens ≤ outputTokens`.
 * Each protocol mapper computes whichever side it doesn't get natively,
 * with `Math.max(0, …)` clamping for defense against provider bugs. Because
 * every breakdown field is stored independently, downstream consumers can
 * read whatever they need (cost-by-category, context-pressure, AI-SDK-style
 * inclusive total) without ever subtracting — eliminating the underflow
 * class of bug where a clamped difference would silently store the wrong
 * value.
 *
 * **Semantics by provider**:
 *
 * - OpenAI Chat / Responses / Gemini / Bedrock: provider reports inclusive
 *   `inputTokens` and an inclusive `outputTokens`; mapper subtracts to
 *   derive the breakdown.
 * - Anthropic: provider reports the breakdown natively (`input_tokens` is
 *   non-cached only); mapper sums to derive the inclusive `inputTokens`.
 *   Anthropic does *not* break extended-thinking out of `output_tokens`, so
 *   `reasoningTokens` is `undefined` and `outputTokens` carries the
 *   combined total — a documented limitation of the Anthropic API.
 *
 * `providerMetadata` carries provider usage and billing fields that are not
 * normalized, keyed by provider name (`{ openai: ... }`, `{ anthropic: ... }`).
 */
export class Usage extends Schema.Class<Usage>("LLM.Usage")({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  nonCachedInputTokens: Schema.optional(Schema.Number),
  cacheReadInputTokens: Schema.optional(Schema.Number),
  cacheWriteInputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  providerTotalTokens: Schema.optional(Schema.Number),
  providerMetadata: Schema.optional(ProviderMetadata),
  cacheTelemetry: Schema.optional(CacheTelemetrySchema),
}) {
  /**
   * Visible output tokens — `outputTokens` minus `reasoningTokens`, clamped
   * to zero. The one place subtraction happens in this contract; the clamp
   * means a provider reporting `reasoningTokens > outputTokens` produces a
   * harmless zero rather than a negative that crashes downstream schemas.
   */
  get visibleOutputTokens() {
    return Math.max(0, (this.outputTokens ?? 0) - (this.reasoningTokens ?? 0))
  }

  static from(input: UsageInput) {
    return new Usage(decodeUsageWrite(input))
  }
}

export type UsageInput = Usage | ConstructorParameters<typeof Usage>[0]

const decodeCanonicalUsage = Schema.decodeUnknownSync(CanonicalUsage)
const decodeUsageWrite = Schema.decodeUnknownSync(UsageWrite)

export const StepStart = Schema.Struct({
  type: Schema.tag("step-start"),
  index: Schema.Number,
}).annotate({ identifier: "LLM.Event.StepStart" })
export type StepStart = Schema.Schema.Type<typeof StepStart>

export const TextStart = Schema.Struct({
  type: Schema.tag("text-start"),
  id: ContentBlockID,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.TextStart" })
export type TextStart = Schema.Schema.Type<typeof TextStart>

export const TextDelta = Schema.Struct({
  type: Schema.tag("text-delta"),
  id: ContentBlockID,
  text: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.TextDelta" })
export type TextDelta = Schema.Schema.Type<typeof TextDelta>

export const TextEnd = Schema.Struct({
  type: Schema.tag("text-end"),
  id: ContentBlockID,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.TextEnd" })
export type TextEnd = Schema.Schema.Type<typeof TextEnd>

export const ReasoningStart = Schema.Struct({
  type: Schema.tag("reasoning-start"),
  id: ContentBlockID,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ReasoningStart" })
export type ReasoningStart = Schema.Schema.Type<typeof ReasoningStart>

export const ReasoningDelta = Schema.Struct({
  type: Schema.tag("reasoning-delta"),
  id: ContentBlockID,
  text: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ReasoningDelta" })
export type ReasoningDelta = Schema.Schema.Type<typeof ReasoningDelta>

export const ReasoningEnd = Schema.Struct({
  type: Schema.tag("reasoning-end"),
  id: ContentBlockID,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ReasoningEnd" })
export type ReasoningEnd = Schema.Schema.Type<typeof ReasoningEnd>

export const ToolInputStart = Schema.Struct({
  type: Schema.tag("tool-input-start"),
  id: ToolCallID,
  name: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ToolInputStart" })
export type ToolInputStart = Schema.Schema.Type<typeof ToolInputStart>

export const ToolInputDelta = Schema.Struct({
  type: Schema.tag("tool-input-delta"),
  id: ToolCallID,
  name: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "LLM.Event.ToolInputDelta" })
export type ToolInputDelta = Schema.Schema.Type<typeof ToolInputDelta>

export const ToolInputEnd = Schema.Struct({
  type: Schema.tag("tool-input-end"),
  id: ToolCallID,
  name: Schema.String,
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ToolInputEnd" })
export type ToolInputEnd = Schema.Schema.Type<typeof ToolInputEnd>

export const ToolCall = Schema.Struct({
  type: Schema.tag("tool-call"),
  id: ToolCallID,
  name: Schema.String,
  input: Schema.Unknown,
  providerExecuted: Schema.optional(Schema.Boolean),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ToolCall" })
export type ToolCall = Schema.Schema.Type<typeof ToolCall>

export const ToolResult = Schema.Struct({
  type: Schema.tag("tool-result"),
  id: ToolCallID,
  name: Schema.String,
  result: ToolResultValue,
  output: Schema.optional(ToolOutput),
  providerExecuted: Schema.optional(Schema.Boolean),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ToolResult" })
export type ToolResult = Schema.Schema.Type<typeof ToolResult>

export const ToolError = Schema.Struct({
  type: Schema.tag("tool-error"),
  id: ToolCallID,
  name: Schema.String,
  message: Schema.String,
  error: Schema.optional(Schema.Defect),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ToolError" })
export type ToolError = Schema.Schema.Type<typeof ToolError>

export const StepFinish = Schema.Struct({
  type: Schema.tag("step-finish"),
  index: Schema.Number,
  reason: FinishReason,
  usage: Schema.optional(Usage),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.StepFinish" })
export type StepFinish = Schema.Schema.Type<typeof StepFinish>

export const Finish = Schema.Struct({
  type: Schema.tag("finish"),
  reason: FinishReason,
  usage: Schema.optional(Usage),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.Finish" })
export type Finish = Schema.Schema.Type<typeof Finish>

export const ProviderErrorEvent = Schema.Struct({
  type: Schema.tag("provider-error"),
  message: Schema.String,
  classification: Schema.optional(ProviderFailureClassification),
  retryable: Schema.optional(Schema.Boolean),
  usage: Schema.optional(Usage),
  providerMetadata: Schema.optional(ProviderMetadata),
}).annotate({ identifier: "LLM.Event.ProviderError" })
export type ProviderErrorEvent = Schema.Schema.Type<typeof ProviderErrorEvent>

const llmEventTagged = Schema.Union([
  StepStart,
  TextStart,
  TextDelta,
  TextEnd,
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  ToolCall,
  ToolResult,
  ToolError,
  StepFinish,
  Finish,
  ProviderErrorEvent,
]).pipe(Schema.toTaggedUnion("type"))

type WithID<Event extends { readonly id: unknown }, ID> = Omit<Event, "type" | "id"> & { readonly id: ID | string }
type WithUsage<Event extends { readonly usage?: Usage }> = Omit<Event, "type" | "usage"> & {
  readonly usage?: UsageInput
}
type ErrorCacheClassification = Extract<CacheClassification, "provider_error" | "cache_configuration_error">
type ProviderErrorInput = WithUsage<ProviderErrorEvent> & {
  readonly cacheTelemetryClassification?: ErrorCacheClassification
}

const contentBlockID = (value: ContentBlockID | string) => ContentBlockID.make(value)
const toolCallID = (value: ToolCallID | string) => ToolCallID.make(value)

/**
 * camelCase aliases for `LLMEvent.guards` (provided by `Schema.toTaggedUnion`).
 * Lets consumers write `events.filter(LLMEvent.is.toolCall)` instead of
 * `events.filter(LLMEvent.guards["tool-call"])`.
 */
export const LLMEvent = Object.assign(llmEventTagged, {
  stepStart: StepStart.make,
  textStart: (input: WithID<TextStart, ContentBlockID>) => TextStart.make({ ...input, id: contentBlockID(input.id) }),
  textDelta: (input: WithID<TextDelta, ContentBlockID>) => TextDelta.make({ ...input, id: contentBlockID(input.id) }),
  textEnd: (input: WithID<TextEnd, ContentBlockID>) => TextEnd.make({ ...input, id: contentBlockID(input.id) }),
  reasoningStart: (input: WithID<ReasoningStart, ContentBlockID>) =>
    ReasoningStart.make({ ...input, id: contentBlockID(input.id) }),
  reasoningDelta: (input: WithID<ReasoningDelta, ContentBlockID>) =>
    ReasoningDelta.make({ ...input, id: contentBlockID(input.id) }),
  reasoningEnd: (input: WithID<ReasoningEnd, ContentBlockID>) =>
    ReasoningEnd.make({ ...input, id: contentBlockID(input.id) }),
  toolInputStart: (input: WithID<ToolInputStart, ToolCallID>) =>
    ToolInputStart.make({ ...input, id: toolCallID(input.id) }),
  toolInputDelta: (input: WithID<ToolInputDelta, ToolCallID>) =>
    ToolInputDelta.make({ ...input, id: toolCallID(input.id) }),
  toolInputEnd: (input: WithID<ToolInputEnd, ToolCallID>) => ToolInputEnd.make({ ...input, id: toolCallID(input.id) }),
  toolCall: (input: WithID<ToolCall, ToolCallID>) => ToolCall.make({ ...input, id: toolCallID(input.id) }),
  toolResult: (input: WithID<ToolResult, ToolCallID>) =>
    ToolResult.make({
      ...input,
      id: toolCallID(input.id),
      output: input.output === undefined ? undefined : ToolOutput.make(input.output.structured, input.output.content),
    }),
  toolError: (input: WithID<ToolError, ToolCallID>) => ToolError.make({ ...input, id: toolCallID(input.id) }),
  stepFinish: (input: WithUsage<StepFinish>) =>
    StepFinish.make({
      ...input,
      usage: input.usage === undefined ? undefined : Usage.from(input.usage),
    }),
  finish: (input: WithUsage<Finish>) =>
    Finish.make({
      ...input,
      usage: input.usage === undefined ? undefined : Usage.from(input.usage),
    }),
  providerError: (input: ProviderErrorInput) => {
    const { cacheTelemetryClassification, ...event } = input
    const classification = cacheTelemetryClassification ?? "provider_error"
    return ProviderErrorEvent.make({
      ...event,
      usage: errorUsage(event.usage, classification),
    })
  },
  is: {
    stepStart: llmEventTagged.guards["step-start"],
    textStart: llmEventTagged.guards["text-start"],
    textDelta: llmEventTagged.guards["text-delta"],
    textEnd: llmEventTagged.guards["text-end"],
    reasoningStart: llmEventTagged.guards["reasoning-start"],
    reasoningDelta: llmEventTagged.guards["reasoning-delta"],
    reasoningEnd: llmEventTagged.guards["reasoning-end"],
    toolInputStart: llmEventTagged.guards["tool-input-start"],
    toolInputDelta: llmEventTagged.guards["tool-input-delta"],
    toolInputEnd: llmEventTagged.guards["tool-input-end"],
    toolCall: llmEventTagged.guards["tool-call"],
    toolResult: llmEventTagged.guards["tool-result"],
    toolError: llmEventTagged.guards["tool-error"],
    stepFinish: llmEventTagged.guards["step-finish"],
    finish: llmEventTagged.guards.finish,
    providerError: llmEventTagged.guards["provider-error"],
  },
})
export type LLMEvent = Schema.Schema.Type<typeof llmEventTagged>

const errorUsage = (input: UsageInput | undefined, classification: ErrorCacheClassification) => {
  if (input === undefined) return undefined
  const usage = Usage.from(input)
  if (!usage.cacheTelemetry) return usage
  return Usage.from({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    nonCachedInputTokens: usage.nonCachedInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    providerTotalTokens: usage.providerTotalTokens,
    providerMetadata: usage.providerMetadata,
    cacheTelemetry: CacheTelemetry.forceClassification(usage.cacheTelemetry, classification),
  })
}

export class PreparedRequest extends Schema.Class<PreparedRequest>("LLM.PreparedRequest")({
  id: Schema.String,
  route: RouteID,
  protocol: ProtocolID,
  model: ModelSchema,
  body: Schema.Unknown,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

/**
 * A `PreparedRequest` whose `body` is typed as `Body`. Use with the generic
 * on `LLMClient.prepare<Body>(...)` when the caller knows which route their
 * request will resolve to and wants its native shape statically exposed
 * (debug UIs, request previews, plan rendering).
 *
 * The runtime body is identical — the route still emits `body: unknown` — so
 * this is a type-level assertion the caller makes about what they expect to
 * find. The prepare runtime does not validate the assertion.
 */
export type PreparedRequestOf<Body> = Omit<PreparedRequest, "body"> & {
  readonly body: Body
}

const responseText = (events: ReadonlyArray<LLMEvent>) =>
  events
    .filter(LLMEvent.is.textDelta)
    .map((event) => event.text)
    .join("")

const responseReasoning = (events: ReadonlyArray<LLMEvent>) =>
  events
    .filter(LLMEvent.is.reasoningDelta)
    .map((event) => event.text)
    .join("")

const responseUsage = (events: ReadonlyArray<LLMEvent>) =>
  events.reduce<Usage | undefined>(
    (usage, event) => ("usage" in event && event.usage !== undefined ? event.usage : usage),
    undefined,
  )

export class LLMResponse extends Schema.Class<LLMResponse>("LLM.Response")({
  events: Schema.Array(LLMEvent),
  usage: Schema.optional(Usage),
}) {
  /** Concatenated assistant text assembled from streamed `text-delta` events. */
  get text() {
    return responseText(this.events)
  }

  /** Concatenated reasoning text assembled from streamed `reasoning-delta` events. */
  get reasoning() {
    return responseReasoning(this.events)
  }

  /** Completed tool calls emitted by the provider. */
  get toolCalls() {
    return this.events.filter(LLMEvent.is.toolCall)
  }
}

export namespace LLMResponse {
  export type Output = LLMResponse | { readonly events: ReadonlyArray<LLMEvent>; readonly usage?: Usage }

  /** Concatenate assistant text from a response or collected event list. */
  export const text = (response: Output) => responseText(response.events)

  /** Return response usage, falling back to the latest usage-bearing event. */
  export const usage = (response: Output) => response.usage ?? responseUsage(response.events)

  /** Return completed tool calls from a response or collected event list. */
  export const toolCalls = (response: Output) => response.events.filter(LLMEvent.is.toolCall)

  /** Concatenate reasoning text from a response or collected event list. */
  export const reasoning = (response: Output) => responseReasoning(response.events)
}
