import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@oc2-ai/llm"
import { ProviderShared } from "@oc2-ai/llm/protocols"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export type UsageIdentity = {
  readonly providerID: string
  readonly modelID: string
  readonly apiPackage: string
}

type UsageProfile = "standard" | "xai" | "deepinfra" | "deepinfra-exclusive" | "deepseek" | "openrouter"

const usageProfile = (identity: UsageIdentity | undefined): UsageProfile => {
  if (!identity?.modelID) return "standard"
  if (identity.providerID === "xai") return "xai"
  if (identity.providerID === "deepinfra") {
    const model = identity.modelID.toLowerCase()
    return model.startsWith("google/gemini-") || model.startsWith("google/gemma-")
      ? "deepinfra-exclusive"
      : "deepinfra"
  }
  if (identity.providerID === "deepseek") return "deepseek"
  if (identity.providerID === "openrouter") return "openrouter"
  return "standard"
}

// Profiled providers need raw terminal provenance because the AI SDK retains usage from non-terminal chunks.
export const requiresRawChunks = (identity: UsageIdentity) => usageProfile(identity) !== "standard"

const usageTotal = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export function adapterState(identity?: UsageIdentity) {
  return {
    identity,
    usageProfile: usageProfile(identity),
    profileUsageTotal: usageTotal(),
    profileUsageReported: { cacheRead: false, cacheWrite: false, reasoning: false },
    profileUsageSteps: 0,
    profileUsageComplete: true,
    providerTotal: undefined as number | undefined,
    providerTotalComplete: true,
    profileRawSeen: false,
    profileRawUsage: undefined as unknown,
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

function mergeRecords(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = { ...left }
  for (const [key, value] of Object.entries(right)) {
    const previous = result[key]
    result[key] = isRecord(previous) && isRecord(value) ? mergeRecords(previous, value) : value
  }
  return result
}

export function mergeUsageProviderMetadata(
  metadata: ProviderMetadata | undefined,
  usageMetadata: ProviderMetadata | undefined,
): ProviderMetadata | undefined {
  const result: Record<string, Record<string, unknown>> = {}
  // Usage metadata is already protocol-sanitized and must win over raw top-level observations.
  for (const value of [usageProviderMetadata(metadata), usageMetadata]) {
    if (!value) continue
    for (const [provider, fields] of Object.entries(value)) {
      const previous = result[provider]
      if (provider === "openrouter" && isRecord(previous?.usage) && isRecord(fields.usage)) {
        const duplicates = new Set<string>()
        for (const [camel, snake] of [
          ["inputTokens", "input_tokens"],
          ["outputTokens", "output_tokens"],
          ["promptTokens", "prompt_tokens"],
          ["completionTokens", "completion_tokens"],
          ["totalTokens", "total_tokens"],
          ["costDetails", "cost_details"],
          ["promptTokensDetails", "prompt_tokens_details"],
          ["completionTokensDetails", "completion_tokens_details"],
        ])
          if (snake in fields.usage) duplicates.add(camel)
        if ("input_tokens_details" in fields.usage) {
          duplicates.add("promptTokensDetails")
          duplicates.add("cachedInputTokens")
        }
        if ("output_tokens_details" in fields.usage) {
          duplicates.add("completionTokensDetails")
          duplicates.add("reasoningTokens")
        }
        result[provider] = {
          ...fields,
          usage: Object.fromEntries(
            Object.entries(mergeRecords(previous.usage, fields.usage)).filter(([key]) => !duplicates.has(key)),
          ),
        }
        continue
      }
      result[provider] = mergeRecords(previous ?? {}, fields)
    }
  }
  return Object.keys(result).length ? result : undefined
}

type UsageValue = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
  readonly cachedInputTokens?: number
  readonly inputTokenDetails?: {
    readonly noCacheTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  }
  readonly outputTokenDetails?: { readonly textTokens?: number; readonly reasoningTokens?: number }
  readonly raw?: unknown
}

type UsageTuple = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly providerTotal?: number
  readonly providerMetadata?: ProviderMetadata
  readonly reported: { readonly cacheRead: boolean; readonly cacheWrite: boolean; readonly reasoning: boolean }
}

type ProfileUsageObservation =
  | { readonly status: "unprofiled" | "unknown" | "incomplete" }
  | { readonly status: "complete"; readonly usage: UsageTuple }

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

function profileUsage(profile: UsageProfile, value: unknown): ProfileUsageObservation {
  if (profile === "standard") return { status: "unprofiled" }
  if (value === undefined) return { status: "unknown" }
  if (!isRecord(value)) return { status: "incomplete" }
  const token = (record: Record<string, unknown>, field: string, allowNull = false) => {
    if (!(field in record)) return { status: "absent" as const, value: undefined }
    const item = record[field]
    if (allowNull && item === null) return { status: "absent" as const, value: undefined }
    return typeof item === "number" && Number.isFinite(item) && Number.isInteger(item) && item >= 0
      ? { status: "valid" as const, value: item }
      : { status: "invalid" as const, value: undefined }
  }
  const details = (field: string) => {
    if (!(field in value)) return { status: "absent" as const, value: undefined }
    const item = value[field]
    if (item === null) return { status: "null" as const, value: undefined }
    return isRecord(item)
      ? { status: "valid" as const, value: item }
      : { status: "invalid" as const, value: undefined }
  }
  const inputDetailsKey =
    "input_tokens_details" in value
      ? "input_tokens_details"
      : "prompt_tokens_details" in value
        ? "prompt_tokens_details"
        : undefined
  const outputDetailsKey =
    "output_tokens_details" in value
      ? "output_tokens_details"
      : "completion_tokens_details" in value
        ? "completion_tokens_details"
        : undefined
  const inputDetailsValue = inputDetailsKey === undefined ? undefined : value[inputDetailsKey]
  const outputDetailsValue = outputDetailsKey === undefined ? undefined : value[outputDetailsKey]
  const inputDetails = isRecord(inputDetailsValue) ? inputDetailsValue : undefined
  const outputDetails = isRecord(outputDetailsValue) ? outputDetailsValue : undefined
  const allowNullCacheWrite = profile === "openrouter" || profile === "xai"
  const inputTokens = token(value, "input_tokens")
  const promptTokens = token(value, "prompt_tokens")
  const outputTokens = token(value, "output_tokens")
  const completionTokens = token(value, "completion_tokens")
  const totalTokens = token(value, "total_tokens")
  const promptCacheHit = token(value, "prompt_cache_hit_tokens")
  const promptCacheMiss = token(value, "prompt_cache_miss_tokens")
  const inputDetailsObservations = [details("input_tokens_details"), details("prompt_tokens_details")]
  const outputDetailsObservations = [details("output_tokens_details"), details("completion_tokens_details")]
  const inputDetailTokens = inputDetailsObservations.flatMap((observation) =>
    observation.status === "valid"
      ? [
          token(observation.value, "cached_tokens"),
          token(observation.value, "cache_write_tokens", allowNullCacheWrite),
        ]
      : [],
  )
  const outputDetailTokens = outputDetailsObservations.flatMap((observation) =>
    observation.status === "valid" ? [token(observation.value, "reasoning_tokens")] : [],
  )
  if (
    [inputTokens, promptTokens, outputTokens, completionTokens, totalTokens, promptCacheHit, promptCacheMiss]
      .concat(inputDetailTokens, outputDetailTokens)
      .some((observation) => observation.status === "invalid") ||
    inputDetailsObservations.some((observation) => observation.status === "invalid") ||
    outputDetailsObservations.some((observation) => observation.status === "invalid")
  )
    return { status: "incomplete" }
  const rawInput = inputTokens.value ?? promptTokens.value
  const reportedOutput = outputTokens.value ?? completionTokens.value
  if (rawInput === undefined || reportedOutput === undefined) return { status: "incomplete" }
  const detailsCacheRead = inputDetails ? token(inputDetails, "cached_tokens").value : undefined
  const cacheRead = profile === "deepseek" ? (promptCacheHit.value ?? detailsCacheRead) : detailsCacheRead
  const cacheWrite = inputDetails
    ? token(inputDetails, "cache_write_tokens", allowNullCacheWrite).value
    : undefined
  const reasoning = outputDetails ? token(outputDetails, "reasoning_tokens").value : undefined
  const deepinfraExclusive = profile === "deepinfra-exclusive"
  const reportedTotal = totalTokens.value
  const sanitized = pickUsageNumbers(value, [
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
    "cost",
    "cost_in_usd_ticks",
  ])
  if (typeof value.is_byok === "boolean") sanitized.is_byok = value.is_byok
  const sanitizedInputDetails = pickUsageNumbers(inputDetails, ["cached_tokens", "cache_write_tokens"])
  const sanitizedOutputDetails = pickUsageNumbers(outputDetails, ["reasoning_tokens"])
  const costDetails = pickUsageNumbers(value.cost_details, [
    "upstream_inference_cost",
    "upstream_inference_prompt_cost",
    "upstream_inference_completions_cost",
  ])
  if (inputDetailsKey !== undefined && (inputDetailsValue === null || Object.keys(sanitizedInputDetails).length))
    sanitized[inputDetailsKey] = inputDetailsValue === null ? null : sanitizedInputDetails
  if (outputDetailsKey !== undefined && (outputDetailsValue === null || Object.keys(sanitizedOutputDetails).length))
    sanitized[outputDetailsKey] = outputDetailsValue === null ? null : sanitizedOutputDetails
  if (value.cost_details === null || Object.keys(costDetails).length)
    sanitized.cost_details = value.cost_details === null ? null : costDetails
  const providerMetadata =
    profile === "openrouter"
      ? { openrouter: { usage: sanitized } }
      : { [profile.startsWith("deepinfra") ? "deepinfra" : profile]: sanitized }
  const inputAfterCacheRead =
    profile === "xai" && (cacheRead ?? 0) > rawInput ? rawInput : Math.max(0, rawInput - (cacheRead ?? 0))
  return {
    status: "complete",
    usage: {
      input:
        profile === "xai"
          ? Math.max(0, inputAfterCacheRead - (cacheWrite ?? 0))
          : Math.max(0, rawInput - (cacheRead ?? 0) - (cacheWrite ?? 0)),
      output:
        profile === "xai" || deepinfraExclusive
          ? reportedOutput
          : Math.max(0, reportedOutput - (reasoning ?? 0)),
      reasoning: reasoning ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
      providerTotal: reportedTotal,
      providerMetadata,
      reported: {
        cacheRead: cacheRead !== undefined,
        cacheWrite: cacheWrite !== undefined,
        reasoning: reasoning !== undefined,
      },
    },
  }
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

function genericUsage(
  item: UsageValue,
  metadata: ProviderMetadata | undefined,
  cacheReadAdjustment?: number,
  cacheWriteAdjustment?: number,
  recoveredCacheWrite?: number,
): UsageTuple | undefined {
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
  return {
    input:
      metadataOnlyWrite && item.inputTokens !== undefined
        ? Math.max(0, item.inputTokens - (cacheRead ?? 0) - metadataWrite)
        : (item.inputTokenDetails?.noCacheTokens ??
          (item.inputTokens === undefined ? 0 : Math.max(0, item.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)))),
    output:
      item.outputTokenDetails?.textTokens ??
      (item.outputTokens === undefined ? 0 : Math.max(0, item.outputTokens - (reasoning ?? 0))),
    reasoning: reasoning ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    providerTotal: metadataProviderTotal(metadata),
    providerMetadata: usageProviderMetadata(metadata),
    reported: {
      cacheRead: cacheRead !== undefined,
      cacheWrite: cacheWrite !== undefined,
      reasoning: reasoning !== undefined,
    },
  }
}

function usage(
  value: unknown,
  options: {
    readonly metadata?: ProviderMetadata
    readonly profile: UsageProfile
    readonly cacheReadAdjustment?: number
    readonly cacheWriteAdjustment?: number
    readonly recoveredCacheWrite?: number
    readonly profileUsage?: ProfileUsageObservation
  },
) {
  if (!value || typeof value !== "object") return undefined
  const item = value as UsageValue
  const observation = options.profileUsage ?? profileUsage(options.profile, item.raw)
  if (observation.status === "unknown" || observation.status === "incomplete") return undefined
  const raw = observation.status === "complete" ? observation.usage : undefined
  const base =
    raw ??
    genericUsage(
      item,
      options.metadata,
      options.cacheReadAdjustment,
      options.cacheWriteAdjustment,
      options.recoveredCacheWrite,
    )
  if (!base) return undefined
  const metadata = mergeUsageProviderMetadata(options.metadata, raw?.providerMetadata)
  return ProviderShared.usage(
    {
      input: base.input,
      output: base.output,
      reasoning: base.reasoning,
      cache: { read: base.cacheRead, write: base.cacheWrite },
      providerTotal: raw?.providerTotal ?? base.providerTotal,
      providerMetadata: metadata,
    },
    {
      cacheRead: base.reported.cacheRead,
      cacheWrite: base.reported.cacheWrite,
      reasoning: base.reported.reasoning,
    },
  )
}

function recordProfileUsage(
  state: ReturnType<typeof adapterState>,
  value: UsageValue,
) {
  const observation = profileUsage(state.usageProfile, value.raw)
  if (observation.status === "unprofiled") return observation
  if (observation.status !== "complete") {
    state.profileUsageComplete = false
    return observation
  }
  const usage = observation.usage
  state.profileUsageSteps += 1
  state.profileUsageTotal.input += usage.input
  state.profileUsageTotal.output += usage.output
  state.profileUsageTotal.reasoning += usage.reasoning
  state.profileUsageTotal.cacheRead += usage.cacheRead
  state.profileUsageTotal.cacheWrite += usage.cacheWrite
  state.profileUsageReported.cacheRead ||= usage.reported.cacheRead
  state.profileUsageReported.cacheWrite ||= usage.reported.cacheWrite
  state.profileUsageReported.reasoning ||= usage.reported.reasoning
  if (usage.providerTotal === undefined) state.providerTotalComplete = false
  else state.providerTotal = (state.providerTotal ?? 0) + usage.providerTotal
  return observation
}

function cumulativeProfileUsage(state: ReturnType<typeof adapterState>) {
  if (state.profileUsageSteps === 0 || !state.profileUsageComplete) return undefined
  return ProviderShared.usage(
    {
      input: state.profileUsageTotal.input,
      output: state.profileUsageTotal.output,
      reasoning: state.profileUsageTotal.reasoning,
      cache: { read: state.profileUsageTotal.cacheRead, write: state.profileUsageTotal.cacheWrite },
      providerTotal: state.providerTotalComplete ? state.providerTotal : undefined,
    },
    state.profileUsageReported,
  )
}

function terminalProfileUsage(value: unknown) {
  if (!isRecord(value)) return { terminal: false as const, usage: undefined }
  const response = isRecord(value.response) ? value.response : undefined
  const usage = value.usage ?? response?.usage
  const responseTerminal =
    value.type === "response.done" ||
    value.type === "response.completed" ||
    value.type === "response.failed" ||
    value.type === "response.incomplete"
  const choices = Array.isArray(value.choices) ? value.choices : undefined
  const finishTerminal = choices?.some((choice) => isRecord(choice) && choice.finish_reason != null) ?? false
  const usageTerminal = choices?.length === 0 && usage !== undefined
  return responseTerminal || finishTerminal || usageTerminal
    ? { terminal: true as const, usage }
    : { terminal: false as const, usage: undefined }
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
        const eventUsage = state.profileRawSeen ? { ...event.usage, raw: state.profileRawUsage } : event.usage
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
        const profileUsage = recordProfileUsage(state, eventUsage)
        state.profileRawSeen = false
        state.profileRawUsage = undefined
        state.copilotTotalNanoAiu = undefined
        const stepUsage = usage(eventUsage, { metadata, profile: state.usageProfile, profileUsage })
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: stepUsage,
            providerMetadata: stepUsage?.providerMetadata ?? usageProviderMetadata(metadata),
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage:
              state.usageProfile === "standard"
                ? usage(event.totalUsage, {
                    profile: state.usageProfile,
                    cacheReadAdjustment: state.cacheReadAdjustment,
                    cacheWriteAdjustment: state.cacheWriteAdjustment,
                    recoveredCacheWrite: state.recoveredCacheWrite,
                  })
                : cumulativeProfileUsage(state),
            providerMetadata: undefined,
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState(state.identity))
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
        if (state.usageProfile !== "standard") {
          state.profileRawSeen = true
          const observation = terminalProfileUsage(event.rawValue)
          if (observation.terminal && observation.usage !== undefined && state.profileRawUsage === undefined)
            state.profileRawUsage = observation.usage
        }
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
