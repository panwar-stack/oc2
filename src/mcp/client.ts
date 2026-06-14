import type { ResolvedMcpServerConfig } from "./config"
import type { McpToolInfo } from "./status"
import { redactText } from "../logging/redaction"
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
import { StdioTransport, HttpTransport, McpHttpAuthRequiredError, type McpTransport } from "./transport"

export interface McpCallResult {
  readonly content?: unknown
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

export interface McpHostHandlers {
  rootsList?(signal: AbortSignal): Promise<readonly { uri: string; name?: string }[]>
  samplingCreateMessage?(
    serverId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>
  elicitationCreate?(
    serverId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>
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

export class McpJsonRpcError extends Error {
  readonly code: number
  readonly data?: unknown
  readonly isMcpError = true

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "McpJsonRpcError"
    this.code = code
    this.data = data
  }
}

export class McpAuthRequiredError extends Error {
  override readonly name = "McpAuthRequiredError"
  readonly metadataUrl?: string

  constructor(message: string, metadataUrl?: string) {
    super(message)
    this.metadataUrl = metadataUrl
  }
}

export function redactMcpError(error: McpJsonRpcError): string {
  return `MCP error ${error.code}: ${redactText(error.message)}`
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

  const transport: McpTransport = new HttpTransport({
    url: endpoint,
    headers: server.headers,
    transport: server.transport as "http" | "sse",
    tokenProvider: server.tokenProvider,
  })
  const httpTransport = transport as HttpTransport
  const inFlight = new Set<number>()

  void transport.start()

  transport.onMessage((message) => {
    const method = message.method as string | undefined
    if (method === LIST_CHANGED_METHODS.tools) changed.get("tools")?.()
    if (method === LIST_CHANGED_METHODS.resources) changed.get("resources")?.()
    if (method === LIST_CHANGED_METHODS.prompts) changed.get("prompts")?.()
    if (method === LIST_CHANGED_METHODS.roots) changed.get("roots")?.()
  })

  const request = async (method: string, params: Record<string, unknown> | undefined, signal: AbortSignal) => {
    if (signal.aborted) throw new Error("MCP request cancelled")
    const requestId = ++id
    const onAbort = () => {
      if (inFlight.has(requestId)) {
        transport
          .send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "Cancelled" },
          })
          .catch(() => undefined)
      }
    }
    signal.addEventListener("abort", onAbort, { once: true })
    inFlight.add(requestId)

    try {
      const response = await httpTransport.request(
        { jsonrpc: "2.0", id: requestId, method, params },
        signal,
      )
      if (!response) throw new Error("MCP HTTP response did not include a JSON-RPC body")
      return unwrapResponse(response as JsonRpcResponse)
    } catch (error) {
      if (error instanceof McpHttpAuthRequiredError) {
        throw new McpAuthRequiredError(error.message, error.metadataUrl)
      }
      if (signal.aborted) throw new Error("MCP request cancelled")
      throw error
    } finally {
      inFlight.delete(requestId)
      signal.removeEventListener("abort", onAbort)
    }
  }

  return {
    async initialize(input, signal) {
      const result = normalizeInitializeResult(
        await request("initialize", {
          protocolVersion: input.protocolVersion,
          capabilities: input.capabilities,
          clientInfo: input.clientInfo,
        }, signal),
      )
      await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined)
      return result
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
      const cancellations = [...inFlight].map((requestId) =>
        transport
          .send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "Client closed" },
          })
          .catch(() => undefined),
      )
      await Promise.race([Promise.all(cancellations), Bun.sleep(250)]).catch(() => undefined)
      inFlight.clear()
      await transport.close()
      changed.clear()
    },
    setHostHandlers(_handlers: McpHostHandlers) {},
  }
}

function createStdioClient(server: ResolvedMcpServerConfig): McpClient {
  const transport = new StdioTransport({
    command: server.command ?? "",
    args: server.args,
    cwd: server.cwd,
    env: server.env,
  })

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const hostRequests = new Map<string | number, AbortController>()
  const changed = new Map<ListChangedKind, () => void>()
  let hostHandlers: McpHostHandlers = {}
  let id = 0

  const handleServerRequest = (message: Record<string, unknown>) => {
    const requestId = message.id as string | number | undefined
    if (requestId === undefined) return
    const method = message.method as string | undefined
    const params = (message.params as Record<string, unknown>) ?? {}

    if (method === "roots/list") {
      const handler = hostHandlers.rootsList
      if (!handler) {
        transport.send({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32601, message: "roots/list not supported" },
        })
        return
      }
      const controller = new AbortController()
      hostRequests.set(requestId, controller)
      void handler(controller.signal).then(
        (roots) => {
          hostRequests.delete(requestId)
          const resultRoots = roots.map((r) => {
            const uri = r.uri.includes("://") ? r.uri : `file://${r.uri}`
            return { uri, name: r.name }
          })
          transport.send({ jsonrpc: "2.0", id: requestId, result: { roots: resultRoots } })
        },
        (err) => {
          hostRequests.delete(requestId)
          transport.send({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32603,
              message: redactText(err instanceof Error ? err.message : String(err)),
            },
          })
        },
      )
      return
    }

    if (method === "sampling/createMessage") {
      const handler = hostHandlers.samplingCreateMessage
      if (!handler) {
        transport.send({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32601, message: "sampling/createMessage not supported" },
        })
        return
      }
      const controller = new AbortController()
      hostRequests.set(requestId, controller)
      void handler(server.id, params, controller.signal).then(
        (result) => {
          hostRequests.delete(requestId)
          transport.send({ jsonrpc: "2.0", id: requestId, result })
        },
        (err) => {
          hostRequests.delete(requestId)
          transport.send({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32603,
              message: redactText(err instanceof Error ? err.message : String(err)),
            },
          })
        },
      )
      return
    }

    if (method === "elicitation/create") {
      const handler = hostHandlers.elicitationCreate
      if (!handler) {
        transport.send({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32601, message: "elicitation/create not supported" },
        })
        return
      }
      const controller = new AbortController()
      hostRequests.set(requestId, controller)
      void handler(server.id, params, controller.signal).then(
        (result) => {
          hostRequests.delete(requestId)
          transport.send({ jsonrpc: "2.0", id: requestId, result })
        },
        (err) => {
          hostRequests.delete(requestId)
          transport.send({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32603,
              message: redactText(err instanceof Error ? err.message : String(err)),
            },
          })
        },
      )
      return
    }

    transport.send({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32601, message: "Method not found" },
    })
  }

  transport.onMessage((message) => {
    const method = message.method as string | undefined
    if (method === LIST_CHANGED_METHODS.tools) {
      changed.get("tools")?.()
      return
    }
    if (method === LIST_CHANGED_METHODS.resources) {
      changed.get("resources")?.()
      return
    }
    if (method === LIST_CHANGED_METHODS.prompts) {
      changed.get("prompts")?.()
      return
    }
    if (method === LIST_CHANGED_METHODS.roots) {
      changed.get("roots")?.()
      return
    }
    if (method === "notifications/cancelled") {
      const params = (message.params as Record<string, unknown> | undefined) ?? {}
      const requestId = params.requestId as string | number | undefined
      if (requestId !== undefined) {
        hostRequests.get(requestId)?.abort(new Error(String(params.reason ?? "MCP request cancelled")))
        hostRequests.delete(requestId)
      }
      return
    }
    if (message.id === undefined) return
    const key = Number(message.id)
    const waiter = pending.get(key)
    if (!waiter) {
      handleServerRequest(message)
      return
    }
    pending.delete(key)
    try {
      waiter.resolve(unwrapResponse(message as unknown as JsonRpcResponse))
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  transport.onError((error) => {
    rejectPending(pending, error)
  })

  void transport.start()

  const request = async (method: string, params: Record<string, unknown> | undefined, signal: AbortSignal) => {
    if (signal.aborted) throw new Error("MCP request cancelled")
    const requestId = ++id
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      signal.addEventListener(
        "abort",
        () => {
          if (pending.delete(requestId)) {
            transport
              .send({
                jsonrpc: "2.0",
                method: "notifications/cancelled",
                params: { requestId, reason: "Cancelled" },
              })
              .catch(() => undefined)
          }
          reject(new Error("MCP request cancelled"))
        },
        { once: true },
      )
    })
    transport.send({ jsonrpc: "2.0", id: requestId, method, params })
    return result
  }

  return {
    async initialize(input, signal) {
      const result = await request(
        "initialize",
        { protocolVersion: input.protocolVersion, capabilities: input.capabilities, clientInfo: input.clientInfo },
        signal,
      )
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
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
      for (const controller of hostRequests.values()) controller.abort(new Error("MCP client closed"))
      hostRequests.clear()
      for (const [requestId, waiter] of pending) {
        pending.delete(requestId)
        transport
          .send({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "Client closed" },
          })
          .catch(() => undefined)
        waiter.reject(new Error("MCP client closed"))
      }
      await transport.close()
      changed.clear()
    },
    setHostHandlers(handlers: McpHostHandlers) {
      hostHandlers = handlers
    },
  }
}

export async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: JsonRpcResponse) => void,
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
  if (response.error) {
    throw new McpJsonRpcError(response.error.code ?? -32603, response.error.message ?? "MCP error", response.error.data)
  }
  if (!("result" in response)) throw new Error("Invalid JSON-RPC response: missing result")
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
