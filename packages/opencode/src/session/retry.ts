import type { NamedError } from "@oc2-ai/core/util/error"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import type { CachePlan } from "@oc2-ai/llm/cache/planner"
import { Cause, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const CACHE_METADATA_KEY = "promptCache"
export const CACHE_RETRY_METADATA_VERSION = 1

export type CacheIntent = "conversation" | "compaction" | "summary"
export type CacheChangeKind = "resume" | "retry"
export type CacheChangeReason =
  | "provider"
  | "model"
  | "request_format"
  | "prompt_version"
  | "repository_context_version"
  | "tools"
  | "schemas"
  | "stable_prefix"

export type CacheUse = {
  version: typeof CACHE_RETRY_METADATA_VERSION
  provider: string
  model: string
  requestFormat: string
  promptVersion: number
  repositoryContextVersion: number | null
  stablePrefixFingerprint: string
  toolsFingerprint: string | null
  schemasFingerprint: string | null
  componentFingerprints: Record<string, string>
  cacheKey: string | null
  eligible: boolean
  mode: CachePlan["mode"]
}

export type CacheChange = {
  version: typeof CACHE_RETRY_METADATA_VERSION
  kind: CacheChangeKind
  attempt: number
  reasons: CacheChangeReason[]
  expectedMiss: boolean
  previous: CacheUse
  current: CacheUse
  observedAt: number
}

export type CacheMetadata = {
  version: typeof CACHE_RETRY_METADATA_VERSION
  last?: CacheUse
  auxiliary?: CacheUse
  changes: CacheChange[]
}

export function cacheUse(input: {
  plan: CachePlan
  requestFormat: string
  promptVersion: number
  repositoryContextVersion?: number | null
}): CacheUse {
  return {
    version: CACHE_RETRY_METADATA_VERSION,
    provider: input.plan.provider,
    model: input.plan.model,
    requestFormat: input.requestFormat,
    promptVersion: input.promptVersion,
    repositoryContextVersion: input.repositoryContextVersion ?? null,
    stablePrefixFingerprint: input.plan.stablePrefixFingerprint,
    toolsFingerprint: input.plan.componentFingerprints.tools ?? null,
    schemasFingerprint: input.plan.componentFingerprints.schemas ?? null,
    componentFingerprints: { ...input.plan.componentFingerprints },
    cacheKey: input.plan.cacheKey,
    eligible: input.plan.eligible,
    mode: input.plan.mode,
  }
}

export function metadata(input: unknown): CacheMetadata {
  if (!isRecord(input)) return { version: CACHE_RETRY_METADATA_VERSION, changes: [] }
  const raw = input[CACHE_METADATA_KEY]
  if (!isRecord(raw) || raw.version !== CACHE_RETRY_METADATA_VERSION) {
    return { version: CACHE_RETRY_METADATA_VERSION, changes: [] }
  }
  return {
    version: CACHE_RETRY_METADATA_VERSION,
    last: useFrom(raw.last),
    auxiliary: useFrom(raw.auxiliary),
    changes: Array.isArray(raw.changes) ? raw.changes.flatMap(changeFrom).slice(-32) : [],
  }
}

export function compare(previous: CacheUse, current: CacheUse): CacheChangeReason[] {
  return [
    ...(previous.provider === current.provider ? [] : ["provider" as const]),
    ...(previous.model === current.model ? [] : ["model" as const]),
    ...(previous.requestFormat === current.requestFormat ? [] : ["request_format" as const]),
    ...(previous.promptVersion === current.promptVersion ? [] : ["prompt_version" as const]),
    ...(previous.repositoryContextVersion === current.repositoryContextVersion
      ? []
      : ["repository_context_version" as const]),
    ...(previous.toolsFingerprint === current.toolsFingerprint ? [] : ["tools" as const]),
    ...(previous.schemasFingerprint === current.schemasFingerprint ? [] : ["schemas" as const]),
    ...(previous.stablePrefixFingerprint === current.stablePrefixFingerprint ? [] : ["stable_prefix" as const]),
  ]
}

export function expectedMiss(input: { intent: CacheIntent; reasons: CacheChangeReason[] }) {
  return input.intent !== "conversation" && input.reasons.includes("stable_prefix")
}

export function record(input: {
  metadata: CacheMetadata
  current: CacheUse
  kind: CacheChangeKind
  attempt: number
  intent: CacheIntent
  previous?: CacheUse
  observedAt?: number
}): { metadata: CacheMetadata; change?: CacheChange; expectedMiss: boolean } {
  const reasons = input.previous ? compare(input.previous, input.current) : []
  const expected = expectedMiss({ intent: input.intent, reasons })
  const change: CacheChange | undefined = input.previous && reasons.length > 0
    ? {
        version: CACHE_RETRY_METADATA_VERSION,
        kind: input.kind,
        attempt: input.attempt,
        reasons,
        expectedMiss: expected,
        previous: input.previous,
        current: input.current,
        observedAt: input.observedAt ?? Date.now(),
      }
    : undefined
  return {
    metadata: {
      version: CACHE_RETRY_METADATA_VERSION,
      last: input.intent === "conversation" ? input.current : input.metadata.last,
      auxiliary: input.intent === "conversation" ? input.metadata.auxiliary : input.current,
      changes: [...input.metadata.changes, ...(change ? [change] : [])].slice(-32),
    },
    change,
    expectedMiss: expected,
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_ATTEMPTS = 8
export const RETRY_MAX_ELAPSED = 15 * 60 * 1000
export const RETRY_MAX_DELAY = RETRY_MAX_ELAPSED
const HTTP_DATE_IMF = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (0[1-9]|[12][0-9]|3[01]) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ((?:[01][0-9]|2[0-3])):([0-5][0-9]):([0-5][0-9]) GMT$/
const HTTP_DATE_RFC850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (0[1-9]|[12][0-9]|3[01])-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ((?:[01][0-9]|2[0-3])):([0-5][0-9]):([0-5][0-9]) GMT$/
const HTTP_DATE_ASCTIME = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12][0-9]|3[01]) ((?:[01][0-9]|2[0-3])):([0-5][0-9]):([0-5][0-9]) ([0-9]{4})$/
const HTTP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const HTTP_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

function defaultDelay(attempt: number) {
  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

function parseHttpDate(value: string, now: number) {
  const imf = HTTP_DATE_IMF.exec(value)
  const rfc850 = HTTP_DATE_RFC850.exec(value)
  const asctime = HTTP_DATE_ASCTIME.exec(value)
  const match = imf ?? rfc850 ?? asctime
  if (!match) return
  const weekday = match[1]?.slice(0, 3)
  const day = Number(imf?.[2] ?? rfc850?.[2] ?? asctime?.[3])
  const month = HTTP_MONTHS.indexOf(imf?.[3] ?? rfc850?.[3] ?? asctime?.[2] ?? "")
  const currentYear = new Date(now).getUTCFullYear()
  const shortYear = Number(rfc850?.[4])
  const candidateYear = Math.floor(currentYear / 100) * 100 + shortYear
  const year = imf
    ? Number(imf[4])
    : asctime
      ? Number(asctime[7])
      : candidateYear > currentYear + 50
        ? candidateYear - 100
        : candidateYear
  const hour = Number(imf?.[5] ?? rfc850?.[5] ?? asctime?.[4])
  const minute = Number(imf?.[6] ?? rfc850?.[6] ?? asctime?.[5])
  const second = Number(imf?.[7] ?? rfc850?.[7] ?? asctime?.[6])
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, second, 0)
  if (
    HTTP_WEEKDAYS[date.getUTCDay()] !== weekday ||
    date.getUTCDate() !== day ||
    date.getUTCMonth() !== month ||
    date.getUTCFullYear() !== year ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return
  return date.getTime()
}

export function delay(attempt: number, error?: SessionV1.APIError, now = Date.now()) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      const retryAfter = headers["retry-after"]
      if (retryAfterMs) {
        const parsedMs = Number(retryAfterMs)
        if (Number.isFinite(parsedMs) && parsedMs >= 0) {
          return cap(parsedMs)
        }
      }

      if (retryAfter) {
        if (/^[0-9]+$/.test(retryAfter)) {
          const parsedSeconds = Number(retryAfter)
          if (Number.isFinite(parsedSeconds)) return cap(parsedSeconds * 1000)
        } else {
          const parsed = parseHttpDate(retryAfter, now)
          const wait = parsed === undefined ? undefined : parsed - now
          if (wait !== undefined && wait > 0) {
            return cap(Math.ceil(wait))
          }
        }
      }

      return defaultDelay(attempt)
    }
  }

  return defaultDelay(attempt)
}

export function retryable(error: Err, _provider: string): Retryable | undefined {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

function useFrom(value: unknown): CacheUse | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.version !== CACHE_RETRY_METADATA_VERSION ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.requestFormat !== "string" ||
    typeof value.promptVersion !== "number" ||
    typeof value.stablePrefixFingerprint !== "string" ||
    typeof value.eligible !== "boolean" ||
    typeof value.mode !== "string" ||
    !isRecord(value.componentFingerprints)
  ) {
    return undefined
  }
  return {
    version: CACHE_RETRY_METADATA_VERSION,
    provider: value.provider,
    model: value.model,
    requestFormat: value.requestFormat,
    promptVersion: value.promptVersion,
    repositoryContextVersion:
      typeof value.repositoryContextVersion === "number" ? value.repositoryContextVersion : null,
    stablePrefixFingerprint: value.stablePrefixFingerprint,
    toolsFingerprint: typeof value.toolsFingerprint === "string" ? value.toolsFingerprint : null,
    schemasFingerprint: typeof value.schemasFingerprint === "string" ? value.schemasFingerprint : null,
    componentFingerprints: Object.fromEntries(
      Object.entries(value.componentFingerprints).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    cacheKey: typeof value.cacheKey === "string" ? value.cacheKey : null,
    eligible: value.eligible,
    mode: value.mode as CachePlan["mode"],
  }
}

function changeFrom(value: unknown): CacheChange[] {
  if (!isRecord(value)) return []
  const previous = useFrom(value.previous)
  const current = useFrom(value.current)
  if (
    value.version !== CACHE_RETRY_METADATA_VERSION ||
    (value.kind !== "resume" && value.kind !== "retry") ||
    typeof value.attempt !== "number" ||
    typeof value.expectedMiss !== "boolean" ||
    typeof value.observedAt !== "number" ||
    !Array.isArray(value.reasons) ||
    !previous ||
    !current
  ) {
    return []
  }
  return [
    {
      version: CACHE_RETRY_METADATA_VERSION,
      kind: value.kind,
      attempt: value.attempt,
      expectedMiss: value.expectedMiss,
      observedAt: value.observedAt,
      reasons: value.reasons.filter(isChangeReason),
      previous,
      current,
    },
  ]
}

function isChangeReason(value: unknown): value is CacheChangeReason {
  return (
    value === "provider" ||
    value === "model" ||
    value === "request_format" ||
    value === "prompt_version" ||
    value === "repository_context_version" ||
    value === "tools" ||
    value === "schemas" ||
    value === "stable_prefix"
  )
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
  startedAt?: number
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      const elapsed = opts.startedAt === undefined ? meta.elapsed : Math.max(0, meta.now - opts.startedAt)
      if (meta.attempt >= RETRY_MAX_ATTEMPTS || elapsed >= RETRY_MAX_ELAPSED) {
        return Cause.done(meta.attempt)
      }
      const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined, meta.now)
      if (elapsed + wait >= RETRY_MAX_ELAPSED) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: meta.now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
