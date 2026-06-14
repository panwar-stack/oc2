import type { z } from "zod"

import type { RuntimeErrorShape } from "../events/events"
import type { ModelToolDefinition } from "../model/provider"
import type { WorkspaceRoot } from "../persistence/repositories/sessions"

export type ToolPermissionDecision = "allow" | "deny" | "ask"

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly sessionId?: string
}

export interface ToolPermissionRequest {
  readonly toolName: string
  readonly action: string
  readonly resource: string
  readonly callId?: string
  readonly sessionId?: string
}

export interface ToolContext {
  readonly callId: string
  readonly sessionId?: string
  readonly signal: AbortSignal
  readonly workspaceRoots: readonly WorkspaceRoot[]
  readonly cwd?: string
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly resolveQuestion?: (input: unknown, signal: AbortSignal) => Promise<unknown>
  readonly updateTodos?: (input: unknown, signal: AbortSignal) => Promise<unknown>
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<TInput>
  readonly modelInputSchema: Record<string, unknown>
  readonly permission?: {
    readonly action: string
    resource(input: TInput, context: ToolContext): string
  }
  readonly timeoutMs?: number
  execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput
}

export interface ToolSuccessResult {
  readonly ok: true
  readonly callId: string
  readonly toolName: string
  readonly output: unknown
  readonly outputText: string
  readonly truncated: boolean
  readonly taskId?: string
}

export interface ToolErrorShape {
  readonly name: "ToolExecutionError"
  readonly code: string
  readonly message: string
  readonly recoverable: boolean
  readonly details?: Record<string, unknown>
  readonly runtimeError?: RuntimeErrorShape
}

export interface ToolErrorResult {
  readonly ok: false
  readonly callId: string
  readonly toolName: string
  readonly error: ToolErrorShape
  readonly taskId?: string
}

export type ToolExecutionResult = ToolSuccessResult | ToolErrorResult

/** Error type tools throw for expected, serializable execution failures. */
export class ToolExecutionError extends Error implements ToolErrorShape {
  override readonly name = "ToolExecutionError"
  readonly code: string
  readonly recoverable: boolean
  readonly details?: Record<string, unknown>

  constructor(input: {
    readonly code: string
    readonly message: string
    readonly recoverable?: boolean
    readonly details?: Record<string, unknown>
  }) {
    super(input.message)
    this.code = input.code
    this.recoverable = input.recoverable ?? true
    this.details = input.details
  }

  toJSON(): ToolErrorShape {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
    }
  }
}

/** Converts a thrown or pre-shaped tool error into the uniform execution result. */
export const toolError = (
  call: Pick<ToolCall, "id" | "name">,
  error: ToolExecutionError | ToolErrorShape,
  taskId?: string,
): ToolErrorResult => ({
  ok: false,
  callId: call.id,
  toolName: call.name,
  error: error instanceof ToolExecutionError ? error.toJSON() : error,
  taskId,
})

/** Projects an internal tool definition into the schema shape sent to model providers. */
export const toModelToolDefinition = (tool: ToolDefinition): ModelToolDefinition => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.modelInputSchema,
})
