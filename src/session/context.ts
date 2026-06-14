import type { AgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import type { ModelMessage, ModelToolDefinition } from "../model/provider"
import type { SessionRecord } from "../persistence/repositories/sessions"
import type { ToolRegistry } from "../tools/registry"
import type { MessagePart, SessionMessage } from "./message"

export interface AgentModelContext {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
}

/** Builds model-ready context from durable session state, roots, tools, and the selected profile. */
export function buildAgentModelContext(input: {
  readonly session: SessionRecord
  readonly messages: readonly SessionMessage[]
  readonly profile: AgentProfile
  readonly registry: ToolRegistry
  readonly config: Pick<Oc2Config, "tools">
}): AgentModelContext {
  const roots = input.session.workspaceRoots.map((root) => `- ${root.path}${root.readonly ? " (read-only)" : ""}`).join("\n")
  const system = roots.length > 0 ? `${input.profile.systemPrompt}\n\nWorkspace roots:\n${roots}` : input.profile.systemPrompt
  return {
    messages: [{ role: "system", content: system }, ...input.messages.map(toModelMessage).filter((message) => message.content.length > 0)],
    tools: input.registry.materialize(input.config),
  }
}

function toModelMessage(message: SessionMessage): ModelMessage {
  const toolResult = message.parts.find((part): part is Extract<MessagePart, { type: "tool-result" }> => part.type === "tool-result")
  if (message.role === "tool" && toolResult) {
    return {
      id: message.id,
      role: "tool",
      toolCallId: toolResult.result.toolCallId,
      content: toolResult.result.error ? JSON.stringify({ error: toolResult.result.error }) : stringifyToolOutput(toolResult.result.output),
    }
  }

  return {
    id: message.id,
    role: message.role === "synthetic" ? "system" : message.role,
    content: message.parts.map(partToText).filter(Boolean).join("\n"),
  }
}

function partToText(part: MessagePart): string {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text
    case "tool-call":
      return JSON.stringify({ toolCall: part.toolCall })
    case "tool-result":
      return part.result.error ? JSON.stringify({ error: part.result.error }) : stringifyToolOutput(part.result.output)
    case "file":
      return part.text ?? part.path
    case "event":
      return part.eventId
  }
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? null)
}
