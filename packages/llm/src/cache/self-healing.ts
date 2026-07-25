import type { CacheDiagnostic, CacheDiagnosticComponent, CachePlan, CacheTelemetry } from "./capability"
import type { CacheRegressionResult } from "./state"

export type CacheSelfHealingMode = "off" | "observe" | "enforce"

export type CacheSelfHealingReason =
  | "provider_error"
  | "stable_prefix_mismatch"
  | "volatile_prefix"
  | "schema_churn"

export type CacheSelfHealingActionKind =
  | "disable_explicit_cache"
  | "rotate_cache_partition"
  | "emit_warning"

export interface CacheSelfHealingOptions {
  readonly mode?: CacheSelfHealingMode
  readonly repeatedMissThreshold?: number
  readonly providerErrorThreshold?: number
  readonly cooldownMs?: number
  readonly actionTtlMs?: number
  readonly maxCounters?: number
  readonly maxCacheKeyLength?: number
  readonly now?: () => number | Date
}

export interface CacheSelfHealingObservation {
  readonly result: CacheRegressionResult
  readonly plan?: CachePlan | null
  readonly telemetry?: CacheTelemetry | null
  readonly diagnostic?: CacheDiagnostic | null
  readonly providerFailure?: boolean
  readonly observedAt?: number | Date
}

export interface CacheSelfHealingScope {
  readonly provider: string
  readonly model: string
  readonly stablePrefixFingerprint?: string
}

export interface CacheSelfHealingAction {
  readonly kind: CacheSelfHealingActionKind
  readonly reason: CacheSelfHealingReason
  readonly label: string
  readonly correctiveLabel: string
  readonly scope: CacheSelfHealingScope
  readonly observedAt: number
  readonly expiresAt: number | null
  readonly enforced: boolean
  readonly message: string
  readonly partition?: string
}

export interface CacheSelfHealingCounterSnapshot {
  readonly reason: CacheSelfHealingReason
  readonly key: string
  readonly count: number
  readonly lastObservedAt: number
  readonly cooldownUntil: number
}

export interface CacheSelfHealingDecision {
  readonly mode: CacheSelfHealingMode
  readonly observedAt: number
  readonly actions: ReadonlyArray<CacheSelfHealingAction>
  readonly counters: ReadonlyArray<CacheSelfHealingCounterSnapshot>
}

export interface CacheSelfHealingPolicy {
  readonly observe: (input: CacheSelfHealingObservation) => CacheSelfHealingDecision
  readonly applyPlan: (plan: CachePlan, observedAt?: number | Date) => CachePlan
  readonly activeActions: (observedAt?: number | Date) => ReadonlyArray<CacheSelfHealingAction>
  readonly snapshot: () => ReadonlyArray<CacheSelfHealingCounterSnapshot>
  readonly clear: () => void
}

type Counter = {
  readonly reason: CacheSelfHealingReason
  readonly key: string
  count: number
  lastObservedAt: number
  cooldownUntil: number
}

type Intervention = CacheSelfHealingAction & { readonly counterKey: string }

const DEFAULT_REPEATED_MISS_THRESHOLD = 2
const DEFAULT_PROVIDER_ERROR_THRESHOLD = 2
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_ACTION_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_COUNTERS = 256
const DEFAULT_MAX_CACHE_KEY_LENGTH = 96

export const createPolicy = (options: CacheSelfHealingOptions = {}): CacheSelfHealingPolicy => {
  const mode = options.mode ?? "off"
  const repeatedMissThreshold = positiveInteger(options.repeatedMissThreshold, DEFAULT_REPEATED_MISS_THRESHOLD)
  const providerErrorThreshold = positiveInteger(options.providerErrorThreshold, DEFAULT_PROVIDER_ERROR_THRESHOLD)
  const cooldownMs = nonNegativeInteger(options.cooldownMs, DEFAULT_COOLDOWN_MS)
  const actionTtlMs = nonNegativeInteger(options.actionTtlMs, DEFAULT_ACTION_TTL_MS)
  const maxCounters = positiveInteger(options.maxCounters, DEFAULT_MAX_COUNTERS)
  const maxCacheKeyLength = positiveInteger(options.maxCacheKeyLength, DEFAULT_MAX_CACHE_KEY_LENGTH)
  const counters = new Map<string, Counter>()
  const interventions = new Map<string, Intervention>()
  const now = () => toMillis(options.now?.() ?? Date.now())

  const observe = (input: CacheSelfHealingObservation): CacheSelfHealingDecision => {
    const observedAt = toMillis(input.observedAt ?? now())
    pruneInterventions(interventions, observedAt)
    const context = observationContext(input)
    const actions: Array<CacheSelfHealingAction> = []

    if (input.result.status === "pass") resetStableCounters(counters, context)

    if (isProviderError(input)) {
      const counter = increment(counters, "provider_error", providerModelKey(context), observedAt, maxCounters)
      maybePushAction(actions, counter, providerErrorThreshold, observedAt, cooldownMs, mode !== "off", () => {
        const action = actionFor({
          kind: "disable_explicit_cache",
          reason: "provider_error",
          label: "prompt_cache.disable_explicit.provider_error",
          correctiveLabel: "prompt_cache.provider_error.temporarily_disable_explicit_cache",
          scope: { provider: context.provider, model: context.model },
          observedAt,
          expiresAt: observedAt + actionTtlMs,
          enforced: mode === "enforce",
          message: "Repeated provider errors observed; temporarily disable explicit prompt cache markers for future requests.",
        })
        interventions.set(interventionKey(action), { ...action, counterKey: counter.key })
        return action
      })
    }

    if (isUnexpectedMiss(input)) {
      const diagnostic = input.diagnostic ?? input.result.diagnostic ?? null
      if (hasStablePrefixMismatch(diagnostic)) {
        const counter = increment(counters, "stable_prefix_mismatch", stableKey(context), observedAt, maxCounters)
        maybePushAction(actions, counter, repeatedMissThreshold, observedAt, cooldownMs, mode !== "off", () => {
          const partition = partitionFor(counter.key, counter.count)
          const action = actionFor({
            kind: "rotate_cache_partition",
            reason: "stable_prefix_mismatch",
            label: "prompt_cache.rotate_partition.stable_prefix_mismatch",
            correctiveLabel: "prompt_cache.stable_prefix_mismatch.rotate_future_cache_key_partition",
            scope: {
              provider: context.provider,
              model: context.model,
              stablePrefixFingerprint: context.stablePrefixFingerprint,
            },
            observedAt,
            expiresAt: observedAt + actionTtlMs,
            enforced: mode === "enforce",
            message: "Repeated stable-prefix mismatches observed; rotate the cache-key partition for future requests.",
            partition,
          })
          interventions.set(interventionKey(action), { ...action, counterKey: counter.key })
          return action
        })
      }

      for (const reason of warningReasons(diagnostic)) {
        const counter = increment(counters, reason, stableKey(context), observedAt, maxCounters)
        maybePushAction(actions, counter, repeatedMissThreshold, observedAt, cooldownMs, mode !== "off", () =>
          warningAction(reason, context, observedAt, mode === "enforce"),
        )
      }
    }

    return {
      mode,
      observedAt,
      actions: mode === "off" ? [] : actions,
      counters: snapshotCounters(counters),
    }
  }

  const applyPlan = (plan: CachePlan, observedAt?: number | Date): CachePlan => {
    const at = toMillis(observedAt ?? now())
    pruneInterventions(interventions, at)
    if (mode !== "enforce") return plan
    let next = plan
    const disable = interventions.get(providerInterventionKey("disable_explicit_cache", plan.provider, plan.model))
    if (disable && next.mode === "explicit" && next.eligible) {
      next = { ...next, mode: "disabled", eligible: false, cacheKey: null, breakpoints: [], duration: null }
    }
    const rotation = interventions.get(stableInterventionKey("rotate_cache_partition", plan.provider, plan.model, plan.stablePrefixFingerprint))
    if (rotation?.partition && next.eligible && next.cacheKey) {
      next = {
        ...next,
        cacheKey: partitionCacheKey(next.cacheKey, rotation.partition, maxCacheKeyLength),
        trafficPartition: rotation.partition,
      }
    }
    return next
  }

  const activeActions = (observedAt?: number | Date) => {
    pruneInterventions(interventions, toMillis(observedAt ?? now()))
    return [...interventions.values()].map(({ counterKey: _counterKey, ...action }) => action)
  }

  return {
    observe,
    applyPlan,
    activeActions,
    snapshot: () => snapshotCounters(counters),
    clear: () => {
      counters.clear()
      interventions.clear()
    },
  }
}

const actionFor = (action: CacheSelfHealingAction): CacheSelfHealingAction => action

const maybePushAction = (
  actions: Array<CacheSelfHealingAction>,
  counter: Counter,
  threshold: number,
  observedAt: number,
  cooldownMs: number,
  enabled: boolean,
  make: () => CacheSelfHealingAction,
) => {
  if (!enabled) return
  if (counter.count < threshold || observedAt < counter.cooldownUntil) return
  const action = make()
  counter.cooldownUntil = observedAt + cooldownMs
  actions.push(action)
}

const increment = (
  counters: Map<string, Counter>,
  reason: CacheSelfHealingReason,
  key: string,
  observedAt: number,
  maxCounters: number,
) => {
  const id = `${reason}:${key}`
  const counter = counters.get(id) ?? { reason, key, count: 0, lastObservedAt: observedAt, cooldownUntil: 0 }
  counter.count++
  counter.lastObservedAt = observedAt
  counters.delete(id)
  counters.set(id, counter)
  while (counters.size > maxCounters) {
    const oldest = counters.keys().next()
    if (oldest.done) break
    counters.delete(oldest.value)
  }
  return counter
}

const observationContext = (input: CacheSelfHealingObservation) => ({
  provider: input.plan?.provider ?? input.telemetry?.provider ?? input.result.providerID,
  model: input.plan?.model ?? input.telemetry?.model ?? input.result.modelID,
  stablePrefixFingerprint:
    input.plan?.stablePrefixFingerprint ?? input.result.stablePrefixHash ?? input.result.diagnostic?.stablePrefixFingerprint ?? "unknown",
})

const isUnexpectedMiss = (input: CacheSelfHealingObservation) =>
  input.result.status === "unexpected_miss" || input.telemetry?.classification === "unexpected_cache_miss"

const isProviderError = (input: CacheSelfHealingObservation) =>
  input.providerFailure === true || input.result.cacheStatus === "provider_error" || input.telemetry?.classification === "provider_error"

const hasStablePrefixMismatch = (diagnostic: CacheDiagnostic | null) =>
  diagnostic?.stablePrefixFingerprint !== undefined &&
  diagnostic.stablePrefixFingerprint !== null &&
  diagnostic.previousStablePrefixFingerprint !== null &&
  diagnostic.stablePrefixFingerprint !== diagnostic.previousStablePrefixFingerprint

const warningReasons = (diagnostic: CacheDiagnostic | null): ReadonlyArray<Extract<CacheSelfHealingReason, "volatile_prefix" | "schema_churn">> => {
  const changed = diagnostic?.components.filter((component) => component.changed) ?? []
  const reasons = new Set<Extract<CacheSelfHealingReason, "volatile_prefix" | "schema_churn">>()
  if (changed.some(isSchemaComponent)) reasons.add("schema_churn")
  if (changed.some(isVolatilePrefixComponent)) reasons.add("volatile_prefix")
  return [...reasons]
}

const isSchemaComponent = (component: CacheDiagnosticComponent) => component.component === "schemas" || component.component === "tools"

const isVolatilePrefixComponent = (component: CacheDiagnosticComponent) =>
  component.component === "system" ||
  component.component === "messages" ||
  component.component === "providerConfig" ||
  component.component === "modelConfig" ||
  component.component === "breakpoints"

const warningAction = (
  reason: Extract<CacheSelfHealingReason, "volatile_prefix" | "schema_churn">,
  context: ReturnType<typeof observationContext>,
  observedAt: number,
  enforced: boolean,
): CacheSelfHealingAction => {
  if (reason === "schema_churn") {
    return {
      kind: "emit_warning",
      reason,
      label: "prompt_cache.warning.schema_churn",
      correctiveLabel: "prompt_cache.schema_churn.stabilize_tool_schema_order",
      scope: { ...context },
      observedAt,
      expiresAt: null,
      enforced,
      message: "Repeated unexpected misses coincide with tool or schema fingerprint changes; stabilize tool schema order and definitions before the cache boundary.",
    }
  }
  return {
    kind: "emit_warning",
    reason,
    label: "prompt_cache.warning.volatile_prefix",
    correctiveLabel: "prompt_cache.volatile_prefix.move_dynamic_content_after_boundary",
    scope: { ...context },
    observedAt,
    expiresAt: null,
    enforced,
    message: "Repeated unexpected misses coincide with stable-prefix component changes; move volatile content behind the cache boundary or mark it dynamic.",
  }
}

const resetStableCounters = (counters: Map<string, Counter>, context: ReturnType<typeof observationContext>) => {
  const suffix = stableKey(context)
  for (const [id, counter] of counters) {
    if (counter.key === suffix && counter.reason !== "provider_error") counters.delete(id)
  }
}

const providerModelKey = (context: ReturnType<typeof observationContext>) => `${context.provider}|${context.model}`

const stableKey = (context: ReturnType<typeof observationContext>) =>
  `${context.provider}|${context.model}|${context.stablePrefixFingerprint}`

const interventionKey = (action: CacheSelfHealingAction) => {
  if (action.kind === "disable_explicit_cache") {
    return providerInterventionKey(action.kind, action.scope.provider, action.scope.model)
  }
  return stableInterventionKey(
    action.kind,
    action.scope.provider,
    action.scope.model,
    action.scope.stablePrefixFingerprint ?? "unknown",
  )
}

const providerInterventionKey = (kind: CacheSelfHealingActionKind, provider: string, model: string) => `${kind}:${provider}|${model}`

const stableInterventionKey = (kind: CacheSelfHealingActionKind, provider: string, model: string, stablePrefixFingerprint: string) =>
  `${kind}:${provider}|${model}|${stablePrefixFingerprint}`

const pruneInterventions = (interventions: Map<string, Intervention>, observedAt: number) => {
  for (const [key, intervention] of interventions) {
    if (intervention.expiresAt !== null && observedAt >= intervention.expiresAt) interventions.delete(key)
  }
}

const snapshotCounters = (counters: Map<string, Counter>) =>
  [...counters.values()].map((counter): CacheSelfHealingCounterSnapshot => ({
    reason: counter.reason,
    key: counter.key,
    count: counter.count,
    lastObservedAt: counter.lastObservedAt,
    cooldownUntil: counter.cooldownUntil,
  }))

const partitionFor = (key: string, count: number) => `pcp-${hash(`${key}|${count}`).slice(0, 10)}`

const partitionCacheKey = (cacheKey: string, partition: string, maxLength: number) => {
  const suffix = `:${partition}`
  if (cacheKey.endsWith(suffix)) return cacheKey
  if (cacheKey.length + suffix.length <= maxLength) return `${cacheKey}${suffix}`
  return `${cacheKey.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`
}

const hash = (value: string) => {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return result.toString(16).padStart(8, "0")
}

const positiveInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback

const nonNegativeInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback

const toMillis = (value: number | Date) => (value instanceof Date ? value.getTime() : value)

export * as CacheSelfHealing from "./self-healing"
