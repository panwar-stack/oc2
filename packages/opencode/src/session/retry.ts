import type { NamedError } from "@oc2-ai/core/util/error"
import { SessionV1 } from "@oc2-ai/core/v1/session"
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
