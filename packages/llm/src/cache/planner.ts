import type { CachePolicy, CachePolicyObject } from "../schema/options"
import type { LLMRequest } from "../schema/messages"
import { getCacheCapabilities, type CacheDuration, type CacheMode, type CachePlan } from "./capability"
import type {
  CacheBreakpointInput,
  CacheMessageInput,
  CacheModelConfigInput,
  CacheSystemPartInput,
  CacheToolDefinitionInput,
} from "./canonical"
import { fingerprintStablePrefix } from "./fingerprint"

export type { CachePlan } from "./capability"

export const CACHE_PLANNER_VERSION = 1

export const DEFAULT_CACHE_POLICY: CachePolicyObject = {
  tools: true,
  system: true,
  messages: "latest-user-message",
}

export const resolveCachePolicy = (policy: CachePolicy | undefined): CachePolicyObject => {
  if (policy === undefined || policy === "auto") return DEFAULT_CACHE_POLICY
  if (policy === "none") return {}
  return policy
}

export interface CachePlannerInput {
  readonly provider: string
  readonly model: string
  readonly routeID?: string
  readonly protocolID?: string
  readonly cachePolicy?: CachePolicy
  readonly system?: ReadonlyArray<CacheSystemPartInput>
  readonly messages?: ReadonlyArray<CacheMessageInput>
  readonly tools?: ReadonlyArray<CacheToolDefinitionInput>
  readonly providerConfig?: Record<string, unknown> | null
  readonly modelConfig?: CacheModelConfigInput | Record<string, unknown> | null
  readonly defaultSystemStability?: "stable" | "dynamic"
}

export interface CacheBoundarySelection {
  readonly system: ReadonlyArray<number>
  readonly tools: ReadonlyArray<number>
  readonly messages: ReadonlyArray<number>
}

export interface CacheBoundaryPlan {
  readonly version: number
  readonly plan: CachePlan
  readonly stable: CacheBoundarySelection
  readonly dynamic: CacheBoundarySelection
}

const INLINE_HINT_ROUTES = new Set(["anthropic-messages", "bedrock-converse"])

export const planCacheRequest = (request: LLMRequest): CacheBoundaryPlan =>
  planCache({
    provider: request.model.provider,
    model: request.model.id,
    routeID: request.model.route.id,
    protocolID: request.model.route.protocol,
    cachePolicy: request.cache,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    providerConfig: request.providerOptions,
    modelConfig: {
      provider: request.model.provider,
      model: request.model.id,
      routeID: request.model.route.id,
      protocolID: request.model.route.protocol,
      generation: request.generation,
      responseFormat: request.responseFormat,
      cachePolicy: request.cache,
    },
    defaultSystemStability: "dynamic",
  })

export const planCache = (input: CachePlannerInput): CacheBoundaryPlan => {
  const policy = resolveCachePolicy(input.cachePolicy)
  const capabilities = getCacheCapabilities(input.provider, input.model)
  const protocolID = input.protocolID ?? input.routeID
  const supportsInlineHints = protocolID !== undefined && INLINE_HINT_ROUTES.has(protocolID)
  const supportsAutomaticRequestCaching = protocolID === "anthropic-messages"
  const system = input.system ?? []
  const messages = input.messages ?? []
  const tools = input.tools ?? []
  const stable = {
    system: policy.system ? stableSystemIndexes(system, input.defaultSystemStability ?? "dynamic") : [],
    tools: policy.tools ? tools.map((_, index) => index) : [],
    messages: policy.messages ? stableMessageIndexes(messages, policy.messages) : [],
  }
  const dynamic = {
    system: system.flatMap((_, index) => (stable.system.includes(index) ? [] : [index])),
    tools: tools.flatMap((_, index) => (stable.tools.includes(index) ? [] : [index])),
    messages: messages.flatMap((_, index) => (stable.messages.includes(index) ? [] : [index])),
  }
  const hasStablePrefix = stable.system.length > 0 || stable.tools.length > 0 || stable.messages.length > 0
  const plannedMode = cacheMode(
    capabilities.promptCaching,
    capabilities.supportsBreakpoints,
    supportsInlineHints,
    hasStablePrefix,
    policy,
  )
  const eligible = plannedMode !== "disabled"
  const duration = eligible && (capabilities.supportsDuration || supportsInlineHints) ? cacheDuration(policy.ttlSeconds) : null
  const breakpoints = eligible
    ? limitBreakpoints(
        [
          ...(stable.tools.length > 0 && (capabilities.supportsBreakpoints || supportsInlineHints)
            ? [{ component: "tools", contentType: "tool", index: stable.tools.at(-1)! }]
            : []),
          ...(stable.system.length > 0 && (capabilities.supportsBreakpoints || supportsInlineHints)
            ? [{ component: "system", contentType: "system", index: stable.system.at(-1)! }]
            : []),
          ...(stable.messages.length > 0 && (capabilities.supportsBreakpoints || supportsInlineHints)
            ? [{ component: "messages", contentType: "message", index: stable.messages.at(-1)! }]
            : []),
        ],
        capabilities.maximumBreakpoints ?? (supportsInlineHints ? 4 : null),
      )
    : []
  const automaticSlotAvailable = hasAutomaticSlot({
    mode: plannedMode,
    maximumBreakpoints: capabilities.maximumBreakpoints,
    breakpoints,
    system,
    messages,
    tools,
  })
  const requestCacheControl =
    supportsAutomaticRequestCaching && automaticSlotAvailable && capabilities.requestFields.includes("cache_control")
      ? duration === "1h"
        ? ({ type: "ephemeral", ttl: "1h" } as const)
        : ({ type: "ephemeral" } as const)
      : undefined
  const mode = plannedMode === "automatic_and_explicit" && !requestCacheControl ? "explicit" : plannedMode
  const fingerprint = fingerprintStablePrefix({
    system: stable.system.map((index) => system[index]!),
    tools: stable.tools.map((index) => tools[index]!),
    messages: stable.messages.map((index) => messages[index]!),
    providerConfig: sanitizeProviderConfig(input.providerConfig),
    modelConfig: input.modelConfig ?? { provider: input.provider, model: input.model, cachePolicy: input.cachePolicy },
    breakpoints: breakpoints.map((breakpoint): CacheBreakpointInput => ({ ...breakpoint, duration })),
  })

  return {
    version: CACHE_PLANNER_VERSION,
    plan: {
      provider: input.provider,
      model: input.model,
      mode,
      cacheKey: eligible && capabilities.supportsCacheKey ? cacheKey(fingerprint.stablePrefixFingerprint) : null,
      trafficPartition: null,
      stablePrefixFingerprint: fingerprint.stablePrefixFingerprint,
      componentFingerprints: fingerprint.componentFingerprints,
      prefixTokenCount: null,
      minimumPrefixTokens: capabilities.minimumPrefixTokens,
      eligible,
      breakpoints,
      duration,
      requestCacheControl,
    },
    stable,
    dynamic,
  }
}

export const reconcileCachePlan = (
  fresh: CachePlan,
  value: unknown,
  stable?: CacheBoundarySelection,
): CachePlan => {
  if (!isCachePlan(value)) return fresh
  if (
    value.provider !== fresh.provider ||
    value.model !== fresh.model ||
    value.stablePrefixFingerprint !== fresh.stablePrefixFingerprint ||
    !sameRecord(value.componentFingerprints, fresh.componentFingerprints)
  )
    return fresh
  if (hasDuplicateBreakpointTarget(value.breakpoints)) return fresh
  if (!value.breakpoints.every((breakpoint) => hasBreakpoint(fresh.breakpoints, breakpoint, stable))) return fresh
  const capabilities = getCacheCapabilities(fresh.provider, fresh.model)
  const maximum = capabilities.maximumBreakpoints
  if (maximum !== null && value.breakpoints.length + (value.requestCacheControl ? 1 : 0) > maximum) return fresh
  if (!allowedModes(fresh.mode).has(value.mode)) return fresh
  if (value.mode === "disabled") {
    if (value.eligible || value.breakpoints.length > 0 || value.requestCacheControl || value.duration !== null) return fresh
  } else if (!fresh.eligible || !value.eligible) {
    return fresh
  }
  if (value.mode === "automatic" && value.breakpoints.length > 0) return fresh
  if (value.mode === "implicit" && (value.breakpoints.length > 0 || value.requestCacheControl)) return fresh
  if (value.mode === "explicit" && value.requestCacheControl) return fresh
  if (value.mode === "automatic_and_explicit" && (!value.requestCacheControl || value.breakpoints.length === 0)) return fresh
  if (value.breakpoints.length > 0 && value.mode !== "explicit" && value.mode !== "automatic_and_explicit") return fresh
  if (value.duration !== null && value.duration !== "5m" && value.duration !== "1h") return fresh
  if (value.duration !== null && fresh.duration === null) return fresh
  const automatic = value.mode === "automatic" || value.mode === "automatic_and_explicit"
  const anthropic = fresh.provider === "anthropic"
  if (
    anthropic &&
    automatic &&
    (!value.requestCacheControl ||
      value.duration === null ||
      !capabilities.supportedDurations.includes(value.duration))
  )
    return fresh
  if (
    anthropic &&
    value.mode !== "disabled" &&
    value.breakpoints.length > 0 &&
    (value.duration === null || !capabilities.supportedDurations.includes(value.duration))
  )
    return fresh
  if (
    value.requestCacheControl &&
    (value.requestCacheControl.type !== "ephemeral" ||
      (value.requestCacheControl.ttl !== undefined && value.requestCacheControl.ttl !== "1h"))
  )
    return fresh
  if (value.requestCacheControl && !fresh.requestCacheControl) return fresh
  if (value.requestCacheControl && value.duration === null) return fresh
  if (value.requestCacheControl?.ttl === "1h" && value.duration !== "1h") return fresh
  if (value.requestCacheControl && value.requestCacheControl.ttl === undefined && value.duration !== "5m") return fresh
  return {
    ...fresh,
    mode: value.mode,
    eligible: value.eligible,
    breakpoints: value.breakpoints,
    duration: value.duration,
    requestCacheControl: value.requestCacheControl,
  }
}

const stableSystemIndexes = (system: ReadonlyArray<CacheSystemPartInput>, defaultStability: "stable" | "dynamic") =>
  system.flatMap((part, index) => {
    const stable = cacheStable(part.metadata)
    if (stable === false) return []
    if (stable === true || defaultStability === "stable") return [index]
    return []
  })

const stableMessageIndexes = (
  messages: ReadonlyArray<CacheMessageInput>,
  strategy: NonNullable<CachePolicyObject["messages"]>,
) => {
  const candidates = messages.flatMap((message, index) => (stableMessage(message) ? [index] : []))
  if (strategy === "latest-user-message" || strategy === "latest-assistant") return []
  return candidates.slice(Math.max(0, candidates.length - strategy.tail))
}

const stableMessage = (message: CacheMessageInput) =>
  message.role === "system" && cacheStable(message.metadata) === true && !message.content.some((part) => isToolPart(part.type))

export const messageBreakpointPartIndex = (message: { readonly content: ReadonlyArray<{ readonly type?: string }> }) => {
  const lastText = message.content.findLastIndex((part) => part.type === "text")
  return lastText >= 0 ? lastText : message.content.length - 1
}

const cacheStable = (metadata: unknown) => {
  if (!isRecord(metadata)) return undefined
  const cache = metadata.cache
  if (!isRecord(cache)) return undefined
  return typeof cache.stable === "boolean" ? cache.stable : undefined
}

const cacheMode = (
  promptCaching: ReturnType<typeof getCacheCapabilities>["promptCaching"],
  supportsBreakpoints: boolean,
  supportsInlineHints: boolean,
  hasStablePrefix: boolean,
  policy: CachePolicyObject,
): CacheMode => {
  if (!hasStablePrefix || (!policy.tools && !policy.system && !policy.messages)) return "disabled"
  if (promptCaching === "automatic_and_explicit")
    return supportsBreakpoints || supportsInlineHints ? "automatic_and_explicit" : "automatic"
  if (promptCaching === "explicit" || supportsInlineHints) return "explicit"
  if (promptCaching === "automatic") return "automatic"
  return "disabled"
}

const hasAutomaticSlot = (input: {
  readonly mode: CacheMode
  readonly maximumBreakpoints: number | null
  readonly breakpoints: CachePlan["breakpoints"]
  readonly system: ReadonlyArray<CacheSystemPartInput>
  readonly messages: ReadonlyArray<CacheMessageInput>
  readonly tools: ReadonlyArray<CacheToolDefinitionInput>
}) => {
  if (input.mode !== "automatic_and_explicit" || input.maximumBreakpoints === null) return false
  const occupied = new Set<string>()
  for (const [index, tool] of input.tools.entries()) {
    if (isExplicitCacheHint(tool.cache)) occupied.add(`tools:${index}`)
  }
  for (const [index, part] of input.system.entries()) {
    if (isExplicitCacheHint(part.cache)) occupied.add(`system:${index}`)
  }
  for (const [messageIndex, message] of input.messages.entries()) {
    for (const [partIndex, part] of message.content.entries()) {
      if (isExplicitCacheHint(part.cache)) occupied.add(`messages:${messageIndex}:${partIndex}`)
    }
  }
  for (const breakpoint of input.breakpoints) {
    if (breakpoint.component !== "messages") {
      occupied.add(`${breakpoint.component}:${breakpoint.index}`)
      continue
    }
    const message = input.messages[breakpoint.index]
    if (!message || message.content.length === 0) continue
    const partIndex = messageBreakpointPartIndex(message)
    occupied.add(`messages:${breakpoint.index}:${partIndex}`)
  }
  return occupied.size < input.maximumBreakpoints
}

const isExplicitCacheHint = (value: unknown) =>
  isRecord(value) && (value.type === "ephemeral" || value.type === "persistent")

const cacheDuration = (ttlSeconds: number | undefined): CacheDuration => (ttlSeconds !== undefined && ttlSeconds >= 3600 ? "1h" : "5m")

const limitBreakpoints = <T>(breakpoints: ReadonlyArray<T>, maximum: number | null) =>
  maximum === null ? breakpoints : breakpoints.slice(Math.max(0, breakpoints.length - maximum))

const cacheKey = (fingerprint: string) => `oc2-v${CACHE_PLANNER_VERSION}-${fingerprint.split(":").at(-1)?.slice(0, 64) ?? fingerprint}`

const volatileProviderConfigKeys = new Set(["promptCacheKey", "prompt_cache_key", "requestID", "requestId", "sessionID", "sessionId"])

const sanitizeProviderConfig = (value: Record<string, unknown> | null | undefined): Record<string, unknown> | null => {
  if (value === undefined || value === null) return null
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (volatileProviderConfigKeys.has(key)) return []
      return [[key, isRecord(item) ? sanitizeProviderConfig(item) : item]]
    }),
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCachePlan = (value: unknown): value is CachePlan =>
  isRecord(value) &&
  typeof value.provider === "string" &&
  typeof value.model === "string" &&
  typeof value.stablePrefixFingerprint === "string" &&
  isRecord(value.componentFingerprints) &&
  Object.values(value.componentFingerprints).every((fingerprint) => typeof fingerprint === "string") &&
  CACHE_MODES.has(value.mode) &&
  typeof value.eligible === "boolean" &&
  (value.duration === null || value.duration === "5m" || value.duration === "1h") &&
  (value.requestCacheControl === undefined ||
    (isRecord(value.requestCacheControl) &&
      value.requestCacheControl.type === "ephemeral" &&
      (value.requestCacheControl.ttl === undefined || value.requestCacheControl.ttl === "1h"))) &&
  Array.isArray(value.breakpoints) &&
  value.breakpoints.every(
    (breakpoint) =>
      isRecord(breakpoint) &&
      typeof breakpoint.component === "string" &&
      typeof breakpoint.contentType === "string" &&
      Number.isInteger(breakpoint.index) &&
      (breakpoint.index as number) >= 0,
  )

const CACHE_MODES = new Set<unknown>(["disabled", "automatic", "implicit", "explicit", "automatic_and_explicit"])

const hasDuplicateBreakpointTarget = (breakpoints: CachePlan["breakpoints"]) => {
  const targets = new Set<string>()
  for (const breakpoint of breakpoints) {
    const target = `${breakpoint.component}:${breakpoint.index}`
    if (targets.has(target)) return true
    targets.add(target)
  }
  return false
}

const allowedModes = (mode: CacheMode): ReadonlySet<CacheMode> => {
  if (mode === "automatic_and_explicit")
    return new Set(["disabled", "automatic", "explicit", "automatic_and_explicit"])
  return new Set(["disabled", mode])
}

const hasBreakpoint = (
  fresh: CachePlan["breakpoints"],
  value: CachePlan["breakpoints"][number],
  stable: CacheBoundarySelection | undefined,
) =>
  fresh.some(
    (breakpoint) =>
      breakpoint.component === value.component &&
      breakpoint.contentType === value.contentType &&
      breakpoint.index === value.index,
  ) ||
  (value.component === "tools" && value.contentType === "tool" && stable?.tools.includes(value.index) === true) ||
  (value.component === "system" && value.contentType === "system" && stable?.system.includes(value.index) === true) ||
  (value.component === "messages" && value.contentType === "message" && stable?.messages.includes(value.index) === true)

const sameRecord = (left: Record<string, string>, right: Record<string, string>) => {
  const keys = Object.keys({ ...left, ...right })
  return keys.every((key) => left[key] === right[key])
}

const isToolPart = (type: unknown) => type === "tool-call" || type === "tool-result"

export * as CachePlanner from "./planner"
