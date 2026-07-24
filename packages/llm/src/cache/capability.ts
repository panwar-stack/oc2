export const CACHE_CAPABILITY_VERSION = 1

export type CacheClassification =
  | "cache_hit"
  | "cache_write"
  | "expected_cache_miss"
  | "unexpected_cache_miss"
  | "cache_unsupported"
  | "cache_telemetry_unavailable"
  | "cache_configuration_error"
  | "provider_error"

export const cacheClassifications = [
  "cache_hit",
  "cache_write",
  "expected_cache_miss",
  "unexpected_cache_miss",
  "cache_unsupported",
  "cache_telemetry_unavailable",
  "cache_configuration_error",
  "provider_error",
] as const satisfies ReadonlyArray<CacheClassification>

export type CachePromptCaching = "unsupported" | "automatic" | "explicit" | "automatic_and_explicit"
export type CacheMode = "disabled" | "automatic" | "implicit" | "explicit"
export type CacheSupportedMode = "automatic" | "implicit" | "explicit"
export type CacheDuration = "5m" | "1h"

export interface CacheCapabilities {
  readonly version: number
  readonly provider: string
  readonly modelPattern: string
  readonly status: "known" | "unknown"
  readonly promptCaching: CachePromptCaching
  readonly supportsCacheKey: boolean
  readonly supportsBreakpoints: boolean
  readonly supportsDuration: boolean
  readonly minimumPrefixTokens: number | null
  readonly maximumBreakpoints: number | null
  readonly reportsCacheReadTokens: boolean
  readonly reportsCacheWriteTokens: boolean
  readonly reportsCacheMissTokens: boolean
  readonly telemetryUnavailable: boolean
  readonly cacheWriteHasAdditionalCost: boolean
  readonly cacheReadReceivesDiscount: boolean
  readonly warmup: {
    readonly policy: "none" | "first_request" | "multiple_requests" | "best_effort"
    readonly requests: number
  }
  readonly retention: { readonly policy: "fixed" | "probable" | "unknown"; readonly seconds: number | null }
  readonly supportedModes: ReadonlyArray<CacheSupportedMode>
  readonly supportedBreakpointContentTypes: ReadonlyArray<string>
  readonly supportedDurations: ReadonlyArray<CacheDuration>
  readonly requestFields: ReadonlyArray<string>
  readonly responseUsageFields: ReadonlyArray<string>
  readonly routingKeyTrafficLimit: number | null
  readonly conclusiveVerification: boolean
}

export interface CachePlan {
  readonly provider: string
  readonly model: string
  readonly mode: CacheMode
  readonly cacheKey: string | null
  readonly trafficPartition: string | null
  readonly stablePrefixFingerprint: string
  readonly componentFingerprints: Record<string, string>
  readonly prefixTokenCount: number | null
  readonly minimumPrefixTokens: number | null
  readonly eligible: boolean
  readonly breakpoints: ReadonlyArray<{
    readonly component: string
    readonly contentType: string
    readonly index: number
  }>
  readonly duration: CacheDuration | null
}

export interface CacheTelemetry {
  readonly provider?: string
  readonly model?: string
  readonly inputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly cacheMissTokens: number | null
  readonly uncachedInputTokens: number | null
  readonly metricsAvailable: boolean
  readonly eligible: boolean
  readonly expected: boolean
  readonly verified: boolean
  readonly classification: CacheClassification
  readonly providerRawUsageFieldNames: ReadonlyArray<string>
  readonly warmupRequestNumber: number | null
  readonly estimatedCacheCost: number | null
  readonly estimatedUncachedCost: number | null
  readonly estimatedSavings: number | null
}

export interface CacheDiagnosticComponent {
  readonly component: string
  readonly fingerprint: string | null
  readonly previousFingerprint: string | null
  readonly changed: boolean
}

export interface CacheDiagnostic {
  readonly provider: string
  readonly model: string
  readonly classification: CacheClassification
  readonly stablePrefixFingerprint: string | null
  readonly previousStablePrefixFingerprint: string | null
  readonly components: ReadonlyArray<CacheDiagnosticComponent>
  readonly reason: string | null
  readonly correctiveAction: string | null
}

export const unknownCacheCapabilities: CacheCapabilities = {
  version: CACHE_CAPABILITY_VERSION,
  provider: "unknown",
  modelPattern: "*",
  status: "unknown",
  promptCaching: "unsupported",
  supportsCacheKey: false,
  supportsBreakpoints: false,
  supportsDuration: false,
  minimumPrefixTokens: null,
  maximumBreakpoints: null,
  reportsCacheReadTokens: false,
  reportsCacheWriteTokens: false,
  reportsCacheMissTokens: false,
  telemetryUnavailable: true,
  cacheWriteHasAdditionalCost: false,
  cacheReadReceivesDiscount: false,
  warmup: { policy: "none", requests: 0 },
  retention: { policy: "unknown", seconds: null },
  supportedModes: [],
  supportedBreakpointContentTypes: [],
  supportedDurations: [],
  requestFields: [],
  responseUsageFields: [],
  routingKeyTrafficLimit: null,
  conclusiveVerification: false,
}

export const cacheCapabilityRecords = [
  {
    version: CACHE_CAPABILITY_VERSION,
    provider: "openai",
    modelPattern: "gpt-4.1*|gpt-4o*|gpt-5*|o1*|o3*|o4*",
    status: "known",
    promptCaching: "automatic_and_explicit",
    supportsCacheKey: true,
    supportsBreakpoints: false,
    supportsDuration: false,
    minimumPrefixTokens: 1024,
    maximumBreakpoints: null,
    reportsCacheReadTokens: true,
    reportsCacheWriteTokens: true,
    reportsCacheMissTokens: false,
    telemetryUnavailable: false,
    cacheWriteHasAdditionalCost: false,
    cacheReadReceivesDiscount: true,
    warmup: { policy: "first_request", requests: 1 },
    retention: { policy: "probable", seconds: null },
    supportedModes: ["automatic", "implicit", "explicit"],
    supportedBreakpointContentTypes: [],
    supportedDurations: [],
    requestFields: ["prompt_cache_key"],
    responseUsageFields: [
      "input_tokens_details.cached_tokens",
      "input_tokens_details.cache_write_tokens",
      "prompt_tokens_details.cached_tokens",
      "prompt_tokens_details.cache_write_tokens",
    ],
    routingKeyTrafficLimit: 100,
    conclusiveVerification: true,
  },
  {
    version: CACHE_CAPABILITY_VERSION,
    provider: "anthropic",
    modelPattern: "claude-*haiku*",
    status: "known",
    promptCaching: "explicit",
    supportsCacheKey: false,
    supportsBreakpoints: true,
    supportsDuration: true,
    minimumPrefixTokens: 2048,
    maximumBreakpoints: 4,
    reportsCacheReadTokens: true,
    reportsCacheWriteTokens: true,
    reportsCacheMissTokens: false,
    telemetryUnavailable: false,
    cacheWriteHasAdditionalCost: true,
    cacheReadReceivesDiscount: true,
    warmup: { policy: "first_request", requests: 1 },
    retention: { policy: "fixed", seconds: 300 },
    supportedModes: ["explicit"],
    supportedBreakpointContentTypes: ["system", "tool", "message"],
    supportedDurations: ["5m", "1h"],
    requestFields: ["cache_control"],
    responseUsageFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
    routingKeyTrafficLimit: null,
    conclusiveVerification: true,
  },
  {
    version: CACHE_CAPABILITY_VERSION,
    provider: "anthropic",
    modelPattern: "claude-*",
    status: "known",
    promptCaching: "explicit",
    supportsCacheKey: false,
    supportsBreakpoints: true,
    supportsDuration: true,
    minimumPrefixTokens: 1024,
    maximumBreakpoints: 4,
    reportsCacheReadTokens: true,
    reportsCacheWriteTokens: true,
    reportsCacheMissTokens: false,
    telemetryUnavailable: false,
    cacheWriteHasAdditionalCost: true,
    cacheReadReceivesDiscount: true,
    warmup: { policy: "first_request", requests: 1 },
    retention: { policy: "fixed", seconds: 300 },
    supportedModes: ["explicit"],
    supportedBreakpointContentTypes: ["system", "tool", "message"],
    supportedDurations: ["5m", "1h"],
    requestFields: ["cache_control"],
    responseUsageFields: ["cache_creation_input_tokens", "cache_read_input_tokens"],
    routingKeyTrafficLimit: null,
    conclusiveVerification: true,
  },
  {
    version: CACHE_CAPABILITY_VERSION,
    provider: "moonshot",
    modelPattern: "kimi*|moonshot*",
    status: "known",
    promptCaching: "automatic",
    supportsCacheKey: false,
    supportsBreakpoints: false,
    supportsDuration: false,
    minimumPrefixTokens: null,
    maximumBreakpoints: null,
    reportsCacheReadTokens: false,
    reportsCacheWriteTokens: false,
    reportsCacheMissTokens: false,
    telemetryUnavailable: true,
    cacheWriteHasAdditionalCost: false,
    cacheReadReceivesDiscount: true,
    warmup: { policy: "best_effort", requests: 0 },
    retention: { policy: "unknown", seconds: null },
    supportedModes: ["automatic"],
    supportedBreakpointContentTypes: [],
    supportedDurations: [],
    requestFields: [],
    responseUsageFields: [],
    routingKeyTrafficLimit: null,
    conclusiveVerification: false,
  },
  {
    version: CACHE_CAPABILITY_VERSION,
    provider: "deepseek",
    modelPattern: "deepseek-*",
    status: "known",
    promptCaching: "automatic",
    supportsCacheKey: false,
    supportsBreakpoints: false,
    supportsDuration: false,
    minimumPrefixTokens: null,
    maximumBreakpoints: null,
    reportsCacheReadTokens: true,
    reportsCacheWriteTokens: false,
    reportsCacheMissTokens: true,
    telemetryUnavailable: false,
    cacheWriteHasAdditionalCost: false,
    cacheReadReceivesDiscount: true,
    warmup: { policy: "best_effort", requests: 1 },
    retention: { policy: "unknown", seconds: null },
    supportedModes: ["automatic"],
    supportedBreakpointContentTypes: [],
    supportedDurations: [],
    requestFields: [],
    responseUsageFields: ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"],
    routingKeyTrafficLimit: null,
    conclusiveVerification: false,
  },
] as const satisfies ReadonlyArray<CacheCapabilities>

const openAICapabilities = cacheCapabilityRecords[0]
const openAICompatibleUnsupportedProviders = new Set(["deepseek", "kimi", "moonshot", "moonshot-ai", "moonshotai"])

export const getUnknownCacheCapabilities = (provider = "unknown", modelPattern = "*"): CacheCapabilities => ({
  ...unknownCacheCapabilities,
  provider,
  modelPattern,
})

export const getCacheCapabilities = (provider: string, model: string): CacheCapabilities => {
  const normalizedProvider = normalizeProvider(provider)
  const normalizedModel = model.toLowerCase()
  const record = cacheCapabilityRecords.find(
    (capabilities) =>
      capabilities.provider === normalizedProvider &&
      capabilities.modelPattern.split("|").some((pattern) => matchesPattern(normalizedModel, pattern)),
  )

  if (record) return record

  if (isOpenAICompatibleModel(normalizedProvider, normalizedModel)) {
    return { ...openAICapabilities, provider: normalizedProvider }
  }

  return getUnknownCacheCapabilities(normalizedProvider, model)
}

const isOpenAICompatibleModel = (provider: string, model: string) => {
  if (openAICompatibleUnsupportedProviders.has(provider) || model.includes("kimi")) return false
  return openAICapabilities.modelPattern.split("|").some((pattern) => matchesPattern(model, pattern))
}

const matchesPattern = (value: string, pattern: string) => {
  const [head = "", ...tail] = pattern.split("*")
  if (tail.length === 0) return value === pattern
  if (!value.startsWith(head)) return false

  let offset = head.length
  for (const segment of tail) {
    if (segment === "") continue
    const index = value.indexOf(segment, offset)
    if (index === -1) return false
    offset = index + segment.length
  }
  return pattern.endsWith("*") || offset === value.length
}

const normalizeProvider = (provider: string) =>
  provider.toLowerCase() === "kimi" || provider.toLowerCase() === "moonshot-ai" || provider.toLowerCase() === "moonshotai"
    ? "moonshot"
    : provider.toLowerCase()
