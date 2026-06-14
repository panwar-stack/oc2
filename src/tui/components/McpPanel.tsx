import { ToolCallView } from "./ToolCallView"
import type { TuiState } from "../state"

export function McpPanel({ state }: { readonly state: TuiState }): string {
  const servers = state.mcpServers.length
    ? state.mcpServers.map((server) => {
        const auth = server.authRequired ? " auth_required" : ""
        const error = server.error ? ` error=${server.error}` : ""
        return `- ${server.serverId}: ${server.status}${auth} tools=${server.toolCount ?? server.tools.length}${error}`
      })
    : ["- No MCP servers reported."]
  const mcpCalls = state.toolCalls.filter((call) => call.name.startsWith("mcp_"))
  const calls = mcpCalls.length
    ? mcpCalls.map((call) => `- ${ToolCallView({ call })}`)
    : ["- No active MCP tool calls."]
  return ["MCP servers:", ...servers, "Active MCP tool calls:", ...calls].join("\n")
}
