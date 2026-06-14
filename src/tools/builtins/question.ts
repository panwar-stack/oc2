import { z } from "zod"

import type { ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const optionSchema = z.object({ label: z.string().min(1), description: z.string().optional() })
const inputSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(optionSchema).default([]),
  multiple: z.boolean().optional(),
})

/** Creates the built-in question tool backed by the host application's user prompt resolver. */
export const createQuestionTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "question",
  description: "Ask the user a structured question through an injected resolver.",
  inputSchema,
  modelInputSchema: objectSchema({ question: stringProperty("Question to ask"), header: stringProperty("Short heading"), options: { type: "array", items: { type: "object" } } }, ["question"]),
  permission: { action: "question", resource: () => "user" },
  async execute(input, context) {
    const answer = context.resolveQuestion ? await context.resolveQuestion(input, context.signal) : undefined
    return { question: input.question, answer: answer ?? null }
  },
})
