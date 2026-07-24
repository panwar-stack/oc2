import { getCacheCapabilities, type CacheCapabilities, type CachePlan } from "./capability"

export type CacheGuardrailCode =
  | "unsupported_field"
  | "invalid_duration"
  | "breakpoint_overflow"
  | "provider_field_leakage"
  | "incompatible_cache_key_reuse"
  | "unstable_prefix_change"
  | "retry_prefix_change"

export type CacheGuardrailSeverity = "warning" | "error"

export interface CacheGuardrailIssue {
  readonly code: CacheGuardrailCode
  readonly severity: CacheGuardrailSeverity
  readonly message: string
  readonly provider: string
  readonly model: string
  readonly field?: string
}

export interface CacheGuardrailResult {
  readonly valid: boolean
  readonly issues: ReadonlyArray<CacheGuardrailIssue>
  readonly warnings: ReadonlyArray<CacheGuardrailIssue>
  readonly errors: ReadonlyArray<CacheGuardrailIssue>
}

export interface CacheKeyUse {
  readonly provider: string
  readonly model: string
  readonly cacheKey: string | null
  readonly stablePrefixFingerprint: string
  readonly trafficPartition: string | null
}

export interface PrefixUse {
  readonly provider: string
  readonly model: string
  readonly stablePrefixFingerprint: string
  readonly trafficPartition: string | null
  readonly componentFingerprints?: Record<string, string>
}

const providerFields = new Map([
  ["openai", new Set(["prompt_cache_key"])],
  ["anthropic", new Set(["cache_control"])],
  ["bedrock", new Set(["cachePoint"])],
])

export const checkUnsupportedFields = (input: {
  readonly provider: string
  readonly model: string
  readonly fields: ReadonlyArray<string>
  readonly capabilities?: CacheCapabilities
}) => {
  const capabilities = input.capabilities ?? getCacheCapabilities(input.provider, input.model)
  const allowed = new Set(capabilities.requestFields)
  const severity = capabilities.status === "unknown" ? "warning" : "error"
  return result(
    input.fields
      .filter((field) => !allowed.has(field))
      .map((field) =>
        issue({
          code: "unsupported_field",
          severity,
          provider: input.provider,
          model: input.model,
          field,
          message:
            severity === "error"
              ? `Provider ${input.provider} does not support cache request field ${field}.`
              : `Provider ${input.provider} has unknown cache field support for ${field}.`,
        }),
      ),
  )
}

export const checkInvalidDuration = (input: {
  readonly provider: string
  readonly model: string
  readonly duration: string | null | undefined
  readonly capabilities?: CacheCapabilities
}) => {
  if (input.duration === null || input.duration === undefined) return result([])
  const capabilities = input.capabilities ?? getCacheCapabilities(input.provider, input.model)
  const allowed = new Set<string>(capabilities.supportedDurations)
  if (allowed.has(input.duration)) return result([])
  const knownDuration = input.duration === "5m" || input.duration === "1h"
  const severity = knownDuration && capabilities.status === "unknown" ? "warning" : "error"
  return result([
    issue({
      code: "invalid_duration",
      severity,
      provider: input.provider,
      model: input.model,
      field: "duration",
      message: !knownDuration
        ? `Cache duration ${input.duration} is invalid; supported durations are 5m and 1h.`
        : severity === "error"
        ? `Provider ${input.provider} does not support cache duration ${input.duration}.`
        : `Provider ${input.provider} has unknown cache duration support for ${input.duration}.`,
    }),
  ])
}

export const checkBreakpointOverflow = (input: {
  readonly provider: string
  readonly model: string
  readonly breakpoints: CachePlan["breakpoints"]
  readonly capabilities?: CacheCapabilities
}) => {
  const capabilities = input.capabilities ?? getCacheCapabilities(input.provider, input.model)
  const maximum = capabilities.maximumBreakpoints
  if (maximum === null || input.breakpoints.length <= maximum) return result([])
  return result([
    issue({
      code: "breakpoint_overflow",
      severity: "warning",
      provider: input.provider,
      model: input.model,
      message: `Cache plan has ${input.breakpoints.length} breakpoints; provider ${input.provider} supports ${maximum}. Extra leading breakpoints should be dropped.`,
    }),
  ])
}

export const checkProviderFieldLeakage = (input: {
  readonly provider: string
  readonly model: string
  readonly fields: ReadonlyArray<string>
}) => {
  const normalizedProvider = normalizeProvider(input.provider, input.model)
  return result(
    input.fields.flatMap((field) => {
      const owner = [...providerFields.entries()].find(([provider, fields]) => provider !== normalizedProvider && fields.has(field))
      if (!owner) return []
      return [
        issue({
          code: "provider_field_leakage",
          severity: "error",
          provider: input.provider,
          model: input.model,
          field,
          message: `Cache field ${field} belongs to ${owner[0]} and must not be sent to ${input.provider}.`,
        }),
      ]
    }),
  )
}

export const checkIncompatibleCacheKeyReuse = (input: { readonly previous: CacheKeyUse; readonly current: CacheKeyUse }) => {
  if (!input.previous.cacheKey || input.previous.cacheKey !== input.current.cacheKey) return result([])
  const compatible =
    input.previous.provider === input.current.provider &&
    input.previous.model === input.current.model &&
    input.previous.trafficPartition === input.current.trafficPartition &&
    input.previous.stablePrefixFingerprint === input.current.stablePrefixFingerprint
  if (compatible) return result([])
  return result([
    issue({
      code: "incompatible_cache_key_reuse",
      severity: "error",
      provider: input.current.provider,
      model: input.current.model,
      field: "cacheKey",
      message: "A prompt cache key was reused for a different provider, model, partition, or stable prefix.",
    }),
  ])
}

export const checkUnstablePrefixChange = (input: { readonly previous: PrefixUse; readonly current: PrefixUse }) => {
  if (!sameExpectationPartition(input.previous, input.current)) return result([])
  if (input.previous.stablePrefixFingerprint === input.current.stablePrefixFingerprint) return result([])
  return result([
    issue({
      code: "unstable_prefix_change",
      severity: "warning",
      provider: input.current.provider,
      model: input.current.model,
      message: `Stable cache prefix changed for the same provider/model partition${changedComponents(input.previous, input.current)}.`,
    }),
  ])
}

export const checkRetryPrefixChange = (input: {
  readonly original: PrefixUse
  readonly retry: PrefixUse
  readonly retryID?: string
}) => {
  if (input.original.stablePrefixFingerprint === input.retry.stablePrefixFingerprint) return result([])
  return result([
    issue({
      code: "retry_prefix_change",
      severity: "warning",
      provider: input.retry.provider,
      model: input.retry.model,
      message: `Retry${input.retryID ? ` ${input.retryID}` : ""} changed the stable cache prefix and should not be treated as an exact cache retry.`,
    }),
  ])
}

export const combine = (...items: ReadonlyArray<CacheGuardrailResult>) => result(items.flatMap((item) => item.issues))

const result = (issues: ReadonlyArray<CacheGuardrailIssue>): CacheGuardrailResult => {
  const errors = issues.filter((item) => item.severity === "error")
  const warnings = issues.filter((item) => item.severity === "warning")
  return { valid: errors.length === 0, issues, warnings, errors }
}

const issue = (input: CacheGuardrailIssue): CacheGuardrailIssue => input

const normalizeProvider = (provider: string, model?: string) => {
  const lower = provider.toLowerCase()
  if (lower === "amazon-bedrock" || lower === "bedrock-converse") return "bedrock"
  if (lower === "moonshot-ai" || lower === "moonshotai" || lower === "kimi") return "moonshot"
  if (model && getCacheCapabilities(provider, model).requestFields.includes("prompt_cache_key")) return "openai"
  return lower
}

const sameExpectationPartition = (previous: PrefixUse, current: PrefixUse) =>
  previous.provider === current.provider &&
  previous.model === current.model &&
  previous.trafficPartition === current.trafficPartition

const changedComponents = (previous: PrefixUse, current: PrefixUse) => {
  const previousComponents = previous.componentFingerprints ?? {}
  const currentComponents = current.componentFingerprints ?? {}
  const changed = Object.keys({ ...previousComponents, ...currentComponents }).filter(
    (key) => previousComponents[key] !== currentComponents[key],
  )
  return changed.length === 0 ? "" : ` (${changed.join(", ")})`
}

export * as CacheGuardrails from "./guardrails"
