import { getCacheCapabilities, type CacheDiagnostic, type CachePlan, type CacheTelemetry } from "./capability"
import { CacheDiagnostics } from "./diagnostics"

export type CacheExpectationWarningCode =
  | "warmup"
  | "expiration"
  | "telemetry_gap"
  | "unexpected_miss"
  | "configuration_change"

export interface CacheExpectationKey {
  readonly provider: string
  readonly model: string
  readonly stablePrefixFingerprint: string
  readonly trafficPartition: string | null
}

export interface CacheExpectationWarning {
  readonly code: CacheExpectationWarningCode
  readonly message: string
  readonly observedAt: number
}

export interface CacheExpectationWarmup {
  readonly policy: ReturnType<typeof getCacheCapabilities>["warmup"]["policy"]
  readonly requests: number
  readonly remaining: number
  readonly active: boolean
}

export interface CacheExpectationExpiration {
  readonly policy: ReturnType<typeof getCacheCapabilities>["retention"]["policy"]
  readonly seconds: number | null
  readonly expiresAt: number | null
  readonly expiredBeforeObservation: boolean
}

export interface CacheExpectationEntry extends CacheExpectationKey {
  readonly firstObservedAt: number
  readonly lastObservedAt: number
  readonly eligibleRequestCount: number
  readonly readCount: number
  readonly writeCount: number
  readonly missCount: number
  readonly telemetryGapCount: number
  readonly warmup: CacheExpectationWarmup
  readonly expiration: CacheExpectationExpiration
  readonly warnings: ReadonlyArray<CacheExpectationWarning>
  readonly configurationFingerprints: Record<string, string>
}

export interface CacheExpectationObservation extends Partial<CacheExpectationKey> {
  readonly plan?: CachePlan | null
  readonly telemetry?: CacheTelemetry | null
  readonly observedAt?: number | Date
  readonly eligible?: boolean
  readonly warnings?: ReadonlyArray<Omit<CacheExpectationWarning, "observedAt"> & { readonly observedAt?: number | Date }>
  readonly configurationFingerprints?: Record<string, string>
}

export interface CacheExpectationStoreOptions {
  readonly maxEntries?: number
  readonly maxWarningsPerEntry?: number
  readonly now?: () => number | Date
}

export interface CacheExpectationStore {
  readonly observe: (input: CacheExpectationObservation) => CacheExpectationEntry
  readonly get: (key: CacheExpectationKey) => CacheExpectationEntry | undefined
  readonly delete: (key: CacheExpectationKey) => boolean
  readonly clear: () => void
  readonly entries: () => ReadonlyArray<CacheExpectationEntry>
  readonly size: () => number
}

export type CacheRegressionStatus =
  | "pass"
  | "warmup"
  | "expected_miss"
  | "unexpected_miss"
  | "unsupported"
  | "inconclusive"

export interface CacheRegressionResult {
  readonly status: CacheRegressionStatus
  readonly sessionID: string
  readonly requestID?: string | null
  readonly providerID: string
  readonly modelID: string
  readonly promptCacheKey?: string
  readonly stablePrefixHash?: string
  readonly cacheStatus: string
  readonly cachedInputTokens?: number
  readonly cacheWriteTokens?: number
  readonly expectedCachedTokens?: number
  readonly diagnostic?: CacheDiagnostic
}

export interface CacheRegressionChecker {
  readonly register: (input: {
    readonly sessionID: string
    readonly requestID?: string | null
    readonly plan: CachePlan
    readonly observedAt?: number | Date
  }) => CacheExpectationEntry
  readonly complete: (input: {
    readonly sessionID: string
    readonly requestID?: string | null
    readonly plan: CachePlan
    readonly telemetry?: CacheTelemetry | null
    readonly expectedMiss?: boolean
    readonly observedAt?: number | Date
  }) => CacheRegressionResult
  readonly store: CacheExpectationStore
}

export const createStore = (options: CacheExpectationStoreOptions = {}): CacheExpectationStore => {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1024))
  const maxWarningsPerEntry = Math.max(0, Math.floor(options.maxWarningsPerEntry ?? 32))
  const records = new Map<string, CacheExpectationEntry>()
  const now = () => toMillis(options.now?.() ?? Date.now())

  const observe = (input: CacheExpectationObservation) => {
    const observedAt = toMillis(input.observedAt ?? now())
    const key = expectationKey(input)
    const id = keyID(key)
    const existing = records.get(id)
    const eligible = input.eligible ?? input.telemetry?.eligible ?? input.plan?.eligible ?? false
    const eligibleRequestCount = (existing?.eligibleRequestCount ?? 0) + (eligible ? 1 : 0)
    const capabilities = getCacheCapabilities(key.provider, key.model)
    const telemetryGap = input.telemetry !== undefined && input.telemetry !== null && !input.telemetry.metricsAvailable
    const expiredBeforeObservation = existing?.expiration.expiresAt !== null && existing?.expiration.expiresAt !== undefined
      ? observedAt >= existing.expiration.expiresAt
      : false
    const configurationFingerprints = mergeConfigurationFingerprints(input)
    const configurationChanged = existing !== undefined && changedFingerprints(existing.configurationFingerprints, configurationFingerprints)
    const warnings = boundedWarnings(
      [
        ...(existing?.warnings ?? []),
        ...normalizeWarnings(input.warnings ?? [], observedAt),
        ...(eligible && eligibleRequestCount <= capabilities.warmup.requests
          ? [{ code: "warmup", message: "Cache expectation is still in provider warmup.", observedAt } as const]
          : []),
        ...(expiredBeforeObservation
          ? [{ code: "expiration", message: "Previous cache expectation retention window had expired.", observedAt } as const]
          : []),
        ...(telemetryGap
          ? [{ code: "telemetry_gap", message: "Provider did not report cache telemetry for an observed response.", observedAt } as const]
          : []),
        ...(input.telemetry?.classification === "unexpected_cache_miss"
          ? [{ code: "unexpected_miss", message: "Provider reported a cache miss after the request was expected to be warm.", observedAt } as const]
          : []),
        ...(configurationChanged
          ? [{ code: "configuration_change", message: "Configuration fingerprints changed for this cache expectation key.", observedAt } as const]
          : []),
      ],
      maxWarningsPerEntry,
    )
    const entry: CacheExpectationEntry = {
      ...key,
      firstObservedAt: existing?.firstObservedAt ?? observedAt,
      lastObservedAt: observedAt,
      eligibleRequestCount,
      readCount: (existing?.readCount ?? 0) + (positive(input.telemetry?.cacheReadTokens) ? 1 : 0),
      writeCount: (existing?.writeCount ?? 0) + (positive(input.telemetry?.cacheWriteTokens) ? 1 : 0),
      missCount: (existing?.missCount ?? 0) + (isMiss(input.telemetry) ? 1 : 0),
      telemetryGapCount: (existing?.telemetryGapCount ?? 0) + (telemetryGap ? 1 : 0),
      warmup: {
        policy: capabilities.warmup.policy,
        requests: capabilities.warmup.requests,
        remaining: Math.max(0, capabilities.warmup.requests - eligibleRequestCount),
        active: eligible && eligibleRequestCount <= capabilities.warmup.requests,
      },
      expiration: {
        policy: capabilities.retention.policy,
        seconds: capabilities.retention.seconds,
        expiresAt: capabilities.retention.seconds === null ? null : observedAt + capabilities.retention.seconds * 1000,
        expiredBeforeObservation,
      },
      warnings,
      configurationFingerprints,
    }

    records.delete(id)
    records.set(id, entry)
    while (records.size > maxEntries) {
      const oldest = records.keys().next()
      if (oldest.done) break
      records.delete(oldest.value)
    }
    return cloneEntry(entry)
  }

  const get = (key: CacheExpectationKey) => {
    const id = keyID(key)
    const entry = records.get(id)
    if (!entry) return undefined
    records.delete(id)
    records.set(id, entry)
    return cloneEntry(entry)
  }

  return {
    observe,
    get,
    delete: (key) => records.delete(keyID(key)),
    clear: () => records.clear(),
    entries: () => [...records.values()].map(cloneEntry),
    size: () => records.size,
  }
}

export const createRegressionChecker = (options: CacheExpectationStoreOptions = {}): CacheRegressionChecker => {
  const store = createStore(options)

  return {
    register: (input) => store.observe({ plan: input.plan, observedAt: input.observedAt, eligible: false }),
    complete: (input) => {
      const previous = store.get(expectationKey({ plan: input.plan }))
      const entry = store.observe({
        plan: input.plan,
        telemetry: input.telemetry ?? null,
        observedAt: input.observedAt,
        eligible: input.plan.eligible,
      })
      const status = regressionStatus({
        plan: input.plan,
        telemetry: input.telemetry ?? null,
        previous,
        entry,
        expectedMiss: input.expectedMiss === true,
      })
      const diagnostic = status === "unexpected_miss"
        ? CacheDiagnostics.diagnoseUnexpectedMiss({ plan: input.plan, telemetry: input.telemetry ?? null, previous })
        : null
      return {
        status,
        sessionID: input.sessionID,
        ...(input.requestID === undefined ? {} : { requestID: input.requestID }),
        providerID: input.plan.provider,
        modelID: input.plan.model,
        ...(input.plan.cacheKey ? { promptCacheKey: input.plan.cacheKey } : {}),
        stablePrefixHash: input.plan.stablePrefixFingerprint,
        cacheStatus: input.telemetry?.classification ?? "cache_telemetry_unavailable",
        ...(positive(input.telemetry?.cacheReadTokens) ? { cachedInputTokens: input.telemetry.cacheReadTokens } : {}),
        ...(positive(input.telemetry?.cacheWriteTokens) ? { cacheWriteTokens: input.telemetry.cacheWriteTokens } : {}),
        ...(input.plan.prefixTokenCount === null ? {} : { expectedCachedTokens: input.plan.prefixTokenCount }),
        ...(diagnostic ? { diagnostic } : {}),
      }
    },
    store,
  }
}

const regressionStatus = (input: {
  readonly plan: CachePlan
  readonly telemetry: CacheTelemetry | null
  readonly previous: CacheExpectationEntry | undefined
  readonly entry: CacheExpectationEntry
  readonly expectedMiss: boolean
}): CacheRegressionStatus => {
  if (!input.plan.eligible || input.telemetry?.classification === "cache_unsupported") return "unsupported"
  if (input.expectedMiss) return "expected_miss"
  if (!input.telemetry || !input.telemetry.metricsAvailable || input.telemetry.classification === "cache_telemetry_unavailable") {
    return "inconclusive"
  }
  if (input.telemetry.expected || input.telemetry.classification === "expected_cache_miss") {
    return "expected_miss"
  }
  if (
    input.telemetry.classification === "cache_write" &&
    input.entry.warmup.active &&
    (input.previous?.writeCount ?? 0) === 0
  ) {
    return "warmup"
  }
  if (input.telemetry.classification === "unexpected_cache_miss") return "unexpected_miss"
  if (input.telemetry.classification === "provider_error" || input.telemetry.classification === "cache_configuration_error") {
    return "inconclusive"
  }
  return "pass"
}

const expectationKey = (input: CacheExpectationObservation): CacheExpectationKey => {
  const provider = input.provider ?? input.plan?.provider
  const model = input.model ?? input.plan?.model
  const stablePrefixFingerprint = input.stablePrefixFingerprint ?? input.plan?.stablePrefixFingerprint
  if (!provider || !model || !stablePrefixFingerprint) {
    throw new Error("Cache expectation observations require provider, model, and stablePrefixFingerprint")
  }
  return {
    provider,
    model,
    stablePrefixFingerprint,
    trafficPartition: input.trafficPartition ?? input.plan?.trafficPartition ?? null,
  }
}

const mergeConfigurationFingerprints = (input: CacheExpectationObservation) => ({
  ...(input.plan?.cacheKey ? { cacheKey: input.plan.cacheKey } : {}),
  ...(input.plan ? { stablePrefix: input.plan.stablePrefixFingerprint } : {}),
  ...Object.fromEntries(
    Object.entries(input.plan?.componentFingerprints ?? {}).map(([key, value]) => [`component:${key}`, value]),
  ),
  ...(input.configurationFingerprints ?? {}),
})

const changedFingerprints = (previous: Record<string, string>, next: Record<string, string>) =>
  Object.keys({ ...previous, ...next }).some((key) => previous[key] !== next[key])

const normalizeWarnings = (
  warnings: ReadonlyArray<Omit<CacheExpectationWarning, "observedAt"> & { readonly observedAt?: number | Date }>,
  observedAt: number,
) => warnings.map((warning): CacheExpectationWarning => ({ ...warning, observedAt: toMillis(warning.observedAt ?? observedAt) }))

const boundedWarnings = (warnings: ReadonlyArray<CacheExpectationWarning>, maximum: number) =>
  maximum === 0 ? [] : warnings.slice(Math.max(0, warnings.length - maximum))

const cloneEntry = (entry: CacheExpectationEntry): CacheExpectationEntry => ({
  ...entry,
  warnings: entry.warnings.map((warning) => ({ ...warning })),
  configurationFingerprints: { ...entry.configurationFingerprints },
})

const toMillis = (value: number | Date) => (value instanceof Date ? value.getTime() : value)

const keyID = (key: CacheExpectationKey) =>
  JSON.stringify([key.provider, key.model, key.stablePrefixFingerprint, key.trafficPartition])

const positive = (value: number | null | undefined) => typeof value === "number" && value > 0

const isMiss = (telemetry: CacheTelemetry | null | undefined) =>
  telemetry?.classification === "expected_cache_miss" || telemetry?.classification === "unexpected_cache_miss"

export * as CacheState from "./state"
