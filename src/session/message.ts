import type { RuntimeErrorShape } from "../events/events"

export type RuntimeStatus = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out"

export type MessageRole = "system" | "user" | "assistant" | "tool" | "synthetic"

export interface TokenUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly status: RuntimeStatus
  readonly startedAt?: string
  readonly completedAt?: string
}

export interface ToolResult {
  readonly toolCallId: string
  readonly output?: unknown
  readonly error?: RuntimeErrorShape
  readonly metadata?: Record<string, unknown>
}

export type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string; readonly redacted?: boolean }
  | { readonly type: "tool-call"; readonly toolCall: ToolCall }
  | { readonly type: "tool-result"; readonly result: ToolResult }
  | { readonly type: "file"; readonly path: string; readonly mime?: string; readonly text?: string }
  | { readonly type: "event"; readonly eventId: string }

export interface SessionMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: MessageRole
  readonly createdAt: string
  readonly updatedAt: string
  readonly parts: readonly MessagePart[]
  readonly status: RuntimeStatus
  readonly parentMessageId?: string
  readonly modelId?: string
  readonly usage?: TokenUsage
  readonly error?: RuntimeErrorShape
}

export const createTextPart = (text: string): MessagePart => ({ type: "text", text })
