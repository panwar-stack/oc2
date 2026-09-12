import { ServerAddress } from "@/server/address"
import { OC2_TEAM_LEAD_URL } from "@oc2-ai/core/util/opencode-process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

/**
 * How long a spawned member process may go without refreshing its liveness
 * clock (`team_member.daemon_last_active`) before the lead treats it as lost.
 * The clock starts at spawn (`spawnRemoteMember`) and every heartbeat refreshes
 * it. Detection reuses the existing 500ms reconcile tick; this constant is only
 * the staleness threshold, not a poll interval.
 */
export const LOST_MEMBER_TIMEOUT_MS = 120_000

/**
 * Environment override for {@link LOST_MEMBER_TIMEOUT_MS}. It exists so tests
 * can exercise durable lost-member detection quickly and deterministically
 * without waiting two real minutes. The value must be a positive finite integer
 * (milliseconds); any other value falls back to the default constant. It is read
 * by the caller at reconcile time, not at module load, so a test can set it.
 */
export const OC2_TEAM_LOST_MEMBER_TIMEOUT_MS = "OC2_TEAM_LOST_MEMBER_TIMEOUT_MS"

/** Resolves the lost-member staleness threshold in milliseconds. An explicit
 * positive integer `OC2_TEAM_LOST_MEMBER_TIMEOUT_MS` wins; otherwise the
 * exported {@link LOST_MEMBER_TIMEOUT_MS} default applies. */
export function resolveLostMemberTimeoutMs(): number {
  const raw = process.env[OC2_TEAM_LOST_MEMBER_TIMEOUT_MS]?.trim()
  if (!raw) return LOST_MEMBER_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return LOST_MEMBER_TIMEOUT_MS
  return parsed
}

/**
 * Resolves the control-plane base URL a lead advertises to spawned member
 * processes. An explicit `OC2_TEAM_LEAD_URL` wins (trimmed, nonempty) so a
 * cross-VM deployment can pin a reachable host. Otherwise the URL this process
 * last listened on is used, which is the common same-host case.
 */
export function resolveLeadControlPlaneURL(): string | undefined {
  const configured = process.env[OC2_TEAM_LEAD_URL]?.trim()
  if (configured) return configured
  return ServerAddress.url?.origin
}

/**
 * True only when the opt-in multi-process transport is explicitly enabled.
 * The flag is absent by default, so the single-process path is unchanged.
 */
export function isMultiprocessEnabled(config: { experimental?: { team_multiprocess?: boolean } } | undefined): boolean {
  return config?.experimental?.team_multiprocess === true
}

/** Loopback host the control-plane bridge binds when no explicit
 * `OC2_TEAM_LEAD_URL` is configured. Matches the CLI network default hostname. */
export const DEFAULT_CONTROL_PLANE_HOST = "127.0.0.1"

/** Port the control-plane bridge prefers. Matches the `Server.listen` port-0
 * preference, so a lead that never called `Server.listen` still advertises the
 * same default a `serve`/`--port` lead would. It falls back to an ephemeral
 * port when 4096 is already taken. */
export const DEFAULT_CONTROL_PLANE_PORT = 4096

/**
 * Process-wide, idempotent control-plane listener. It exists so a lead that
 * never called `Server.listen` (default TUI and default `run` use the in-process
 * `Server.Default().app.fetch` handler) can still expose a reachable HTTP+SSE
 * surface to spawned member processes.
 *
 * It deliberately does NOT call `Server.listen`: `startListener` builds its
 * layer graph with a fresh memo map, so a second listener would construct a
 * second `Database`/`LifecycleReconciler` and run a second 500ms reconcile
 * loop against the same durable store. Instead the bridge forwards to the
 * already-initialized `Server.Default().app.fetch` handler, which shares the
 * module memo map and the one real service graph.
 *
 * The listener is bound once per process. The first caller wins; concurrent
 * callers await the same promise. On failure the promise is cleared so a later
 * reconcile tick can retry.
 */
let controlPlaneListener: Promise<string> | undefined
let controlPlaneServer: Server | undefined
/** Increments on every reset. An in-flight bind whose generation no longer
 * matches closes its late server instead of leaking an untracked handle. */
let controlPlaneGeneration = 0

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else headers.set(name, value)
  }
  return headers
}

/** Buffers a Node request body as an `ArrayBuffer` (`BodyInit`). Control-plane
 * request bodies are small JSON payloads, so buffering is safe and avoids the
 * `duplex: "half"` requirement of a streamed Web `Request` body. Returns
 * `undefined` for bodyless methods so `new Request` never rejects a GET/HEAD. */
async function requestBody(request: IncomingMessage): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const chunks: Uint8Array[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
  }
  if (chunks.length === 0) return new ArrayBuffer(0)
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? `${DEFAULT_CONTROL_PLANE_HOST}:${DEFAULT_CONTROL_PLANE_PORT}`
  const url = new URL(request.url ?? "/", `http://${host}`)
  return new Request(url, {
    method: request.method ?? "GET",
    headers: requestHeaders(request),
    body: await requestBody(request),
  })
}

/** Waits for the response to drain its write buffer. It resolves on `drain`
 * and also on `close`/`error`, because a disconnected socket never emits
 * `drain`, and an unresolved wait would strand the streaming handler. */
function drainOrClose(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      response.removeListener("drain", done)
      response.removeListener("close", done)
      response.removeListener("error", done)
      resolve()
    }
    response.once("drain", done)
    response.once("close", done)
    response.once("error", done)
  })
}

/** Streams a Web `Response` to the Node response without buffering, so SSE
 * frames reach members as they are produced. Client disconnects are detected on
 * the response `close` event (a response that closes before `writableEnded` is
 * a disconnect); the request `close` event must NOT be used because it fires as
 * soon as a POST body finishes. A disconnect cancels the body reader so a
 * long-lived SSE handler releases its stream. */
async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status
  if (result.statusText) response.statusMessage = result.statusText
  result.headers.forEach((value, name) => response.appendHeader(name, value))
  if (result.body === null) {
    response.end()
    return
  }
  const reader = result.body.getReader()
  let finished = false
  const onClose = () => {
    if (finished || response.writableEnded) return
    void reader.cancel().catch(() => undefined)
  }
  response.once("close", onClose)
  // A client disconnect can surface as an error on the response stream; swallow
  // it here so it never becomes an unhandled error event.
  response.once("error", () => undefined)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        if (!response.write(value)) await drainOrClose(response)
      }
      if (response.destroyed || response.writableEnded) break
    }
    if (!response.writableEnded) response.end()
  } catch (error) {
    if (!response.writableEnded) response.destroy(error instanceof Error ? error : undefined)
  } finally {
    finished = true
    response.removeListener("close", onClose)
    reader.releaseLock()
  }
}

function createBridgeServer(): Server {
  return createServer((request, response) => {
    void (async () => {
      try {
        // Imported lazily so the control-plane module stays importable without
        // pulling the whole server graph (and so tests that only read the
        // resolution helpers do not build it).
        const { Server } = await import("@/server/server")
        const result = await Server.Default().app.fetch(await toWebRequest(request))
        await writeResponse(response, result)
      } catch (error) {
        // `writeResponse` owns the response once it starts; only report here
        // when nothing has been written yet.
        if (!response.headersSent && !response.writableEnded) {
          response.statusCode = 500
          response.end(error instanceof Error ? error.message : "control-plane bridge failure")
        }
      }
    })()
  })
}

function bindBridgeServer(port: number): Promise<Server> {
  const server = createBridgeServer()
  return new Promise<Server>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening)
      // Release the handle of a listener that never bound (for example EADDRINUSE)
      // before the caller tries the ephemeral fallback.
      server.close()
      reject(error)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve(server)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, DEFAULT_CONTROL_PLANE_HOST)
  })
}

/**
 * Ensures the process exposes a reachable control-plane base URL and returns it.
 *
 * Precedence: an explicit `OC2_TEAM_LEAD_URL` wins, then a URL published by an
 * earlier `Server.listen` (serve/web/acp/TUI-external). Only when neither is
 * present does this start the loopback bridge, preferring
 * {@link DEFAULT_CONTROL_PLANE_PORT} and falling back to an ephemeral port.
 *
 * The caller is responsible for the `experimental.team_multiprocess` gate, so
 * default-off mode never binds a socket.
 */
export function ensureLeadControlPlaneListener(): Promise<string> {
  const configured = process.env[OC2_TEAM_LEAD_URL]?.trim()
  if (configured) return Promise.resolve(configured)
  const published = ServerAddress.url?.origin
  if (published) return Promise.resolve(published)
  if (controlPlaneListener) return controlPlaneListener

  const generation = controlPlaneGeneration
  const pending = (async () => {
    let server: Server
    try {
      server = await bindBridgeServer(DEFAULT_CONTROL_PLANE_PORT)
    } catch {
      server = await bindBridgeServer(0)
    }
    // A reset that raced this bind already forgot the generation. Close the
    // late server instead of leaking a handle that no reset can reach.
    if (generation !== controlPlaneGeneration) {
      server.close()
      throw new Error("control-plane listener was reset while binding")
    }
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : DEFAULT_CONTROL_PLANE_PORT
    const url = `http://${DEFAULT_CONTROL_PLANE_HOST}:${port}`
    ServerAddress.setServerURL(new URL(url))
    server.on("error", () => {
      // A post-listen server error must not become an unhandled exception; the
      // bridge is best-effort liveness. A dropped socket is detected by the
      // durable lost-member path, not by this handler.
    })
    server.unref()
    controlPlaneServer = server
    return url
  })().catch((error) => {
    // Clear the memo so a later reconcile tick can retry rather than caching a
    // permanently failed promise. Only clear the entry this attempt owns: a
    // reset plus a newer ensure must not be wiped by this stale failure.
    if (controlPlaneListener === pending) controlPlaneListener = undefined
    throw error
  })
  controlPlaneListener = pending
  return pending
}

/** Closes the bridge and forgets it. Test-only: production keeps the listener
 * for the process lifetime. It clears `ServerAddress` only when the published
 * URL is the bridge's own, so a real `Server.listen` URL is never erased. */
export function resetLeadControlPlaneListener(): void {
  const current = controlPlaneListener
  const server = controlPlaneServer
  controlPlaneListener = undefined
  controlPlaneServer = undefined
  controlPlaneGeneration += 1
  if (!current) return
  void current
    .then((url) => {
      if (ServerAddress.url?.origin === url) ServerAddress.setServerURL(undefined)
    })
    .catch(() => undefined)
  server?.close()
}

export * as TeamControlPlane from "./control-plane"
