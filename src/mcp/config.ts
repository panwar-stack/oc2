import type { Oc2Config } from "../config/schema"

export type McpServerConfig = Oc2Config["mcp"][string]

export interface ResolvedMcpServerConfig extends McpServerConfig {
  readonly id: string
  readonly tokenProvider?: () => Promise<Record<string, string>>
}

/** Projects the configured MCP record into stable server entries with canonical ids. */
export function listMcpServers(config: Pick<Oc2Config, "mcp">): ResolvedMcpServerConfig[] {
  return Object.entries(config.mcp)
    .map(([id, server]) => ({ ...server, id: server.id ?? id }))
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

/** Creates an oc2-safe tool name for a discovered MCP tool. */
export function createMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${sanitizeName(serverId)}_${sanitizeName(toolName)}`
}

function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[^a-zA-Z]+/, "")
  return sanitized || "server"
}
