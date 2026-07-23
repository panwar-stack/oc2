import {
  getCacheCapabilities,
  type CacheDiagnostic,
  type CacheDiagnosticComponent,
  type CachePlan,
  type CacheTelemetry,
} from "./capability"
import type { CacheExpectationEntry } from "./state"

export interface CacheDiagnosticInput {
  readonly provider?: string
  readonly model?: string
  readonly plan?: CachePlan | null
  readonly telemetry?: CacheTelemetry | null
  readonly previous?: CachePlan | CacheExpectationEntry | null
  readonly reason?: string | null
  readonly correctiveAction?: string | null
}

export const diagnoseUnexpectedMiss = (input: CacheDiagnosticInput): CacheDiagnostic | null => {
  if (input.telemetry?.classification !== "unexpected_cache_miss") return null
  const provider = input.provider ?? input.plan?.provider ?? input.previous?.provider ?? "unknown"
  const model = input.model ?? input.plan?.model ?? input.previous?.model ?? "unknown"
  const previousStablePrefixFingerprint = input.previous?.stablePrefixFingerprint ?? null
  const components = diagnosticComponents(input.plan?.componentFingerprints, previousComponentFingerprints(input.previous))
  return {
    provider,
    model,
    classification: input.telemetry.classification,
    stablePrefixFingerprint: input.plan?.stablePrefixFingerprint ?? null,
    previousStablePrefixFingerprint,
    components,
    reason: input.reason ?? diagnosticReason(input.plan ?? null, input.telemetry, previousStablePrefixFingerprint),
    correctiveAction: input.correctiveAction ?? correctiveAction(provider, model, components, previousStablePrefixFingerprint),
  }
}

const diagnosticComponents = (
  current: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
): ReadonlyArray<CacheDiagnosticComponent> => {
  const names = [...new Set([...Object.keys(current ?? {}), ...Object.keys(previous ?? {})])].sort()
  return names.map((component) => {
    const fingerprint = current?.[component] ?? null
    const previousFingerprint = previous?.[component] ?? null
    return {
      component,
      fingerprint,
      previousFingerprint,
      changed: fingerprint !== previousFingerprint,
    }
  })
}

const previousComponentFingerprints = (previous: CacheDiagnosticInput["previous"]) => {
  if (!previous) return undefined
  if ("componentFingerprints" in previous) return previous.componentFingerprints
  return Object.fromEntries(
    Object.entries(previous.configurationFingerprints).flatMap(([key, value]) => {
      if (!key.startsWith("component:")) return []
      return [[key.slice("component:".length), value]]
    }),
  )
}

const diagnosticReason = (plan: CachePlan | null, telemetry: CacheTelemetry, previousStablePrefixFingerprint: string | null) => {
  if (plan && previousStablePrefixFingerprint && plan.stablePrefixFingerprint !== previousStablePrefixFingerprint) {
    return "Stable prefix fingerprint changed before an expected cache hit."
  }
  if (plan?.prefixTokenCount !== null && plan?.prefixTokenCount !== undefined && plan.minimumPrefixTokens !== null) {
    if (plan.prefixTokenCount < plan.minimumPrefixTokens) return "Stable prefix is below the provider cache threshold."
  }
  if ((telemetry.cacheMissTokens ?? 0) > 0 || telemetry.uncachedInputTokens !== null) {
    return "Provider reported uncached prompt tokens after the cache was expected to be warm."
  }
  return "Provider reported an unexpected cache miss after the cache was expected to be warm."
}

const correctiveAction = (
  provider: string,
  model: string,
  components: ReadonlyArray<CacheDiagnosticComponent>,
  previousStablePrefixFingerprint: string | null,
) => {
  if (components.some((component) => component.changed)) {
    return "Compare changed component fingerprints for variable context, tool schema, or model option changes before the cache boundary."
  }
  if (previousStablePrefixFingerprint !== null) {
    return "Verify the provider retention window, cache key partition, and stable prefix are reused across adjacent invocations."
  }
  const capabilities = getCacheCapabilities(provider, model)
  if (capabilities.retention.policy === "fixed") return "Verify the request was sent within the provider cache retention window."
  return "Compare safe cache fingerprints across adjacent invocations; prompt content is intentionally omitted."
}

export * as CacheDiagnostics from "./diagnostics"
