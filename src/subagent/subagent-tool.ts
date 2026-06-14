import { z } from "zod"

import { RuntimeError } from "../events/events"
import { ToolExecutionError, type ToolDefinition, type ToolContext } from "../tools/tool"
import type { SubAgentService } from "./subagent-service"

export const createSubAgentInputSchema = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().optional(),
  context: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  background: z.boolean().optional(),
})

export type CreateSubAgentToolInput = z.infer<typeof createSubAgentInputSchema>

export interface SubAgentToolOptions {
  readonly service: SubAgentService
}

export interface SubAgentToolOutput {
  readonly taskId?: string
  readonly childSessionId: string
  readonly status: string
  readonly summary: string
  readonly error?: unknown
}

/** Materializes the subagent runtime as a normal tool for model-driven delegation. */
export function createSubAgentTool(
  options: SubAgentToolOptions,
): ToolDefinition<CreateSubAgentToolInput, SubAgentToolOutput> {
  return {
    name: "subagent",
    description: "Create a child subagent session for an isolated task and return its structured result.",
    inputSchema: createSubAgentInputSchema,
    modelInputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        prompt: { type: "string" },
        description: { type: "string" },
        context: { type: "string" },
        timeoutMs: { type: "number" },
        background: { type: "boolean" },
      },
      required: ["agentId", "prompt"],
    },
    permission: {
      action: "subagent.create",
      resource(input: CreateSubAgentToolInput) {
        return input.agentId
      },
    },
    async execute(input: CreateSubAgentToolInput, context: ToolContext): Promise<SubAgentToolOutput> {
      if (!context.sessionId) {
        throw new ToolExecutionError({ code: "missing_session", message: "Subagent tool requires a parent session" })
      }
      const result = await options.service
        .run({ ...input, parentSessionId: context.sessionId, signal: context.signal })
        .catch((error) => {
          if (error instanceof RuntimeError) {
            throw new ToolExecutionError({
              code: "subagent_failed",
              message: error.message,
              details: { output: { status: "failed", summary: "", error: error.toJSON() } },
              runtimeError: error.toJSON(),
            })
          }
          throw error
        })
      const output: SubAgentToolOutput = {
        taskId: result.taskId,
        childSessionId: result.sessionId,
        status: result.status,
        summary: result.text,
        error: result.errors[0],
      }
      if (result.status === "failed" || result.errors.length > 0) {
        const runtimeError = result.errors[0]
        throw new ToolExecutionError({
          code: "subagent_failed",
          message: runtimeError?.message ?? "Subagent failed",
          details: { output },
          runtimeError,
        })
      }
      return output
    },
  }
}
