import type { CacheDiagnostic, CachePlan, CacheTelemetry } from "./capability"
import { normalize } from "./telemetry"
import { notification, type CacheNotification } from "./warnings"

export interface CacheInvocationLogInput {
  readonly requestID?: string | null
  readonly provider?: string
  readonly model?: string
  readonly route?: string | null
  readonly plan?: CachePlan | null
  readonly telemetry?: CacheTelemetry | null
  readonly diagnostic?: CacheDiagnostic | null
  readonly notification?: CacheNotification | null
  readonly providerFailure?: boolean
  readonly configurationError?: boolean
  readonly compaction?: boolean
  readonly expectedExpiration?: boolean
  readonly bestEffortSingleMiss?: boolean
}

export interface CacheInvocationLogEvent {
  readonly type: "cache-invocation"
  readonly requestID: string | null
  readonly provider: string
  readonly model: string
  readonly route: string | null
  readonly mode: CachePlan["mode"] | null
  readonly eligible: boolean
  readonly classification: CacheTelemetry["classification"] | null
  readonly verified: boolean
  readonly metricsAvailable: boolean
  readonly stablePrefixFingerprint: string | null
  readonly componentFingerprints: Record<string, string>
  readonly cacheKey: string | null
  readonly trafficPartition: string | null
  readonly prefixTokenCount: number | null
  readonly minimumPrefixTokens: number | null
  readonly inputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly cacheMissTokens: number | null
  readonly uncachedInputTokens: number | null
  readonly providerRawUsageFieldNames: ReadonlyArray<string>
  readonly warmupRequestNumber: number | null
  readonly estimatedCacheCost: number | null
  readonly estimatedUncachedCost: number | null
  readonly estimatedSavings: number | null
  readonly notification: CacheNotification | null
  readonly diagnostic: CacheDiagnostic | null
}

export const event = (input: CacheInvocationLogInput): CacheInvocationLogEvent => {
  const plan = input.plan ?? null
  const telemetry = input.telemetry ??
    (plan ? normalize({ provider: input.provider ?? plan.provider, model: input.model ?? plan.model, plan }) : null)
  return {
    type: "cache-invocation",
    requestID: input.requestID ?? null,
    provider: input.provider ?? telemetry?.provider ?? plan?.provider ?? "unknown",
    model: input.model ?? telemetry?.model ?? plan?.model ?? "unknown",
    route: input.route ?? null,
    mode: plan?.mode ?? null,
    eligible: telemetry?.eligible ?? plan?.eligible ?? false,
    classification: telemetry?.classification ?? null,
    verified: telemetry?.verified ?? false,
    metricsAvailable: telemetry?.metricsAvailable ?? false,
    stablePrefixFingerprint: plan?.stablePrefixFingerprint ?? input.diagnostic?.stablePrefixFingerprint ?? null,
    componentFingerprints: { ...(plan?.componentFingerprints ?? {}) },
    cacheKey: plan?.cacheKey ?? null,
    trafficPartition: plan?.trafficPartition ?? null,
    prefixTokenCount: plan?.prefixTokenCount ?? null,
    minimumPrefixTokens: plan?.minimumPrefixTokens ?? null,
    inputTokens: telemetry?.inputTokens ?? null,
    cacheReadTokens: telemetry?.cacheReadTokens ?? null,
    cacheWriteTokens: telemetry?.cacheWriteTokens ?? null,
    cacheMissTokens: telemetry?.cacheMissTokens ?? null,
    uncachedInputTokens: telemetry?.uncachedInputTokens ?? null,
    providerRawUsageFieldNames: telemetry?.providerRawUsageFieldNames ?? [],
    warmupRequestNumber: telemetry?.warmupRequestNumber ?? null,
    estimatedCacheCost: telemetry?.estimatedCacheCost ?? null,
    estimatedUncachedCost: telemetry?.estimatedUncachedCost ?? null,
    estimatedSavings: telemetry?.estimatedSavings ?? null,
    notification:
      "notification" in input
        ? input.notification ?? null
        : notification({
            telemetry,
            plan,
            providerFailure: input.providerFailure,
            configurationError: input.configurationError,
            compaction: input.compaction,
            expectedExpiration: input.expectedExpiration,
            bestEffortSingleMiss: input.bestEffortSingleMiss,
          }),
    diagnostic: input.diagnostic ?? null,
  }
}

export * as CacheLogging from "./logging"
