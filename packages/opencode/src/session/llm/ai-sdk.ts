import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@oc2-ai/llm"
import { ProviderShared } from "@oc2-ai/llm/protocols"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
    cacheReadAdjustment: undefined as number | undefined,
    cacheWriteAdjustment: undefined as number | undefined,
    recoveredCacheWrite: undefined as number | undefined,
  }
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function usageProviderMetadata(value: ProviderMetadata | undefined): ProviderMetadata | undefined {
  if (!value) return undefined
  const entries: Array<readonly [string, Record<string, unknown>]> = []
  for (const provider of ["anthropic", "vertex"] as const) {
    const metadata = value[provider]
    const fields = pickUsageNumbers(metadata, ["cacheCreationInputTokens"])
    const usage = anthropicUsage(metadata?.usage)
    if (Object.keys(usage).length) fields.usage = usage
    if (Object.keys(fields).length) entries.push([provider, fields])
  }
  for (const provider of ["google", "google-vertex"] as const) {
    const usageMetadata = pickUsageNumbers(value[provider]?.usageMetadata, [
      "promptTokenCount",
      "candidatesTokenCount",
      "totalTokenCount",
      "cachedContentTokenCount",
      "thoughtsTokenCount",
    ])
    if (Object.keys(usageMetadata).length) entries.push([provider, { usageMetadata }])
  }
  const openai = pickUsageNumbers(value.openai, ["acceptedPredictionTokens", "rejectedPredictionTokens"])
  if (Object.keys(openai).length) entries.push(["openai", openai])
  const copilot = pickUsageNumbers(value.copilot, ["totalNanoAiu"])
  if (Object.keys(copilot).length) entries.push(["copilot", copilot])
  for (const provider of ["bedrock", "venice"] as const) {
    const metadata = value[provider]
    const fields = pickUsageNumbers(isRecord(metadata?.usage) ? metadata.usage : undefined, [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
      "cacheCreationInputTokens",
    ])
    if (Object.keys(fields).length) entries.push([provider, { usage: fields }])
  }
  const openrouterUsage = isRecord(value.openrouter?.usage) ? value.openrouter.usage : undefined
  const openrouter = pickUsageNumbers(openrouterUsage, [
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "reasoningTokens",
    "totalTokens",
    "cachedInputTokens",
    "cost",
  ])
  for (const [key, fields] of [
    ["costDetails", pickUsageNumbers(openrouterUsage?.costDetails, ["upstreamInferenceCost"])],
    ["promptTokensDetails", pickUsageNumbers(openrouterUsage?.promptTokensDetails, ["cachedTokens"])],
    ["completionTokensDetails", pickUsageNumbers(openrouterUsage?.completionTokensDetails, ["reasoningTokens"])],
  ] as const)
    if (Object.keys(fields).length) openrouter[key] = fields
  if (Object.keys(openrouter).length) entries.push(["openrouter", { usage: openrouter }])
  return entries.length ? Object.fromEntries(entries) : undefined
}

type AnthropicUsageIteration = {
  readonly type: "message" | "compaction" | "advisor_message"
  readonly model?: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
}

function anthropicUsage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const usage = pickUsageNumbers(value, ["input_tokens", "output_tokens"])
  for (const field of ["cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
    const item = value[field]
    if (item === null || (typeof item === "number" && Number.isFinite(item) && item >= 0)) usage[field] = item
  }
  if (!Array.isArray(value.iterations)) return usage
  const iterations = value.iterations.flatMap((item): ReadonlyArray<AnthropicUsageIteration> => {
    if (!isRecord(item)) return []
    if (item.type !== "message" && item.type !== "compaction" && item.type !== "advisor_message") return []
    const model = typeof item.model === "string" ? item.model : undefined
    if (item.type === "advisor_message" && model === undefined) return []
    if (
      typeof item.input_tokens !== "number" ||
      !Number.isFinite(item.input_tokens) ||
      item.input_tokens < 0 ||
      typeof item.output_tokens !== "number" ||
      !Number.isFinite(item.output_tokens) ||
      item.output_tokens < 0
    )
      return []
    const cacheCreation = item.cache_creation_input_tokens
    const cacheRead = item.cache_read_input_tokens
    return [
      {
        type: item.type,
        ...(item.type === "advisor_message" ? { model } : {}),
        input_tokens: item.input_tokens,
        output_tokens: item.output_tokens,
        ...(cacheCreation === null ||
        (typeof cacheCreation === "number" && Number.isFinite(cacheCreation) && cacheCreation >= 0)
          ? { cache_creation_input_tokens: cacheCreation }
          : {}),
        ...(cacheRead === null || (typeof cacheRead === "number" && Number.isFinite(cacheRead) && cacheRead >= 0)
          ? { cache_read_input_tokens: cacheRead }
          : {}),
      },
    ]
  })
  if (iterations.length) usage.iterations = iterations
  return usage
}

function anthropicExecutorCache(
  metadata: ProviderMetadata | undefined,
  field: "cache_creation_input_tokens" | "cache_read_input_tokens",
) {
  if (!metadata) return undefined
  for (const provider of ["anthropic", "vertex"] as const) {
    const usage = anthropicUsage(metadata[provider]?.usage)
    if (!Array.isArray(usage.iterations)) continue
    const executor = usage.iterations.filter(
      (item): item is AnthropicUsageIteration => isRecord(item) && item.type !== "advisor_message",
    )
    const values = executor.flatMap((item) => (typeof item[field] === "number" ? [item[field]] : []))
    if (values.length) return values.reduce((sum, item) => sum + item, 0)
  }
  return undefined
}

function pickUsageNumbers(value: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    fields.flatMap((field) => {
      const item = value[field]
      return typeof item === "number" && Number.isFinite(item) && item >= 0 ? [[field, item]] : []
    }),
  )
}

function metadataCacheWrite(metadata: ProviderMetadata | undefined) {
  if (!metadata) return undefined
  const bedrockUsage = metadata.bedrock?.usage
  const veniceUsage = metadata.venice?.usage
  const value =
    metadata.anthropic?.cacheCreationInputTokens ??
    metadata.vertex?.cacheCreationInputTokens ??
    (isRecord(bedrockUsage) && "cacheWriteInputTokens" in bedrockUsage
      ? bedrockUsage.cacheWriteInputTokens
      : undefined) ??
    (isRecord(veniceUsage) && "cacheCreationInputTokens" in veniceUsage
      ? veniceUsage.cacheCreationInputTokens
      : undefined)
  return typeof value === "number" ? value : undefined
}

function metadataProviderTotal(metadata: ProviderMetadata | undefined) {
  if (!metadata) return undefined
  const total = (value: unknown) => (isRecord(value) ? (value.totalTokenCount ?? value.totalTokens) : undefined)
  const values = [
    total(metadata.google?.usageMetadata),
    total(metadata["google-vertex"]?.usageMetadata),
    total(metadata.bedrock?.usage),
    total(metadata.venice?.usage),
    total(metadata.openrouter?.usage),
  ]
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @oc2-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

function usage(
  value: unknown,
  metadata?: ProviderMetadata,
  cacheReadAdjustment?: number,
  cacheWriteAdjustment?: number,
  recoveredCacheWrite?: number,
) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { textTokens?: number; reasoningTokens?: number }
  }
  const reasoning = item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens
  const baseCacheRead = item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens
  const iterationCacheRead = anthropicExecutorCache(metadata, "cache_read_input_tokens")
  const cacheRead =
    iterationCacheRead ??
    (cacheReadAdjustment === undefined ? baseCacheRead : Math.max(0, (baseCacheRead ?? 0) + cacheReadAdjustment))
  const metadataWrite = metadataCacheWrite(metadata) ?? recoveredCacheWrite
  const baseCacheWrite = item.inputTokenDetails?.cacheWriteTokens
  const iterationCacheWrite = anthropicExecutorCache(metadata, "cache_creation_input_tokens")
  const cacheWrite =
    iterationCacheWrite ??
    (cacheWriteAdjustment === undefined
      ? (baseCacheWrite ?? metadataWrite)
      : Math.max(0, (baseCacheWrite ?? 0) + cacheWriteAdjustment))
  if (
    (item.inputTokens === undefined && item.inputTokenDetails?.noCacheTokens === undefined) ||
    (item.outputTokens === undefined && item.outputTokenDetails?.textTokens === undefined)
  )
    return undefined
  const metadataOnlyWrite =
    iterationCacheWrite === undefined && baseCacheWrite === undefined && metadataWrite !== undefined
  const input =
    metadataOnlyWrite && item.inputTokens !== undefined
      ? Math.max(0, item.inputTokens - (cacheRead ?? 0) - metadataWrite)
      : (item.inputTokenDetails?.noCacheTokens ??
        (item.inputTokens === undefined ? 0 : Math.max(0, item.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0))))
  return ProviderShared.usage(
    {
      input,
      output:
        item.outputTokenDetails?.textTokens ??
        (item.outputTokens === undefined ? 0 : Math.max(0, item.outputTokens - (reasoning ?? 0))),
      reasoning: reasoning ?? 0,
      cache: { read: cacheRead ?? 0, write: cacheWrite ?? 0 },
      providerTotal: metadataProviderTotal(metadata),
      providerMetadata: usageProviderMetadata(metadata),
    },
    {
      cacheRead: cacheRead !== undefined,
      cacheWrite: cacheWrite !== undefined,
      reasoning: reasoning !== undefined,
    },
  )
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        const recoveredCacheWrite = metadataCacheWrite(metadata)
        const iterationCacheRead = anthropicExecutorCache(metadata, "cache_read_input_tokens")
        const iterationCacheWrite = anthropicExecutorCache(metadata, "cache_creation_input_tokens")
        if (iterationCacheRead !== undefined)
          state.cacheReadAdjustment =
            (state.cacheReadAdjustment ?? 0) +
            iterationCacheRead -
            (event.usage.inputTokenDetails.cacheReadTokens ?? event.usage.cachedInputTokens ?? 0)
        if (iterationCacheWrite !== undefined)
          state.cacheWriteAdjustment =
            (state.cacheWriteAdjustment ?? 0) +
            iterationCacheWrite -
            (event.usage.inputTokenDetails.cacheWriteTokens ?? 0)
        if (iterationCacheWrite === undefined && event.usage.inputTokenDetails.cacheWriteTokens === undefined)
          state.recoveredCacheWrite =
            recoveredCacheWrite === undefined
              ? state.recoveredCacheWrite
              : (state.recoveredCacheWrite ?? 0) + recoveredCacheWrite
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage, metadata),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(
              event.totalUsage,
              undefined,
              state.cacheReadAdjustment,
              state.cacheWriteAdjustment,
              state.recoveredCacheWrite,
            ),
            providerMetadata: undefined,
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
