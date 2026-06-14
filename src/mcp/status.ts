import type { RuntimeErrorShape } from "../events/events"

export type McpServerStatusName = "disabled" | "starting" | "connected" | "failed" | "auth_required"

export interface McpToolInfo {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  readonly serverId: string
  readonly status: McpServerStatusName
  readonly toolCount: number
  readonly tools: readonly string[]
  readonly error?: RuntimeErrorShape
}

/** Returns an initial status record for an MCP server before any network or process IO occurs. */
export function createMcpStatus(serverId: string, status: McpServerStatusName): McpServerStatus {
  return { serverId, status, toolCount: 0, tools: [] }
}
