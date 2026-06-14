import type { ResolvedMcpServerConfig } from "./config"
import type { McpToolInfo } from "./status"
import {
  normalizeInitializeResult,
  type ListChangedKind,
  type McpInitializeInput,
  type McpInitializeResult,
  type McpPromptInfo,
  type McpPromptResult,
  type McpResourceInfo,
  type McpResourceReadResult,
  LIST_CHANGED_METHODS,
} from "./protocol"

export interface McpCallResult {
  readonly content?: unknown
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface McpHostHandlers {
  rootsList?(signal: AbortSignal): Promise<readonly { uri: string; name?: string }[]>
  samplingCreateMessage?(params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
  elicitationCreate?(params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface McpClient {
  initialize(input: McpInitializeInput, signal: AbortSignal): Promise<McpInitializeResult>
  listTools(signal: AbortSignal): Promise<readonly McpToolInfo[]>
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>
  listResources(signal: AbortSignal): Promise<readonly McpResourceInfo[]>
  readResource(uri: string, signal: AbortSignal): Promise<McpResourceReadResult>
  listPrompts(signal: AbortSignal): Promise<readonly McpPromptInfo[]>
  getPrompt(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpPromptResult>
  onListChanged(kind: ListChangedKind, callback: () => void): void
  onToolsChanged(callback: () => void): void
  setHostHandlers(handlers: McpHostHandlers): void
  close(): Promise<void>
}

export type McpClientFactory = (server: ResolvedMcpServerConfig) => Promise<McpClient> | McpClient

export class McpAuthRequiredError extends Error {
  override readonly name = "McpAuthRequiredError"
  readonly metadataUrl?: string

  constructor(message: string, metadataUrl?: string) {
    super(message)
    this.metadataUrl = metadataUrl
  }
}

interface JsonRpcResponse {
  readonly id?: string | number
  readonly result?: unknown
  readonly error?: { readonly message?: string; readonly code?: number; readonly data?: unknown }
  readonly method?: string
}

export const createMcpClient: McpClientFactory = (server) => {
  if (server.transport === "stdio") return createStdioClient(server)
  return createHttpClient(server)
}

function createHttpClient(server: ResolvedMcpServerConfig): McpClient {
  let id = 0
  const endpoint = server.url ?? ""
  const changed = new Map<ListChangedKind, () => void>()
  let events:
    | { addEventListener(type: string, listener: (event: { data: string }) => void): void; close(): void }
    | undefined

  const request = async (method: string, params: Record<string, unknown> | undefined, signal: AbortSignal) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...server.headers }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal,
    })
    if (response.status === 401 || response.status === 403) {
      const authHeader = response.headers.get("www-authenticate")
      const metadataUrl = extractResourceMetadata(authHeader)
      if (metadataUrl) {
        throw new McpAuthRequiredError(`MCP server requires authentication`, metadataUrl)
      }
      throw new McpAuthRequiredError("MCP server requires authentication")
    }
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
    return unwrapResponse((await response.json()) as JsonRpcResponse)
  }

  const setupSse = () => {
    events?.close()
    if (server.transport !== "sse") return
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
      if (isToolListChangedNotification(event.data)) changed.get("tools")?.()
    })
  }

  return {
    async initialize(input, signal) {
      return normalizeInitializeResult(
        await request(
          "initialize",
          { protocolVersion: input.protocolVersion, capabilities: input.capabilities, clientInfo: input.clientInfo },
          signal,
        ),
      )
    },
    async listTools(signal) {
      return normalizeTools(await request("tools/list", undefined, signal))
    },
    async callTool(name, input, signal) {
      return normalizeCallResult(await request("tools/call", { name, arguments: input }, signal))
    },
    async listResources(signal) {
      return normalizeResources(await request("resources/list", undefined, signal))
    },
    async readResource(uri, signal) {
      return normalizeResourceReadResult(await request("resources/read", { uri }, signal))
    },
    async listPrompts(signal) {
      return normalizePrompts(await request("prompts/list", undefined, signal))
    },
    async getPrompt(name, args, signal) {
      return normalizePromptResult(await request("prompts/get", { name, arguments: args }, signal))
    },
    onListChanged(kind, callback) {
      changed.set(kind, callback)
      if (kind === "tools") setupSse()
    },
    onToolsChanged(callback) {
      changed.set("tools", callback)
      setupSse()
    },
    async close() {
      events?.close()
    },
    setHostHandlers(_handlers: McpHostHandlers) {},
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
  const changed = new Map<ListChangedKind, () => void>()
  let hostHandlers: McpHostHandlers = {}
  let id = 0

  const handleServerRequest = (message: JsonRpcResponse, stdin: { write(input: string): void }) => {
    const requestId = message.id
    if (requestId === undefined) return
    const method = message.method
    const params = (message as { params?: Record<string, unknown> }).params ?? {}
    if (method === "roots/list") {
      const handler = hostHandlers.rootsList
      if (!handler) {
        stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "roots/list not supported" } })}\n`,
        )
        return
      }
      void handler(new AbortController().signal).then(
        (roots) => {
          const resultRoots = roots.map((r) => {
            const uri = r.uri.includes("://") ? r.uri : `file://${r.uri}`
            return { uri, name: r.name }
          })
          stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { roots: resultRoots } })}\n`)
        },
        (err) => {
          stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })}\n`,
          )
        },
      )
      return
    }
    if (method === "sampling/createMessage") {
      const handler = hostHandlers.samplingCreateMessage
      if (!handler) {
        stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "sampling/createMessage not supported" } })}\n`,
        )
        return
      }
      void handler(params, new AbortController().signal).then(
        (result) => {
          stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`)
        },
        (err) => {
          stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })}\n`,
          )
        },
      )
      return
    }
    if (method === "elicitation/create") {
      const handler = hostHandlers.elicitationCreate
      if (!handler) {
        stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "elicitation/create not supported" } })}\n`,
        )
        return
      }
      void handler(params, new AbortController().signal).then(
        (result) => {
          stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`)
        },
        (err) => {
          stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })}\n`,
          )
        },
      )
      return
    }
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "Method not found" } })}\n`,
    )
  }

  void readJsonLines(process.stdout, (message) => {
    if (message.method === LIST_CHANGED_METHODS.tools) {
      changed.get("tools")?.()
      return
    }
    if (message.method === LIST_CHANGED_METHODS.resources) {
      changed.get("resources")?.()
      return
    }
    if (message.method === LIST_CHANGED_METHODS.prompts) {
      changed.get("prompts")?.()
      return
    }
    if (message.method === LIST_CHANGED_METHODS.roots) {
      changed.get("roots")?.()
      return
    }
    if (message.id === undefined) return
    const key = Number(message.id)
    const waiter = pending.get(key)
    if (!waiter) {
      handleServerRequest(message, process.stdin)
      return
    }
    pending.delete(key)
    try {
      waiter.resolve(unwrapResponse(message))
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }).catch((error) => rejectPending(pending, error instanceof Error ? error : new Error(String(error))))

  const request = async (method: string, params: Record<string, unknown> | undefined, signal: AbortSignal) => {
    if (signal.aborted) throw new Error("MCP request cancelled")
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
    async initialize(input, signal) {
      const result = await request(
        "initialize",
        { protocolVersion: input.protocolVersion, capabilities: input.capabilities, clientInfo: input.clientInfo },
        signal,
      )
      process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
      return normalizeInitializeResult(result)
    },
    async listTools(signal) {
      return normalizeTools(await request("tools/list", undefined, signal))
    },
    async callTool(name, input, signal) {
      return normalizeCallResult(await request("tools/call", { name, arguments: input }, signal))
    },
    async listResources(signal) {
      return normalizeResources(await request("resources/list", undefined, signal))
    },
    async readResource(uri, signal) {
      return normalizeResourceReadResult(await request("resources/read", { uri }, signal))
    },
    async listPrompts(signal) {
      return normalizePrompts(await request("prompts/list", undefined, signal))
    },
    async getPrompt(name, args, signal) {
      return normalizePromptResult(await request("prompts/get", { name, arguments: args }, signal))
    },
    onListChanged(kind, callback) {
      changed.set(kind, callback)
    },
    onToolsChanged(callback) {
      changed.set("tools", callback)
    },
    async close() {
      process.stdin.end()
      process.kill()
      await process.exited.catch(() => undefined)
    },
    setHostHandlers(handlers: McpHostHandlers) {
      hostHandlers = handlers
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

function normalizeResources(value: unknown): readonly McpResourceInfo[] {
  const resources = isRecord(value) && Array.isArray(value.resources) ? value.resources : []
  return resources.filter(isRecord).map((resource) => ({
    name: String(resource.name ?? ""),
    uri: String(resource.uri ?? ""),
    description: typeof resource.description === "string" ? resource.description : undefined,
    mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
  }))
}

function normalizeResourceReadResult(value: unknown): McpResourceReadResult {
  if (!isRecord(value)) return { contents: [] }
  const contents = Array.isArray(value.contents) ? value.contents : []
  return {
    contents: contents.filter(isRecord).map((c) => ({
      uri: String(c.uri ?? ""),
      mimeType: typeof c.mimeType === "string" ? c.mimeType : undefined,
      text: typeof c.text === "string" ? c.text : undefined,
      blob: typeof c.blob === "string" ? c.blob : undefined,
    })),
  }
}

function normalizePrompts(value: unknown): readonly McpPromptInfo[] {
  const prompts = isRecord(value) && Array.isArray(value.prompts) ? value.prompts : []
  return prompts.filter(isRecord).map((prompt) => ({
    name: String(prompt.name ?? ""),
    description: typeof prompt.description === "string" ? prompt.description : undefined,
    arguments: Array.isArray(prompt.arguments)
      ? (prompt.arguments as Record<string, unknown>[]).filter(isRecord).map((arg) => ({
          name: String(arg.name ?? ""),
          description: typeof arg.description === "string" ? arg.description : undefined,
          required: arg.required === true ? true : undefined,
        }))
      : undefined,
  }))
}

function normalizePromptResult(value: unknown): McpPromptResult {
  if (!isRecord(value)) return { messages: [] }
  return {
    description: typeof value.description === "string" ? value.description : undefined,
    messages: Array.isArray(value.messages)
      ? (value.messages as Record<string, unknown>[]).filter(isRecord).map((m) => ({
          role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
          content: isRecord(m.content)
            ? (m.content as unknown as McpPromptResult["messages"][number]["content"])
            : { type: "text", text: String(m.content ?? "") },
        }))
      : [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractResourceMetadata(authHeader: string | null): string | undefined {
  if (!authHeader) return undefined
  const match = authHeader.match(/resource_metadata="([^"]+)"/)
  return match ? match[1] : undefined
}
