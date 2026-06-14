export const MCP_PROTOCOL_VERSION = "2024-11-05"

export interface McpClientCapabilities {
  readonly roots?: { readonly listChanged: true }
  readonly sampling?: Record<string, never>
  readonly elicitation?: Record<string, never>
}

export interface McpServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean }
  readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean }
  readonly prompts?: { readonly listChanged?: boolean }
  readonly logging?: Record<string, never>
}

export interface McpInitializeInput {
  readonly protocolVersion: string
  readonly capabilities: McpClientCapabilities
  readonly clientInfo: { readonly name: string; readonly version?: string }
}

export interface McpInitializeResult {
  readonly protocolVersion: string
  readonly capabilities: McpServerCapabilities
  readonly serverInfo?: { readonly name: string; readonly version?: string }
  readonly instructions?: string
}

export interface McpResourceInfo {
  readonly name: string
  readonly uri: string
  readonly description?: string
  readonly mimeType?: string
}

export interface McpResourceReadResult {
  readonly contents: readonly McpResourceContent[]
}

export interface McpResourceContent {
  readonly uri: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}

export interface McpPromptInfo {
  readonly name: string
  readonly description?: string
  readonly arguments?: readonly McpPromptArgument[]
}

export interface McpPromptArgument {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

export interface McpPromptResult {
  readonly description?: string
  readonly messages: readonly McpPromptMessage[]
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant"
  readonly content: McpPromptContent
}

export type McpPromptContent = McpTextContent | McpImageContent | McpResourceReference

export interface McpTextContent {
  readonly type: "text"
  readonly text: string
}

export interface McpImageContent {
  readonly type: "image"
  readonly data: string
  readonly mimeType: string
}

export interface McpResourceReference {
  readonly type: "resource"
  readonly resource: { readonly uri: string; readonly text?: string; readonly blob?: string }
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly result: unknown
}

export interface JsonRpcError {
  readonly jsonrpc: "2.0"
  readonly id: number
  readonly error: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | JsonRpcNotification

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export function normalizeInitializeResult(value: unknown): McpInitializeResult {
  if (!isRecord(value)) throw new Error("Invalid initialize result")
  return {
    protocolVersion: String(value.protocolVersion ?? ""),
    capabilities: isRecord(value.capabilities) ? (value.capabilities as McpServerCapabilities) : {},
    serverInfo: isRecord(value.serverInfo)
      ? {
          name: String(value.serverInfo.name ?? ""),
          version: typeof value.serverInfo.version === "string" ? value.serverInfo.version : undefined,
        }
      : undefined,
    instructions: typeof value.instructions === "string" ? value.instructions : undefined,
  }
}

export function normalizeJsonRpcError(error: unknown): Error {
  if (error instanceof Error) return error
  if (isRecord(error) && isRecord(error.error)) {
    const msg = String(error.error.message ?? "MCP error")
    const code = error.error.code as number | undefined
    return new Error(code !== undefined ? `MCP error ${code}: ${msg}` : msg)
  }
  return new Error(String(error))
}

export type ListChangedKind = "tools" | "resources" | "prompts" | "roots"

export const LIST_CHANGED_METHODS: Record<ListChangedKind, string> = {
  tools: "notifications/tools/list_changed",
  resources: "notifications/resources/list_changed",
  prompts: "notifications/prompts/list_changed",
  roots: "notifications/roots/list_changed",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
