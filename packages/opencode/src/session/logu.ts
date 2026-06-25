export * as SessionLogu from "./logu"

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Effect } from "effect"
import type { ModelMessage } from "ai"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "./compound/config"
import { SessionCompound } from "./compound/runner"
import type { TaskPromptOps } from "@/tool/task"
import { isRecord } from "@/util/record"

export type RunInput = {
  sessionID: SessionID
  model: Provider.Model
  agent: Agent.Info
  system: string[]
  messages: ModelMessage[]
  permission?: PermissionV1.Ruleset
  abort: AbortSignal
  promptOps: TaskPromptOps
}

export type RunResult = SessionCompound.RunResult

const LONG_PROMPT_CHARS = 1200
const COMPLEX_PROMPT_PATTERN =
  /\b(code review|review|architecture|security|migration|regression|root cause|race condition|database|auth|authentication|serialization|broad repo|investigation|spec|specs|implementation plan|tradeoff|tradeoffs|multiple approaches)\b/i
const FAILURE_CONTEXT_PATTERN =
  /\b(error|failed|failure|exception|stack trace|traceback|segmentation fault|panic|crash|timed out|timeout|exit code|this failed)\b/i

export function route(input: { config?: ConfigV1.Info["logu"]; system: string[]; messages: ModelMessage[] }): "direct" | "fusion" {
  if (!input.config) return "fusion"
  if (input.config.routing?.mode === "always") return "fusion"
  if (input.config.routing?.mode === "never") return "direct"

  const latestUser = input.messages.findLast((message) => message.role === "user")
  const latestUserText = latestUser ? renderContent(latestUser.content) : ""
  if (latestUserText.length > LONG_PROMPT_CHARS) return "fusion"
  if (COMPLEX_PROMPT_PATTERN.test(latestUserText)) return "fusion"
  if (FAILURE_CONTEXT_PATTERN.test(latestUserText)) return "fusion"
  if (recentContext(input.messages).some((text) => FAILURE_CONTEXT_PATTERN.test(text))) return "fusion"
  return "direct"
}

export const run = Effect.fn("SessionLogu.run")(function* (input: RunInput) {
  const config = yield* Config.Service
  const compound = (yield* config.get()).local_fusion?.logu
  if (!compound) {
    throw new Error("logu requires local_fusion.logu config; see packages/web/src/content/docs/local-fusion.mdx")
  }

  const parsed = SessionCompoundConfig.parse(compound)
  validateNoRecursiveLogu(parsed)

  return yield* SessionCompound.run({
    sessionID: input.sessionID,
    prompt: renderTranscript({ system: input.system, messages: input.messages }),
    config: parsed,
    agent: input.agent.name,
    promptOps: input.promptOps,
    abort: input.abort,
    mode: "logu",
    loguRunID: MessageID.ascending(),
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt
        const error = Cause.squash(cause)
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith("All compound branches failed:")) throw new Error(`logu failed: ${message}`)
        throw error instanceof Error ? error : new Error(message)
      }),
    ),
  )
})

export function renderTranscript(input: { system: string[]; messages: ModelMessage[] }) {
  const latestUserIndex = input.messages.findLastIndex((message) => message.role === "user")
  return [
    "Logu compound run transcript.",
    "",
    "System:",
    input.system.length === 0 ? "[none]" : input.system.map((item, index) => `System ${index + 1}:\n${item}`).join("\n\n"),
    "",
    "Conversation:",
    input.messages.length === 0
      ? "[none]"
      : input.messages.map((message, index) => renderMessage(message, index === latestUserIndex)).join("\n\n"),
  ].join("\n")
}

function validateNoRecursiveLogu(config: SessionCompoundConfig.Config) {
  for (const [index, branch] of config.branches.entries()) validateModel(`branches[${index}].model`, branch.model)
  validateModel("judge.model", config.judge.model)
  validateModel("synthesizer.model", config.synthesizer.model)
}

function validateModel(path: string, model: string) {
  const parsed = SessionCompoundConfig.parseModel(model)
  if (String(parsed.providerID) === "logu" && String(parsed.modelID) === "logu") {
    throw new Error(`logu config cannot reference logu/logu at ${path}`)
  }
}

function renderMessage(message: ModelMessage, latestUser: boolean) {
  const label = message.role === "user" && latestUser ? "User (latest request)" : roleLabel(message.role)
  return `${label}:\n${renderContent(message.content)}`
}

function roleLabel(role: ModelMessage["role"]) {
  if (role === "assistant") return "Assistant"
  if (role === "tool") return "Tool"
  if (role === "system") return "System update"
  return "User"
}

function renderContent(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return (content as readonly unknown[]).map(renderPart).filter(Boolean).join("\n")
}

function recentContext(messages: ModelMessage[]) {
  return messages
    .slice(-6)
    .filter((message) => message.role === "assistant" || message.role === "tool")
    .map((message) => renderContent(message.content))
}

function renderPart(part: unknown) {
  if (!isRecord(part)) return stableStringify(part)
  if (part.type === "text") return typeof part.text === "string" ? part.text : ""
  if (part.type === "tool-call") return `Tool call ${textValue(part.toolName)} (${textValue(part.toolCallId)}): ${stableStringify(part.input)}`
  if (part.type === "tool-result") {
    return `Tool result ${textValue(part.toolName)} (${textValue(part.toolCallId)}): ${stableStringify(part.output ?? part.result)}`
  }
  if (part.type === "file" || part.type === "image") return `[unsupported attachment: ${mimeType(part)}]`
  return stableStringify(part)
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "unknown"
}

function mimeType(part: Record<string, unknown>) {
  if (typeof part.mediaType === "string") return part.mediaType
  if (typeof part.mimeType === "string") return part.mimeType
  return "application/octet-stream"
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]))
}
