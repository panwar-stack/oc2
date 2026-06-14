import { z } from "zod"

import { ToolExecutionError, type ToolDefinition } from "../tools/tool"
import { createMcpToolName } from "./config"
import { McpJsonRpcError, redactMcpError, type McpClient } from "./client"
import type { McpToolInfo } from "./status"

/** Converts discovered MCP tools into normal oc2 tools handled by the existing executor. */
export function materializeMcpTool(input: {
  readonly serverId: string
  readonly tool: McpToolInfo
  readonly client: McpClient
  readonly timeoutMs?: number
}): ToolDefinition<Record<string, unknown>, unknown> {
  const name = createMcpToolName(input.serverId, input.tool.name)
  const schema = ensureObjectSchema(input.tool.inputSchema)
  return {
    name,
    description: input.tool.description ?? `MCP tool ${input.serverId}/${input.tool.name}`,
    inputSchema: z.record(z.string(), z.unknown()),
    modelInputSchema: schema,
    permission: {
      action: "mcp.invoke",
      resource: () => `${input.serverId}/${input.tool.name}`,
    },
    timeoutMs: input.timeoutMs,
    async execute(args, context) {
      let result
      try {
        result = await input.client.callTool(input.tool.name, args, context.signal)
      } catch (error) {
        if (error instanceof McpJsonRpcError) {
          throw new ToolExecutionError({
            code: "mcp_jsonrpc_error",
            message: redactMcpError(error),
          })
        }
        throw error
      }
      if (result.isError) {
        throw new ToolExecutionError({
          code: "mcp_tool_failed",
          message: `MCP tool failed: ${input.serverId}/${input.tool.name}`,
          details: { content: result.content },
        })
      }
      return result.structuredContent ?? result.content ?? result
    },
  }
}

function ensureObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...schema,
    type: "object",
    properties: schema.properties ?? {},
    additionalProperties: schema.additionalProperties ?? true,
  }
}
