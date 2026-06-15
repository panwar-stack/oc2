import type { RuntimeErrorShape } from "../events/events"

export type McpServerStatusName = "disabled" | "starting" | "connected" | "failed" | "auth_required"
export type McpAuthStateName = "auth_required" | "callback_pending" | "authenticated" | "refresh_failed"

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
  readonly resourceCount?: number
  readonly promptCount?: number
  readonly authUrl?: string
  readonly authState?: McpAuthStateName
  readonly error?: RuntimeErrorShape
}

export function createMcpStatus(serverId: string, status: McpServerStatusName): McpServerStatus {
  return { serverId, status, toolCount: 0, tools: [] }
}
