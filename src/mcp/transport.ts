export interface McpTransport {
  start(): Promise<void>
  send(message: Record<string, unknown>): Promise<void>
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
}

export class HttpTransport implements McpTransport {
  private messageCallbacks: Array<(message: Record<string, unknown>) => void> = []
  private errorCallbacks: Array<(error: Error) => void> = []
  private closeCallbacks: Array<() => void> = []
  private events?: {
    addEventListener(type: string, listener: (event: { data: string }) => void): void
    close(): void
  }

  constructor(private readonly options: HttpTransportOptions) {}

  async start(): Promise<void> {
    if (this.options.transport === "sse") {
      this.setupSse()
    }
  }

  private setupSse(): void {
    const EventSourceCtor = (
      globalThis as unknown as {
        EventSource?: new (url: string) => {
          addEventListener(type: string, listener: (event: { data: string }) => void): void
          close(): void
        }
      }
    ).EventSource
    if (!EventSourceCtor) return

    this.events = new EventSourceCtor(this.options.url)
    this.events.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>
        for (const cb of this.messageCallbacks) {
          cb(message)
        }
      } catch {
        // Non-JSON SSE messages are ignored
      }
    })
    this.events.addEventListener("error", () => {
      for (const cb of this.errorCallbacks) {
        cb(new Error("SSE connection error"))
      }
    })
  }

  async send(message: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.headers,
    }
    const response = await fetch(this.options.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    })
    if (response.status === 401 || response.status === 403) {
      const authHeader = response.headers.get("www-authenticate")
      const metadataUrl = extractResourceMetadata(authHeader)
      if (metadataUrl) {
        throw new Error(`MCP server requires authentication (metadata: ${metadataUrl})`)
      }
      throw new Error("MCP server requires authentication")
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
    this.events?.close()
    this.events = undefined
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
