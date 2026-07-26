import WebSocket from "ws"
import * as Log from "@oc2-ai/core/util/log"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"

export const TITLE_HEADER = "x-oc2-title"

const log = Log.create({ service: "plugin.openai.ws" })

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  poolIdleTimeout?: number
  responseSilenceTimeout?: number
  heartbeatInterval?: number
  pongTimeout?: number
  websocketFailureBudget?: number
  /** @deprecated Use poolIdleTimeout and responseSilenceTimeout. */
  idleTimeout?: number
  maxConnectionAge?: number
  /** @deprecated Use websocketFailureBudget. */
  streamRetries?: number
}

interface PoolEntry {
  socket?: WebSocket
  connecting?: AbortController
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  websocketFailures: number
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_POOL_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_RESPONSE_SILENCE_TIMEOUT = 20 * 60 * 1000
const DEFAULT_HEARTBEAT_INTERVAL = 30_000
const DEFAULT_PONG_TIMEOUT = 90_000
const DEFAULT_WEBSOCKET_FAILURE_BUDGET = 5
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const poolIdleTimeout = options?.poolIdleTimeout ?? options?.idleTimeout ?? DEFAULT_POOL_IDLE_TIMEOUT
  const responseSilenceTimeout =
    options?.responseSilenceTimeout ?? options?.idleTimeout ?? DEFAULT_RESPONSE_SILENCE_TIMEOUT
  const heartbeatInterval = options?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL
  const pongTimeout = options?.pongTimeout ?? DEFAULT_PONG_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const websocketFailureBudget =
    options?.websocketFailureBudget ?? options?.streamRetries ?? DEFAULT_WEBSOCKET_FAILURE_BUDGET
  const pruneTimer = setInterval(() => prune(), Math.min(poolIdleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalHeaders(init)

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) {
      return httpFetch(input, httpInit)
    }

    const body = (() => {
      try {
        if (typeof init?.body !== "string") return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return httpFetch(input, httpInit)
    if (internalHeaders[TITLE_HEADER] === "true") {
      log.debug("http fallback", { reason: "title" })
      return httpFetch(input, httpInit)
    }

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) {
      log.debug("http fallback", { reason: "missing_session" })
      return httpFetch(input, httpInit)
    }
    const key = `${sessionID}:conversation`

    const entry = pool.get(key) ?? { lastUsedAt: Date.now(), busy: false, fallback: false, websocketFailures: 0 }
    pool.set(key, entry)

    if (entry.fallback) {
      log.debug("http fallback", { key, reason: "fallback_active" })
      return httpFetch(input, httpInit)
    }
    if (entry.busy) {
      log.debug("http fallback", { key, reason: "busy" })
      return httpFetch(input, httpInit)
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    let connecting: AbortController | undefined
    try {
      connecting = new AbortController()
      entry.connecting = connecting
      const signal = init?.signal ? AbortSignal.any([init.signal, connecting.signal]) : connecting.signal
      const connected = await socket(
        entry,
        options?.url ?? url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        signal,
      )
      if (entry.connecting === connecting) entry.connecting = undefined
      if (pool.get(key) !== entry) {
        connected.on("error", () => {})
        connected.terminate()
        throw new DOMException("WebSocket pool entry was removed while connecting", "AbortError")
      }
      entry.socket = connected
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      let firstEventStarted = false
      let firstEventError: ProviderError.ResponseStreamError | undefined
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body,
        responseSilenceTimeout,
        heartbeatInterval,
        pongTimeout,
        signal: init?.signal ?? undefined,
        onFirstEvent: (error) => {
          firstEventStarted = true
          resolveFirstEvent(error ?? true)
        },
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.websocketFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            log.warn("websocket terminal failure", { key, type: event.type })
            invalidate(entry)
          }
        },
        onConnectionInvalid: (error) => {
          log.warn("websocket invalidated", { key, error: error.message })
          entry.busy = false
          entry.lastUsedAt = Date.now()
          if (!entry.fallback) recordWebsocketFailure(entry)
          invalidate(entry)
          if (firstEventStarted) return
          firstEventError = error
          resolveFirstEvent(false)
          return false
        },
        onAbort: (error) => {
          log.debug("websocket aborted", { key })
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.websocketFailures = 0
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          const error = connectionLimitError(event)
          if (!error) return undefined
          log.warn("websocket connection limit reached", { key })
          throw error
        },
      })
      const first = await firstEvent
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      if (!entry.fallback && firstEventError) return failedResponse(firstEventError, true)
      if (!entry.fallback) return response
      log.debug("http fallback", { key, reason: "websocket_retries_exhausted" })
      return httpFetch(input, httpInit)
    } catch (error) {
      if (entry.connecting === connecting) entry.connecting = undefined
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        entry.websocketFailures = 0
        invalidate(entry)
        throw error
      }

      recordWebsocketFailure(entry)
      log.warn("websocket setup failed", {
        key,
        error: error instanceof Error ? error.message : String(error),
        fallback: entry.fallback ? "http" : undefined,
      })
      invalidate(entry)
      if (entry.fallback) return httpFetch(input, httpInit)
      return failedResponse(
        new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
      )
    }
  }

  function recordWebsocketFailure(entry: PoolEntry) {
    entry.websocketFailures++
    // Preserve the legacy threshold: the budget applies after the initial failure.
    if (entry.websocketFailures > websocketFailureBudget) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy) continue
      if (entry.fallback) continue
      if (now - entry.lastUsedAt < poolIdleTimeout) continue
      log.debug("websocket idle prune", { key })
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    log.debug("websocket pool close", { count: pool.size })
    clearInterval(pruneTimer)
    for (const entry of pool.values()) {
      entry.connecting?.abort(new Error("WebSocket pool closed"))
      invalidate(entry)
    }
    pool.clear()
  }

  function remove(sessionID: string) {
    const key = `${sessionID}:conversation`
    const entry = pool.get(key)
    if (!entry) return
    log.debug("websocket pool remove", { key })
    entry.connecting?.abort(new Error("WebSocket pool entry removed"))
    invalidate(entry)
    pool.delete(key)
  }

  return Object.assign(websocketFetch, { close, remove })
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) return
  return new Error(typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE)
}

function failedResponse(error: ProviderError.ResponseStreamError, lazy = false) {
  if (lazy) {
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(error)
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    )
  }

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge
  ) {
    return entry.socket
  }

  invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
  })
  entry.connectedAt = Date.now()
  return next
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return { ...init, headers: init.headers.filter((item) => item[0].toLowerCase() !== TITLE_HEADER) }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => key.toLowerCase() !== TITLE_HEADER)),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"
