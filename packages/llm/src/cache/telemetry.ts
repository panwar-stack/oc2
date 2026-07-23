import {
  cacheClassifications,
  getCacheCapabilities,
  type CacheCapabilities,
  type CacheClassification,
  type CachePlan,
  type CacheTelemetry,
} from "./capability"

export interface CacheTelemetryInput {
  readonly provider: string
  readonly model: string
  readonly plan?: CachePlan | null
  readonly inputTokens?: number | null
  readonly cacheReadTokens?: number | null
  readonly cacheWriteTokens?: number | null
  readonly cacheMissTokens?: number | null
  readonly providerRawUsageFieldNames?: ReadonlyArray<string>
  readonly warmupRequestNumber?: number | null
  readonly metricsAvailable?: boolean
  readonly eligible?: boolean
  readonly expected?: boolean
  readonly providerError?: boolean
  readonly configurationError?: boolean
  readonly estimatedCacheCost?: number | null
  readonly estimatedUncachedCost?: number | null
}

export const normalize = (input: CacheTelemetryInput): CacheTelemetry => {
  const capabilities = getCacheCapabilities(input.provider, input.model)
  const inputTokens = token(input.inputTokens)
  const cacheReadTokens = token(input.cacheReadTokens)
  const cacheWriteTokens = token(input.cacheWriteTokens)
  const cacheMissTokens = token(input.cacheMissTokens)
  const metricsAvailable = input.metricsAvailable ?? hasReportedMetric(cacheReadTokens, cacheWriteTokens, cacheMissTokens)
  const eligible = input.eligible ?? input.plan?.eligible ?? capabilities.promptCaching !== "unsupported"
  const warmupRequestNumber = token(input.warmupRequestNumber)
  const expected =
    input.expected ??
    (!eligible ||
      capabilities.promptCaching === "unsupported" ||
      isWarmup(capabilities, warmupRequestNumber) ||
      isBelowThreshold(input.plan))
  const classification = classify({
    capabilities,
    providerError: input.providerError === true,
    configurationError: input.configurationError === true,
    metricsAvailable,
    eligible,
    expected,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
    warmupRequestNumber,
  })
  const estimatedCacheCost = money(input.estimatedCacheCost)
  const estimatedUncachedCost = money(input.estimatedUncachedCost)
  return {
    provider: input.provider,
    model: input.model,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
    uncachedInputTokens: uncachedInput(inputTokens, cacheReadTokens, cacheWriteTokens, cacheMissTokens),
    metricsAvailable,
    eligible,
    expected,
    verified: classification === "cache_hit" || classification === "cache_write" || classification === "unexpected_cache_miss",
    classification,
    providerRawUsageFieldNames: input.providerRawUsageFieldNames ?? [],
    warmupRequestNumber,
    estimatedCacheCost,
    estimatedUncachedCost,
    estimatedSavings:
      estimatedCacheCost === null || estimatedUncachedCost === null ? null : estimatedUncachedCost - estimatedCacheCost,
  }
}

export const isCacheClassification = (value: unknown): value is CacheClassification =>
  typeof value === "string" && cacheClassifications.includes(value as CacheClassification)

export const forceClassification = (
  telemetry: CacheTelemetry,
  classification: Extract<CacheClassification, "provider_error" | "cache_configuration_error">,
): CacheTelemetry => ({
  ...telemetry,
  classification,
  verified: false,
})

const classify = (input: {
  readonly capabilities: CacheCapabilities
  readonly providerError: boolean
  readonly configurationError: boolean
  readonly metricsAvailable: boolean
  readonly eligible: boolean
  readonly expected: boolean
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly cacheMissTokens: number | null
  readonly warmupRequestNumber: number | null
}): CacheClassification => {
  if (input.providerError) return "provider_error"
  if (input.configurationError) return "cache_configuration_error"
  if (input.capabilities.promptCaching === "unsupported" || !input.eligible) return "cache_unsupported"
  if (!input.metricsAvailable || input.capabilities.telemetryUnavailable) return "cache_telemetry_unavailable"
  if ((input.cacheReadTokens ?? 0) > 0) return "cache_hit"
  if ((input.cacheWriteTokens ?? 0) > 0) return "cache_write"
  if (input.expected) return "expected_cache_miss"
  if (input.capabilities.provider === "deepseek") {
    if ((input.cacheMissTokens ?? 0) <= 0) return "expected_cache_miss"
    if (input.warmupRequestNumber === null) return "expected_cache_miss"
    if (isWarmup(input.capabilities, input.warmupRequestNumber)) return "expected_cache_miss"
  }
  if ((input.cacheMissTokens ?? 0) > 0 || input.capabilities.conclusiveVerification) return "unexpected_cache_miss"
  return "expected_cache_miss"
}

const token = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null

const money = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

const hasReportedMetric = (...values: ReadonlyArray<number | null>) => values.some((value) => value !== null)

const isWarmup = (capabilities: CacheCapabilities, requestNumber: number | null) =>
  requestNumber !== null && capabilities.warmup.requests > 0 && requestNumber <= capabilities.warmup.requests

const isBelowThreshold = (plan: CachePlan | null | undefined) =>
  plan?.prefixTokenCount !== null &&
  plan?.prefixTokenCount !== undefined &&
  plan.minimumPrefixTokens !== null &&
  plan.prefixTokenCount < plan.minimumPrefixTokens

const uncachedInput = (
  inputTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
  cacheMissTokens: number | null,
) => {
  if (cacheMissTokens !== null) return cacheMissTokens
  if (inputTokens === null) return null
  const reported = [cacheReadTokens, cacheWriteTokens].filter((value): value is number => value !== null)
  if (reported.length === 0) return null
  return Math.max(0, inputTokens - reported.reduce((sum, value) => sum + value, 0))
}

export * as CacheTelemetry from "./telemetry"
