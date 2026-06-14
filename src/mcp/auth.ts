import type { ResolvedMcpServerConfig } from "./config"

/** Detects MCP servers that need OAuth but cannot be completed by the first PR10 runtime. */
export function requiresDeferredOAuth(server: ResolvedMcpServerConfig): boolean {
  return server.oauth?.enabled === true
}
