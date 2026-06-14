import type { ResolvedMcpServerConfig } from "./config"
import type { McpToolInfo } from "./status"

export interface McpCallResult {
  readonly content?: unknown
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface McpClient {
  initialize(signal: AbortSignal): Promise<void>
  listTools(signal: AbortSignal): Promise<readonly McpToolInfo[]>
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>
  onToolsChanged(callback: () => void): void
  close(): Promise<void>
}

export type McpClientFactory = (server: ResolvedMcpServerConfig) => Promise<McpClient> | McpClient

export class McpAuthRequiredError extends Error {
  override readonly name = "McpAuthRequiredError"
}

interface JsonRpcResponse {
  readonly id?: string | number
  readonly result?: unknown
  readonly error?: { readonly message?: string; readonly code?: number; readonly data?: unknown }
  readonly method?: string
}

/** Creates the default JSON-RPC MCP client for stdio and HTTP-style transports. */
export const createMcpClient: McpClientFactory = (server) => {
  if (server.transport === "stdio") return createStdioClient(server)
  return createHttpClient(server)
}

function createHttpClient(server: ResolvedMcpServerConfig): McpClient {
  let id = 0
  const endpoint = server.url ?? ""
  let events:
    | { addEventListener(type: string, listener: (event: { data: string }) => void): void; close(): void }
    | undefined

  const request = async (method: string, params: Record<string, unknown> | undefined, signal: AbortSignal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...server.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal,
    })
    if (response.status === 401 || response.status === 403)
      throw new McpAuthRequiredError("MCP server requires authentication")
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
    return unwrapResponse((await response.json()) as JsonRpcResponse)
  }

  return {
    async initialize(signal) {
      await request(
        "initialize",
        { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "oc2" } },
        signal,
      )
    },
    async listTools(signal) {
      return normalizeTools(await request("tools/list", undefined, signal))
    },
    async callTool(name, input, signal) {
      return normalizeCallResult(await request("tools/call", { name, arguments: input }, signal))
    },
    onToolsChanged(callback) {
      if (server.transport !== "sse") return
      events?.close()
      const EventSourceCtor = (
        globalThis as unknown as {
          EventSource?: new (url: string) => {
            addEventListener(type: string, listener: (event: { data: string }) => void): void
            close(): void
          }
        }
      ).EventSource
      if (!EventSourceCtor) return
      events = new EventSourceCtor(endpoint)
      events.addEventListener("message", (event) => {
        if (isToolListChangedNotification(event.data)) callback()
      })
    },
    async close() {
      events?.close()
    },
  }
}

function createStdioClient(server: ResolvedMcpServerConfig): McpClient {
  const process = Bun.spawn({
    cmd: [server.command ?? "", ...server.args],
    cwd: server.cwd,
    env: { ...Bun.env, ...server.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let id = 0
  let changed: (() => void) | undefined

  void readJsonLines(process.stdout, (message) => {
    if (message.method === "notifications/tools/list_changed") {
      changed?.()
      return
    }
    if (message.id === undefined) return
    const key = Number(message.id)
    const waiter = pending.get(key)
    if (!waiter) return
    pending.delete(key)
    try {
      waiter.resolve(unwrapResponse(message))
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }).catch((error) => rejectPending(pending, error instanceof Error ? error : new Error(String(error))))

  const request = async (method: string, params: Record<string, unknown> | undefined, signal: AbortSignal) => {
    const requestId = ++id
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      signal.addEventListener(
        "abort",
        () => {
          pending.delete(requestId)
          reject(new Error("MCP request cancelled"))
        },
        { once: true },
      )
    })
    process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`)
    return result
  }

  return {
    async initialize(signal) {
      await request(
        "initialize",
        { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "oc2" } },
        signal,
      )
      process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    },
    async listTools(signal) {
      return normalizeTools(await request("tools/list", undefined, signal))
    },
    async callTool(name, input, signal) {
      return normalizeCallResult(await request("tools/call", { name, arguments: input }, signal))
    },
    onToolsChanged(callback) {
      changed = callback
    },
    async close() {
      process.stdin.end()
      process.kill()
      await process.exited.catch(() => undefined)
    },
  }
}

async function readJsonLines(stream: ReadableStream<Uint8Array>, onMessage: (message: JsonRpcResponse) => void) {
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
          onMessage(JSON.parse(line) as JsonRpcResponse)
        } catch {
          // Broken servers can write logs to stdout; ignore malformed frames instead of crashing the session.
        }
      }
      newline = buffer.indexOf("\n")
    }
  }
}

function rejectPending(
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>,
  error: Error,
) {
  for (const [id, waiter] of pending) {
    pending.delete(id)
    waiter.reject(error)
  }
}

function isToolListChangedNotification(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { method?: string }
    return parsed.method === "notifications/tools/list_changed"
  } catch {
    return value.includes("notifications/tools/list_changed")
  }
}

function unwrapResponse(response: JsonRpcResponse): unknown {
  if (response.error) throw new Error(response.error.message ?? `MCP error ${response.error.code ?? "unknown"}`)
  return response.result
}

function normalizeTools(value: unknown): readonly McpToolInfo[] {
  const tools = isRecord(value) && Array.isArray(value.tools) ? value.tools : []
  return tools.filter(isRecord).map((tool) => ({
    name: String(tool.name ?? ""),
    description: typeof tool.description === "string" ? tool.description : undefined,
    inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
  }))
}

function normalizeCallResult(value: unknown): McpCallResult {
  if (!isRecord(value)) return { content: value }
  return { content: value.content, structuredContent: value.structuredContent, isError: value.isError === true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
