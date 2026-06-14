import { z } from "zod"

import { type ToolDefinition } from "../tools/tool"
import type { McpClient } from "./client"

export function createResourceListTool(input: {
  readonly serverId: string
  readonly client: McpClient
  readonly timeoutMs?: number
}): ToolDefinition<Record<string, never>, unknown> {
  return {
    name: `mcp_${input.serverId}_resource_list`,
    description: `List resources from MCP server ${input.serverId}`,
    inputSchema: z.object({}),
    modelInputSchema: { type: "object", properties: {} },
    permission: {
      action: "mcp.resource",
      resource: () => `${input.serverId}/*`,
    },
    timeoutMs: input.timeoutMs,
    async execute(_args, context) {
      const resources = await input.client.listResources(context.signal)
      return { serverId: input.serverId, resources }
    },
  }
}

export function createResourceReadTool(input: {
  readonly serverId: string
  readonly client: McpClient
  readonly timeoutMs?: number
}): ToolDefinition<{ uri: string }, unknown> {
  return {
    name: `mcp_${input.serverId}_resource_read`,
    description: `Read a resource from MCP server ${input.serverId}`,
    inputSchema: z.object({ uri: z.string().min(1) }),
    modelInputSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
    permission: {
      action: "mcp.resource",
      resource: (args) => `${input.serverId}/${args.uri}`,
    },
    timeoutMs: input.timeoutMs,
    async execute(args, context) {
      const result = await input.client.readResource(args.uri, context.signal)
      return { serverId: input.serverId, uri: args.uri, contents: result.contents }
    },
  }
}

export function createPromptListTool(input: {
  readonly serverId: string
  readonly client: McpClient
  readonly timeoutMs?: number
}): ToolDefinition<Record<string, never>, unknown> {
  return {
    name: `mcp_${input.serverId}_prompt_list`,
    description: `List prompts from MCP server ${input.serverId}`,
    inputSchema: z.object({}),
    modelInputSchema: { type: "object", properties: {} },
    permission: {
      action: "mcp.prompt",
      resource: () => `${input.serverId}/*`,
    },
    timeoutMs: input.timeoutMs,
    async execute(_args, context) {
      const prompts = await input.client.listPrompts(context.signal)
      return { serverId: input.serverId, prompts }
    },
  }
}

export function createPromptGetTool(input: {
  readonly serverId: string
  readonly client: McpClient
  readonly timeoutMs?: number
}): ToolDefinition<{ name: string; arguments?: Record<string, unknown> }, unknown> {
  return {
    name: `mcp_${input.serverId}_prompt_get`,
    description: `Get a prompt from MCP server ${input.serverId}`,
    inputSchema: z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).optional() }),
    modelInputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["name"],
    },
    permission: {
      action: "mcp.prompt",
      resource: (args) => `${input.serverId}/${args.name}`,
    },
    timeoutMs: input.timeoutMs,
    async execute(args, context) {
      const result = await input.client.getPrompt(args.name, args.arguments ?? {}, context.signal)
      return { serverId: input.serverId, name: args.name, ...result }
    },
  }
}
