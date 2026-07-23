import type { CacheClassification, CachePlan, CacheTelemetry } from "./capability"

export type CacheNotificationCode = "unexpected_cache_miss" | "cache_configuration_error" | "provider_error"

export interface CacheNotification {
  readonly code: CacheNotificationCode
  readonly classification: Extract<CacheClassification, CacheNotificationCode>
  readonly severity: "warning" | "error"
  readonly message: string
}

export interface CacheNotificationInput {
  readonly telemetry?: CacheTelemetry | null
  readonly plan?: CachePlan | null
  readonly providerFailure?: boolean
  readonly configurationError?: boolean
  readonly compaction?: boolean
  readonly expectedExpiration?: boolean
  readonly bestEffortSingleMiss?: boolean
}

export const notification = (input: CacheNotificationInput): CacheNotification | null => {
  const classification = input.configurationError
    ? "cache_configuration_error"
    : input.providerFailure
      ? "provider_error"
      : input.telemetry?.classification
  if (classification === "cache_configuration_error") {
    return {
      code: "cache_configuration_error",
      classification,
      severity: "error",
      message: "Prompt cache configuration is invalid for this provider or model.",
    }
  }
  if (classification === "provider_error") {
    return {
      code: "provider_error",
      classification,
      severity: "error",
      message: "Provider request failed before prompt cache behavior could be verified.",
    }
  }
  if (classification !== "unexpected_cache_miss" || input.telemetry?.verified !== true) return null
  const suppressed =
    input.telemetry.expected ||
    input.telemetry.metricsAvailable !== true ||
    input.plan?.eligible === false ||
    belowThreshold(input.plan) ||
    input.compaction === true ||
    input.expectedExpiration === true ||
    input.bestEffortSingleMiss === true
  if (suppressed) return null
  return {
    code: "unexpected_cache_miss",
    classification,
    severity: "warning",
    message: "Provider reported an unexpected prompt cache miss after the cache was expected to be warm.",
  }
}

export const shouldNotify = (input: CacheNotificationInput) => notification(input) !== null

const belowThreshold = (plan: CachePlan | null | undefined) =>
  plan?.prefixTokenCount !== null &&
  plan?.prefixTokenCount !== undefined &&
  plan.minimumPrefixTokens !== null &&
  plan.prefixTokenCount < plan.minimumPrefixTokens

export * as CacheWarnings from "./warnings"
