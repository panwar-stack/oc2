export interface McpTransport {
  start(): Promise<void>
  send(message: Record<string, unknown>, signal?: AbortSignal): Promise<void>
  onMessage(callback: (message: Record<string, unknown>) => void): void
  onError(callback: (error: Error) => void): void
  onClose(callback: () => void): void
  close(): Promise<void>
}

export interface StdioTransportOptions {
  readonly command: string
  readonly args: string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
}

interface SpawnedProcess {
  stdin: { write(input: string): void; end(): void }
  stdout: ReadableStream<Uint8Array>
  kill(): void
  exited: Promise<number>
}

export class StdioTransport implements McpTransport {
  private process: SpawnedProcess | undefined
  private messageCallbacks: Array<(message: Record<string, unknown>) => void> = []
  private errorCallbacks: Array<(error: Error) => void> = []
  private closeCallbacks: Array<() => void> = []

  constructor(private readonly options: StdioTransportOptions) {}

  async start(): Promise<void> {
    const proc = Bun.spawn({
      cmd: [this.options.command, ...this.options.args],
      cwd: this.options.cwd,
      env: { ...Bun.env, ...this.options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.process = proc as unknown as SpawnedProcess
    void this.readLoop()
  }

  private async readLoop(): Promise<void> {
    const stdout = this.process?.stdout
    if (!stdout) {
      for (const cb of this.errorCallbacks) {
        cb(new Error("StdioTransport: no stdout stream"))
      }
      return
    }
    try {
      await readJsonLines(stdout, (message) => {
        for (const cb of this.messageCallbacks) {
          cb(message)
        }
      })
    } catch (error) {
      for (const cb of this.errorCallbacks) {
        cb(error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      for (const cb of this.closeCallbacks) {
        cb()
      }
    }
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (!this.process) throw new Error("StdioTransport: not started")
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  onMessage(callback: (message: Record<string, unknown>) => void): void {
    this.messageCallbacks.push(callback)
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback)
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  async close(): Promise<void> {
    if (!this.process) return
    this.process.stdin.end()
    this.process.kill()
    await this.process.exited.catch(() => undefined)
  }
}

export interface HttpTransportOptions {
  readonly url: string
  readonly headers?: Record<string, string>
  readonly transport?: "http" | "sse"
  readonly tokenProvider?: (forceRefresh?: boolean) => Promise<Record<string, string>>
}

export class McpHttpAuthRequiredError extends Error {
  override readonly name = "McpHttpAuthRequiredError"
  readonly metadataUrl?: string

  constructor(message: string, metadataUrl?: string) {
    super(message)
    this.metadataUrl = metadataUrl
  }
}

export class HttpTransport implements McpTransport {
  private messageCallbacks: Array<(message: Record<string, unknown>) => void> = []
  private errorCallbacks: Array<(error: Error) => void> = []
  private closeCallbacks: Array<() => void> = []
  private sessionId?: string
  private closed = false
  private sseController?: AbortController
  private readonly controllers = new Set<AbortController>()
  private readonly readers = new Set<{ cancel(): Promise<unknown> }>()

  constructor(private readonly options: HttpTransportOptions) {}

  async start(): Promise<void> {
    if (this.options.transport === "sse") {
      this.setupSse()
    }
  }

  private setupSse(): void {
    const controller = new AbortController()
    this.sseController = controller
    void this.readSse(controller).catch((error) => {
      if (controller.signal.aborted || this.closed) return
      for (const cb of this.errorCallbacks) cb(error instanceof Error ? error : new Error(String(error)))
    })
  }

  async request(message: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const response = await this.post(message, signal)
    if (response.status === 202 || response.status === 204) return undefined
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("text/event-stream")) return await this.readSseResponse(response, signal)
    if (!contentType.includes("application/json")) {
      throw new Error("MCP HTTP response was not JSON")
    }
    return (await response.json()) as Record<string, unknown>
  }

  async send(message: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const response = await this.post(message, signal)
    await response.body?.cancel().catch(() => undefined)
  }

  private async post(
    message: Record<string, unknown>,
    signal?: AbortSignal,
    retriedAuth = false,
    authHeaders?: Record<string, string>,
  ): Promise<Response> {
    if (this.closed) throw new Error("HttpTransport: closed")
    if (signal?.aborted) throw new Error("MCP request cancelled")
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    this.controllers.add(controller)
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authHeaders ?? (await this.options.tokenProvider?.())),
      ...this.options.headers,
    }
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    let keepControllerForClose = false
    try {
      const response = await fetch(this.postUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      this.captureSession(response)
      if (response.status === 401 || response.status === 403) {
        const authHeader = response.headers.get("www-authenticate")
        const metadataUrl = extractResourceMetadata(authHeader)
        if (!retriedAuth && this.options.tokenProvider) {
          await response.body?.cancel().catch(() => undefined)
          const refreshed = await this.options.tokenProvider(true).catch(() => ({}))
          if (Object.keys(refreshed).length > 0) return this.post(message, signal, true, refreshed)
        }
        throw new McpHttpAuthRequiredError("MCP server requires authentication", metadataUrl)
      }
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
      keepControllerForClose = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      return response
    } finally {
      signal?.removeEventListener("abort", onAbort)
      if (!keepControllerForClose) this.controllers.delete(controller)
    }
  }

  onMessage(callback: (message: Record<string, unknown>) => void): void {
    this.messageCallbacks.push(callback)
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback)
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.sseController?.abort()
    this.sseController = undefined
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    for (const reader of this.readers) await reader.cancel().catch(() => undefined)
    this.readers.clear()
    if (this.sessionId) {
      const headers: Record<string, string> = {
        ...(await this.options.tokenProvider?.().catch(() => ({}))),
        ...this.options.headers,
        "Mcp-Session-Id": this.sessionId,
      }
      await fetch(this.postUrl(), {
        method: "DELETE",
        headers,
      }).catch(() => undefined)
    }
    for (const cb of this.closeCallbacks) cb()
    this.messageCallbacks = []
    this.errorCallbacks = []
    this.closeCallbacks = []
  }

  private async readSse(controller: AbortController): Promise<void> {
    const response = await this.getSse(controller)
    this.captureSession(response)
    if (!response.ok) throw new Error(`MCP SSE ${response.status}`)
    const reader = response.body?.getReader()
    if (!reader) return
    this.readers.add(reader)
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (!controller.signal.aborted) {
        const read = await reader.read()
        if (read.done) return
        buffer += decoder.decode(read.value, { stream: true })
        const events = buffer.split("\n\n")
        buffer = events.pop() ?? ""
        for (const event of events) {
          for (const line of event.split("\n")) {
            if (!line.startsWith("data: ")) continue
            try {
              const message = JSON.parse(line.slice(6)) as Record<string, unknown>
              for (const cb of this.messageCallbacks) cb(message)
            } catch {
              // Non-JSON SSE data is ignored.
            }
          }
        }
      }
    } finally {
      this.readers.delete(reader)
    }
  }

  private async getSse(
    controller: AbortController,
    retriedAuth = false,
    authHeaders?: Record<string, string>,
  ): Promise<Response> {
    const response = await fetch(this.sseUrl(), {
      headers: { ...(authHeaders ?? (await this.options.tokenProvider?.())), ...this.options.headers },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      const authHeader = response.headers.get("www-authenticate")
      const metadataUrl = extractResourceMetadata(authHeader)
      if (!retriedAuth && this.options.tokenProvider) {
        await response.body?.cancel().catch(() => undefined)
        const refreshed = await this.options.tokenProvider(true).catch(() => ({}))
        if (Object.keys(refreshed).length > 0) return this.getSse(controller, true, refreshed)
      }
      throw new McpHttpAuthRequiredError("MCP server requires authentication", metadataUrl)
    }
    return response
  }

  private async readSseResponse(
    response: Response,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const cancel = () => void reader.cancel().catch(() => undefined)
    signal?.addEventListener("abort", cancel, { once: true })
    this.readers.add(reader)
    const decoder = new TextDecoder()
    let buffer = ""
    let keepTrackedForClose = false
    try {
      while (!signal?.aborted) {
        const read = await reader.read()
        if (read.done) return undefined
        buffer += decoder.decode(read.value, { stream: true })
        const events = buffer.split("\n\n")
        buffer = events.pop() ?? ""
        for (const event of events) {
          for (const line of event.split("\n")) {
            if (!line.startsWith("data: ")) continue
            try {
              const message = JSON.parse(line.slice(6)) as Record<string, unknown>
              if ("result" in message || "error" in message) {
                keepTrackedForClose = true
                return message
              }
              for (const cb of this.messageCallbacks) cb(message)
            } catch {
              // Non-JSON SSE data is ignored.
            }
          }
        }
      }
      throw new Error("MCP request cancelled")
    } finally {
      signal?.removeEventListener("abort", cancel)
      if (!keepTrackedForClose) this.readers.delete(reader)
    }
  }

  private captureSession(response: Response): void {
    const next = response.headers.get("Mcp-Session-Id")
    if (next) this.sessionId = next
  }

  private postUrl(): string {
    if (this.options.transport !== "sse") return this.options.url
    if (this.options.url.endsWith("/sse")) return this.options.url.slice(0, -4) || this.options.url
    return this.options.url
  }

  private sseUrl(): string {
    if (this.options.url.endsWith("/sse")) return this.options.url
    return `${this.options.url.replace(/\/$/, "")}/sse`
  }
}

async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const read = await reader.read()
    if (read.done) return
    buffer += decoder.decode(read.value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          onMessage(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // Broken servers can write logs to stdout; ignore malformed frames
        }
      }
      newline = buffer.indexOf("\n")
    }
  }
}

function extractResourceMetadata(authHeader: string | null): string | undefined {
  if (!authHeader) return undefined
  const match = authHeader.match(/resource_metadata="([^"]+)"/)
  return match ? match[1] : undefined
}
