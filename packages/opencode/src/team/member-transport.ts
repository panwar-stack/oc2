import { Naming } from "@oc2-ai/core/naming"
import { Effect, Option } from "effect"

/**
 * Member-side control-plane transport for the multi-process team mode
 * (specs/multiprocess-agent-teams.md, PR 5).
 *
 * A spawned member process parks on the lead's SSE events stream instead of an
 * in-memory park. This module owns the two transport concerns:
 *
 * - {@link openMemberEventsStream}: a bounded-backoff SSE client that yields
 *   parsed events and stops cleanly on abort or `team.closed`.
 * - {@link startMemberHeartbeat}: a non-fatal liveness beacon so the lead's
 *   durable lost-member detection can see an idle daemon.
 *
 * Both use plain `fetch` + `AbortSignal`, matching the `controlPlaneRequest`
 * style in `cli/cmd/teammate.ts`. Heartbeats are liveness only: the server
 * refreshes `daemon_last_active` without bumping the team revision or changing
 * the member status.
 */

/** Basic-auth username shared by the member env contract. */
const SERVER_USERNAME = "oc2"

/** Control-plane request timeout for one-shot requests. */
const CONTACT_TIMEOUT_MS = 15_000

/** Default heartbeat cadence. Well below the server's durable lost-member window. */
export const HEARTBEAT_INTERVAL_MS = 20_000

/** First reconnect delay after a dropped SSE connection. */
const RECONNECT_BASE_MS = 250

/** Maximum reconnect delay; the backoff is bounded and never busy-waits. */
const RECONNECT_MAX_MS = 5_000

/** Connection identity for the member transport. Mirrors the env contract. */
export interface MemberTransportConfig {
  readonly leadURL: string
  readonly teamID: string
  readonly sessionID: string
  readonly secret: string
  readonly directory: string
}

/** A parsed SSE event from the member events stream. `properties` is the
 * decoded JSON payload the handler published (`{ id, type, properties }`). */
export interface MemberEvent {
  readonly type: string
  readonly id?: string
  readonly properties: Record<string, unknown>
}

/** A `team.run` wake: a persisted instruction the lead admitted for this member. */
export interface MemberRunEvent extends MemberEvent {
  readonly type: "team.run"
}

/** A `team.wake` event: the member has addressable work without a run payload. */
export interface MemberWakeEvent extends MemberEvent {
  readonly type: "team.wake"
}

/** A `team.mail` event: pending mailbox rows exist for this member. */
export interface MemberMailEvent extends MemberEvent {
  readonly type: "team.mail"
}

/** A `team.plan` event: a plan decision applies to this member. */
export interface MemberPlanEvent extends MemberEvent {
  readonly type: "team.plan"
}

/** The action a handler returns to the parking stream. */
export type MemberEventAction = "continue" | "stop"

/** Handles one parsed event. Returning `stop` ends the parked stream cleanly. */
export type MemberEventHandler<E = never, R = never> = (event: MemberEvent) => Effect.Effect<MemberEventAction, E, R>

/** Outcome of one SSE connection attempt. `connected` distinguishes a drop
 * after a successful connect (reset backoff) from a failed connect (grow it). */
type StreamOutcome = { readonly result: "stopped" | "reconnect"; readonly connected: boolean }

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

function eventsURL(config: MemberTransportConfig): string {
  return `${trimTrailingSlash(config.leadURL)}/team/${encodeURIComponent(config.teamID)}/members/${encodeURIComponent(config.sessionID)}/events?sessionID=${encodeURIComponent(config.sessionID)}`
}

function heartbeatURL(config: MemberTransportConfig): string {
  return `${trimTrailingSlash(config.leadURL)}/team/${encodeURIComponent(config.teamID)}/members/${encodeURIComponent(config.sessionID)}/heartbeat?sessionID=${encodeURIComponent(config.sessionID)}`
}

function authHeaders(config: MemberTransportConfig): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${SERVER_USERNAME}:${config.secret}`, "utf8").toString("base64")}`,
    [Naming.headers.directory]: config.directory,
  }
}

/** Parses one SSE frame (the text between blank lines) into a member event.
 * Comments and frames without `data` are ignored. Malformed JSON is ignored
 * so one bad frame never kills the stream. */
function parseSSEFrame(frame: string): MemberEvent | undefined {
  let eventName = "message"
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") eventName = value
    else if (field === "data") dataLines.push(value)
  }
  if (dataLines.length === 0) return undefined
  const raw = dataLines.join("\n")
  if (raw.trim() === "") return undefined
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type : eventName
  const properties =
    typeof record.properties === "object" && record.properties !== null
      ? (record.properties as Record<string, unknown>)
      : {}
  return {
    type,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    properties,
  }
}

/**
 * Opens one SSE connection and feeds parsed events to `onEvent` until the
 * server closes the stream, `onEvent` returns `stop`, or the connection is
 * aborted. Transport faults (connect failure, mid-stream drop) return
 * `reconnect` so the caller applies bounded backoff. Handler failures propagate.
 */
const streamOnce = <E, R>(
  config: MemberTransportConfig,
  onEvent: MemberEventHandler<E, R>,
  external?: AbortSignal,
): Effect.Effect<StreamOutcome, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      // The controller is aborted by the scope finalizer, so fiber interruption
      // and scope close both cancel the in-flight fetch and body reader.
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      if (external) {
        const onAbort = () => controller.abort()
        if (external.aborted) controller.abort()
        else external.addEventListener("abort", onAbort, { once: true })
        yield* Effect.addFinalizer(() => Effect.sync(() => external.removeEventListener("abort", onAbort)))
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(eventsURL(config), {
            method: "GET",
            headers: { ...authHeaders(config), Accept: "text/event-stream" },
            signal: controller.signal,
          }),
        catch: asError,
      }).pipe(Effect.option)
      if (Option.isNone(response)) {
        return { result: controller.signal.aborted ? "stopped" : "reconnect", connected: false } as const
      }
      const res = response.value
      if (!res.ok || !res.body) {
        return { result: "reconnect", connected: res.ok } as const
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      while (!controller.signal.aborted) {
        const read = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: asError,
        }).pipe(Effect.option)
        if (Option.isNone(read)) {
          return { result: controller.signal.aborted ? "stopped" : "reconnect", connected: true } as const
        }
        const chunk = read.value
        if (chunk.done) return { result: "reconnect", connected: true } as const
        buffer += chunk.value
        let index: number
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseSSEFrame(frame)
          if (!event) continue
          const action = yield* onEvent(event)
          if (action === "stop") {
            yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore)
            return { result: "stopped", connected: true } as const
          }
        }
      }
      return { result: "stopped", connected: true } as const
    }),
  )

/** Sleeps for `ms`, returning early when the abort signal fires. */
const sleepOrAbort = (ms: number, signal?: AbortSignal): Effect.Effect<void> => {
  if (signal === undefined) return Effect.sleep(`${ms} millis`)
  if (signal.aborted) return Effect.void
  return Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), ms)
    const onAbort = () => {
      clearTimeout(timer)
      resume(Effect.void)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    })
  })
}

/**
 * Parks on the lead's member events stream. Reconnects with bounded
 * exponential backoff after a drop and returns cleanly when `onEvent` returns
 * `stop` (for example on `team.closed` or a terminal member event) or when the
 * optional abort signal fires. Never busy-waits: each reconnect sleeps.
 */
export const openMemberEventsStream = <E, R>(
  config: MemberTransportConfig,
  onEvent: MemberEventHandler<E, R>,
  signal?: AbortSignal,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    let attempt = 0
    while (true) {
      if (signal?.aborted) return
      const outcome = yield* streamOnce(config, onEvent, signal)
      if (signal?.aborted || outcome.result === "stopped") return
      attempt = outcome.connected ? 0 : attempt + 1
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 8))
      yield* sleepOrAbort(delay, signal)
    }
  })

/** Daemon liveness phase sent with a heartbeat. */
export type MemberDaemonState = "initializing" | "running" | "idle"

/** Options for {@link startMemberHeartbeat}. `daemonState` may be a getter so a
 * long-lived daemon reports its current phase without restarting the timer. */
export interface MemberHeartbeatOptions {
  readonly daemonState?: MemberDaemonState | (() => MemberDaemonState | undefined)
  readonly daemonError?: string | null
  readonly intervalMs?: number
}

function resolveDaemonState(value: MemberHeartbeatOptions["daemonState"]): MemberDaemonState | undefined {
  return typeof value === "function" ? value() : value
}

/** Stops the heartbeat interval. Safe to call more than once. */
export type StopHeartbeat = () => void

/** One heartbeat POST. Never rejects: heartbeat failures are non-fatal. */
async function heartbeatRequest(
  config: MemberTransportConfig,
  options: MemberHeartbeatOptions | undefined,
): Promise<void> {
  const body: Record<string, unknown> = {}
  const daemonState = resolveDaemonState(options?.daemonState)
  if (daemonState !== undefined) body.daemon_state = daemonState
  if (options?.daemonError !== undefined) body.daemon_error = options.daemonError
  try {
    await fetch(heartbeatURL(config), {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTACT_TIMEOUT_MS),
    })
  } catch {
    // Liveness is best-effort. A dropped lead marks the member lost on its own clock.
  }
}

/**
 * Starts a repeating heartbeat and returns a stop function. The first beat is
 * sent immediately so a freshly parked member starts its liveness clock at
 * once. Failures are swallowed: heartbeats are liveness only and never block
 * the member run loop.
 */
export const startMemberHeartbeat = (
  config: MemberTransportConfig,
  options?: MemberHeartbeatOptions,
): Effect.Effect<StopHeartbeat> =>
  Effect.sync(() => {
    let stopped = false
    const beat = () => {
      if (stopped) return
      void heartbeatRequest(config, options)
    }
    const timer = setInterval(beat, options?.intervalMs ?? HEARTBEAT_INTERVAL_MS)
    if (typeof timer.unref === "function") timer.unref()
    beat()
    return () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    }
  })

export * as MemberTransport from "./member-transport"
