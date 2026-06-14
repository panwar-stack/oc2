import type { Oc2Config } from "../config/schema"
import type { ModelToolDefinition } from "../model/provider"
import {
  toModelToolDefinition,
  ToolExecutionError,
  toolError,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionResult,
} from "./tool"

const toolNamePattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/

export interface ToolRegistry {
  register(tool: ToolDefinition): void
  unregister(name: string): boolean
  get(name: string): ToolDefinition | undefined
  list(config?: Pick<Oc2Config, "tools">): readonly ToolDefinition[]
  materialize(config?: Pick<Oc2Config, "tools">): readonly ModelToolDefinition[]
  unknown(call: ToolCall): ToolExecutionResult
}

/** Creates a mutable registry that validates tool names and filters disabled tools at read time. */
export const createToolRegistry = (tools: readonly ToolDefinition[] = []): ToolRegistry => {
  const registry = new Map<string, ToolDefinition>()
  const api: ToolRegistry = {
    register(tool) {
      if (!toolNamePattern.test(tool.name)) {
        throw new ToolExecutionError({ code: "invalid_tool_name", message: `Invalid tool name: ${tool.name}` })
      }
      registry.set(tool.name, tool)
    },
    unregister(name) {
      return registry.delete(name)
    },
    get(name) {
      return registry.get(name)
    },
    list(config) {
      return [...registry.values()].filter((tool) => config?.tools[tool.name]?.enabled !== false)
    },
    materialize(config) {
      return api.list(config).map(toModelToolDefinition)
    },
    unknown(call) {
      return toolError(
        call,
        new ToolExecutionError({
          code: "unknown_tool",
          message: `Unknown tool: ${call.name}`,
          details: { toolName: call.name },
        }),
      )
    },
  }

  for (const tool of tools) api.register(tool)
  return api
}
