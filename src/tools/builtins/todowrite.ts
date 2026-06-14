import { z } from "zod"

import type { ToolDefinition } from "../tool"
import { objectSchema } from "./schema"

const todoSchema = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]),
})

const inputSchema = z.object({ todos: z.array(todoSchema) })

export const createTodoWriteTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "todowrite",
  description: "Record the current structured todo list.",
  inputSchema,
  modelInputSchema: objectSchema({ todos: { type: "array", items: { type: "object" } } }, ["todos"]),
  permission: { action: "todowrite", resource: () => "todos" },
  async execute(input, context) {
    const result = context.updateTodos ? await context.updateTodos(input, context.signal) : undefined
    return { todos: input.todos, updated: true, result }
  },
})
