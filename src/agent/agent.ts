import { RuntimeError, type RuntimeErrorShape } from "../events/events"
import type { ModelService } from "../model/model-service"
import type { RepositoryMemoryRepository } from "../persistence/repositories/memory"
import type { ModelTokenUsage, ModelToolCall } from "../model/provider"
import type { SessionRecord } from "../persistence/repositories/sessions"
import type { SessionService } from "../session/session-service"
import { buildAgentModelContext } from "../session/context"
import { createTextPart, type MessagePart, type SessionMessage, type TokenUsage } from "../session/message"
import type { ToolExecutor } from "../tools/execution"
import type { ToolContext } from "../tools/tool"
import type { ToolRegistry } from "../tools/registry"
import type { Oc2Config } from "../config/schema"
import type { AgentProfile } from "./profiles"

export interface MainAgentRunInput {
  readonly session: SessionRecord
  readonly profile: AgentProfile
  readonly prompt: string
  readonly config: Oc2Config
  readonly signal: AbortSignal
  readonly resolveQuestion?: ToolContext["resolveQuestion"]
}

export interface AgentRunToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
  readonly ok: boolean
}

export interface MainAgentRunResult {
  readonly sessionId: string
  readonly text: string
  readonly toolCalls: readonly AgentRunToolCall[]
  readonly errors: readonly RuntimeErrorShape[]
  readonly usage?: TokenUsage
  readonly status: "completed" | "failed"
}

export interface MainAgentOptions {
  readonly sessions: SessionService
  readonly models: ModelService
  readonly registry: ToolRegistry
  readonly tools: ToolExecutor
  readonly memory?: RepositoryMemoryRepository
}

/** Runs the main model/tool loop while persisting assistant and tool messages. */
export class MainAgent {
  constructor(private readonly options: MainAgentOptions) {}

  async run(input: MainAgentRunInput): Promise<MainAgentRunResult> {
    const now = createRunClock()
    const userMessage = this.options.sessions.appendMessage({
      sessionId: input.session.id,
      role: "user",
      parts: [createTextPart(input.prompt)],
      status: "completed",
      now: now(),
    })
    let parentMessageId: string | undefined = userMessage.id
    let finalText = ""
    let usage: TokenUsage | undefined
    const errors: RuntimeErrorShape[] = []
    const toolCalls: AgentRunToolCall[] = []

    for (let iteration = 0; iteration < input.profile.maxIterations; iteration += 1) {
      const transcript = this.options.sessions.messages.listBySession(input.session.id)
      const context = buildAgentModelContext({
        session: input.session,
        messages: transcript,
        profile: input.profile,
        registry: this.options.registry,
        config: input.config,
      })
      let assistant: SessionMessage | undefined
      try {
        const collected = await this.options.models.collect(input.session.providerId, {
          sessionId: input.session.id,
          modelId: input.session.modelId,
          messages: context.messages,
          tools: context.tools,
          signal: input.signal,
          providerOptions: { timeoutMs: input.profile.timeoutMs ?? input.config.runtime.defaultTimeoutMs },
        })
        const parts = collectedToParts(collected.text, collected.reasoning, collected.toolCalls)
        usage = mergeUsage(usage, collected.usage)
        assistant = this.options.sessions.appendMessage({
          sessionId: input.session.id,
          role: "assistant",
          parentMessageId,
          parts,
          status: "completed",
          modelId: input.session.modelId,
          usage,
          now: now(),
        })
        parentMessageId = assistant.id
        finalText = collected.text || finalText

        if (collected.toolCalls.length === 0) {
          return { sessionId: input.session.id, text: finalText, toolCalls, errors, usage, status: "completed" }
        }

        for (const call of collected.toolCalls) {
          this.options.sessions.toolCalls.upsert({
            id: call.id,
            sessionId: input.session.id,
            messageId: assistant.id,
            name: call.name,
            input: call.arguments,
            status: "running",
            startedAt: new Date().toISOString(),
          })
          const result = await this.options.tools.execute(
            { id: call.id, name: call.name, arguments: call.arguments, sessionId: input.session.id },
            {
              workspaceRoots: input.session.workspaceRoots,
              cwd: input.session.workspaceRoots[0]?.path,
              signal: input.signal,
              sessionId: input.session.id,
              memory: this.options.memory,
              resolveQuestion: input.resolveQuestion,
            },
          )
          toolCalls.push({ id: call.id, name: call.name, input: call.arguments, ok: result.ok })
          const error = result.ok
            ? undefined
            : (result.error.runtimeError ??
              new RuntimeError({
                code: "task_failed",
                message: result.error.message,
                recoverable: result.error.recoverable,
                kind: "tool",
              }).toJSON())
          if (error) errors.push(error)
          this.options.sessions.toolCalls.upsert({
            id: call.id,
            sessionId: input.session.id,
            messageId: assistant.id,
            name: call.name,
            input: call.arguments,
            status: result.ok ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            result: result.ok ? result.output : undefined,
            error,
          })
          const toolMessage = this.options.sessions.appendMessage({
            sessionId: input.session.id,
            role: "tool",
            parentMessageId: assistant.id,
            parts: [
              {
                type: "tool-result",
                result: { toolCallId: call.id, output: result.ok ? result.output : undefined, error },
              },
            ],
            status: result.ok ? "completed" : "failed",
            now: now(),
          })
          parentMessageId = toolMessage.id
        }
      } catch (cause) {
        const error = toRuntimeErrorShape(cause)
        errors.push(error)
        this.options.sessions.appendMessage({
          sessionId: input.session.id,
          role: "assistant",
          parentMessageId,
          parts: [createTextPart(error.message)],
          status: "failed",
          modelId: input.session.modelId,
          error,
          now: now(),
        })
        return { sessionId: input.session.id, text: finalText, toolCalls, errors, usage, status: "failed" }
      }
    }

    const error = new RuntimeError({
      code: "task_failed",
      message: "Agent reached the maximum model/tool iterations",
      recoverable: true,
      kind: "model",
    }).toJSON()
    errors.push(error)
    return { sessionId: input.session.id, text: finalText, toolCalls, errors, usage, status: "failed" }
  }
}

function createRunClock(): () => string {
  const started = Date.now()
  let offset = 0
  return () => new Date(started + offset++).toISOString()
}

function collectedToParts(text: string, reasoning: string, calls: readonly ModelToolCall[]): readonly MessagePart[] {
  const parts: MessagePart[] = []
  if (reasoning) parts.push({ type: "reasoning", text: reasoning })
  if (text) parts.push(createTextPart(text))
  for (const call of calls) {
    parts.push({
      type: "tool-call",
      toolCall: { id: call.id, name: call.name, input: call.arguments, status: "completed" },
    })
  }
  return parts.length > 0 ? parts : [createTextPart("")]
}

function mergeUsage(existing: TokenUsage | undefined, next: ModelTokenUsage | undefined): TokenUsage | undefined {
  if (!next) return existing
  const inputTokens = (existing?.inputTokens ?? 0) + next.inputTokens
  const outputTokens = (existing?.outputTokens ?? 0) + next.outputTokens
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function toRuntimeErrorShape(error: unknown): RuntimeErrorShape {
  if (error instanceof RuntimeError) return error.toJSON()
  if (error && typeof error === "object" && "toJSON" in error && typeof error.toJSON === "function") {
    const json = error.toJSON() as { message?: string; classification?: string; retryable?: boolean }
    return new RuntimeError({
      code: json.classification === "cancelled" ? "cancelled" : "task_failed",
      message: json.message ?? "Model request failed",
      recoverable: json.retryable ?? false,
      details: { ...json },
      kind: "model",
    }).toJSON()
  }
  return new RuntimeError({
    code: "task_failed",
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
    kind: "model",
  }).toJSON()
}
