// Apply an `LLMRequest.cache` policy by injecting `CacheHint`s onto the parts
// the policy designates. Runs once at compile time, before the per-protocol
// body builder, so the existing inline-hint lowering path handles the rest.
//
// The default `"auto"` shape plans stable tools and system content, then leaves
// dynamic turn messages out of the stable prefix unless a caller marks a message
// explicitly stable. Manual `cache: CacheHint` placements are preserved.
//
import { planCacheRequest, resolveCachePolicy } from "./cache/planner"
import { CacheHint } from "./schema/options"
import { LLMRequest, Message, ToolDefinition, type ContentPart } from "./schema/messages"

// Bedrock still lowers cache markers from inline `CacheHint`s. Anthropic lowers
// the shared CachePlan directly so provider cache fields stay protocol-local.
const RESPECTS_INLINE_HINTS = new Set(["bedrock-converse"])

const makeHint = (ttlSeconds: number | undefined): CacheHint =>
  ttlSeconds !== undefined ? new CacheHint({ type: "ephemeral", ttlSeconds }) : new CacheHint({ type: "ephemeral" })

const markToolAt = (
  tools: ReadonlyArray<ToolDefinition>,
  index: number,
  hint: CacheHint,
): ReadonlyArray<ToolDefinition> => {
  if (index < 0 || index >= tools.length) return tools
  if (tools[index]!.cache) return tools
  return tools.map((tool, i) => (i === index ? new ToolDefinition({ ...tool, cache: hint }) : tool))
}

const markSystemAt = (system: LLMRequest["system"], index: number, hint: CacheHint): LLMRequest["system"] => {
  if (index < 0 || index >= system.length) return system
  if (system[index]!.cache) return system
  return system.map((part, i) => (i === index ? { ...part, cache: hint } : part))
}

// Mark the last text part of `messages[index]`. If no text part exists, mark
// the last content part regardless of type — that's the breakpoint position
// in tool-result-only messages too.
const markMessageAt = (messages: ReadonlyArray<Message>, index: number, hint: CacheHint): ReadonlyArray<Message> => {
  if (index < 0 || index >= messages.length) return messages
  const target = messages[index]!
  if (target.content.length === 0) return messages
  const lastTextIndex = target.content.findLastIndex((part) => part.type === "text")
  const markAt = lastTextIndex >= 0 ? lastTextIndex : target.content.length - 1
  const existing = target.content[markAt]!
  if ("cache" in existing && existing.cache) return messages
  const nextContent = target.content.map((part, i) => (i === markAt ? ({ ...part, cache: hint } as ContentPart) : part))
  const next = new Message({ ...target, content: nextContent })
  // Single pass over `messages`, substituting the one updated entry. Long
  // conversations call this on every request, so avoid `.map()` here — its
  // closure dispatch and identity copies show up in profiling.
  const result = messages.slice()
  result[index] = next
  return result
}

export const applyCachePolicy = (request: LLMRequest): LLMRequest => {
  const planned = planCacheRequest(request)
  const requestWithPlan = LLMRequest.update(request, {
    metadata: { ...request.metadata, cachePlan: planned.plan, cacheBoundary: { version: planned.version, stable: planned.stable, dynamic: planned.dynamic } },
  })
  if (!RESPECTS_INLINE_HINTS.has(request.model.route.id)) return requestWithPlan
  const policy = resolveCachePolicy(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return requestWithPlan

  const hint = makeHint(policy.ttlSeconds)
  let tools = request.tools
  let system = request.system
  let messages = request.messages
  for (const breakpoint of planned.plan.breakpoints) {
    if (breakpoint.component === "tools") tools = markToolAt(tools, breakpoint.index, hint)
    if (breakpoint.component === "system") system = markSystemAt(system, breakpoint.index, hint)
    if (breakpoint.component === "messages") messages = markMessageAt(messages, breakpoint.index, hint)
  }

  if (tools === request.tools && system === request.system && messages === request.messages) return requestWithPlan
  return LLMRequest.update(requestWithPlan, { tools, system, messages })
}
