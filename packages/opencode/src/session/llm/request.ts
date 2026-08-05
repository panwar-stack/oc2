import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import { CacheGuardrails } from "@oc2-ai/llm"
import { CachePlanner, type CachePlan } from "@oc2-ai/llm/cache/planner"
import type { Auth } from "@/auth"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@oc2-ai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `oc2/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly forbidImplicitTools?: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
    readonly cachePlan?: CachePlan
  }
  readonly messageTransformOptions: Record<string, any>
  readonly cacheGuardrails: CacheGuardrails.CacheGuardrailResult
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const tools = resolveTools(input)
  const stablePrompt = system
  const generation = {
    temperature: input.agent.temperature ?? ProviderTransform.temperature(input.model),
    topP: input.agent.topP ?? ProviderTransform.topP(input.model),
    topK: ProviderTransform.topK(input.model),
    maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
  }
  if (
    !input.forbidImplicitTools &&
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }
  const sortedTools: Record<string, Tool> = Object.fromEntries(
    Object.entries(tools)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, tool]) => {
        if (input.model.api.npm !== "@ai-sdk/anthropic" || input.model.providerID === "anthropic") return [name, tool]
        return [name, { ...tool, providerOptions: scrubCacheControlOptions(tool.providerOptions, input.model) }]
      }),
  )
  const cacheRoute = cacheRouteForModel(input.model)

  const cacheBoundary = CachePlanner.planCache({
    provider: input.model.providerID,
    model: input.model.api.id,
    routeID: cacheRoute?.routeID,
    protocolID: cacheRoute?.protocolID,
    cachePolicy: "auto",
    system: stablePrompt.map((text) => ({
      type: "text",
      text,
      metadata: { cache: { stable: true, version: CachePlanner.CACHE_PLANNER_VERSION } },
    })),
    tools: Object.entries(sortedTools).map(([name, tool]) => ({
      name,
      description: tool.description ?? "",
      inputSchema: schemaFromTool(tool),
      cache: cacheHintFromProviderOptions(input.model, tool.providerOptions),
    })),
    messages: cachePlannerMessages(
      input.model,
      input.messages.filter((message) => message.role !== "system"),
    ),
    providerConfig: input.provider.options,
    modelConfig: {
      provider: input.model.providerID,
      model: input.model.api.id,
      routeID: cacheRoute?.routeID,
      protocolID: cacheRoute?.protocolID,
      generation,
      cachePolicy: "auto",
    },
  })
  const explicitCacheControls = [
    ...Object.values(sortedTools).flatMap((tool, index) => {
      const control = cacheHintFromProviderOptions(input.model, tool.providerOptions)
      return control ? [{ slot: `tools:${index}`, control }] : []
    }),
    ...cacheControlsFromMessages(input.model, input.messages),
  ]
  const configuredCacheControl = [input.model.options, input.agent.options, variant]
    .map(requestCacheControlFromOptions)
    .findLast((value) => value !== undefined)
  const initialCachePlan = coordinateAnthropicCachePlan(
    input.model,
    cachePlanWithRequestControl(input.model, cacheBoundary.plan, configuredCacheControl),
    explicitCacheControls,
  )
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
        cachePlan: initialCachePlan,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  if (configuredCacheControl) setRequestCacheControl(options, configuredCacheControl)
  const cacheControlBeforePlugin = requestCacheControlFromOptions(options)
  const promptCacheKey = typeof base.promptCacheKey === "string" ? base.promptCacheKey : undefined
  if (usesOpenAICacheKey(input.model)) scrubPromptCacheKeys(options, promptCacheKey)
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
      cachePlan: initialCachePlan,
    },
  )
  if (usesOpenAICacheKey(input.model)) {
    scrubPromptCacheKeys(options, promptCacheKey)
    scrubPromptCacheKeys(params.options, promptCacheKey)
  }
  const configuredByPlugin = requestCacheControlFromOptions(params.options)
  const pluginChangedCacheControl = !sameCacheControl(configuredByPlugin, cacheControlBeforePlugin)
  const pluginCachePlan = CachePlanner.reconcileCachePlan(initialCachePlan, params.cachePlan, cacheBoundary.stable)
  const cachePlan = coordinateAnthropicCachePlan(
    input.model,
    pluginChangedCacheControl
      ? cachePlanWithRequestControl(input.model, pluginCachePlan, configuredByPlugin)
      : pluginCachePlan,
    explicitCacheControls,
  )
  syncRequestCacheControl(input.model, params.options, cachePlan)
  const preparedTools = ProviderTransform.tools(sortedTools, input.model, cachePlan)
  const preparedParams = { ...params, cachePlan }
  const cacheGuardrails = CacheGuardrails.combine(
    CacheGuardrails.checkUnsupportedFields({
      provider: cachePlan.provider,
      model: cachePlan.model,
      fields: cacheRequestFields(input.model, preparedParams.options, cachePlan),
    }),
    CacheGuardrails.checkProviderFieldLeakage({
      provider: cachePlan.provider,
      model: cachePlan.model,
      fields: cacheRequestFields(input.model, preparedParams.options, cachePlan),
    }),
    CacheGuardrails.checkInvalidDuration({
      provider: cachePlan.provider,
      model: cachePlan.model,
      duration: cachePlan.duration,
    }),
    CacheGuardrails.checkBreakpointOverflow({
      provider: cachePlan.provider,
      model: cachePlan.model,
      breakpoints: cachePlan.breakpoints,
      requestCacheControl: cachePlan.requestCacheControl,
    }),
  )
  if (!cacheGuardrails.valid) {
    return yield* Effect.fail(
      new Error(`Prompt cache configuration invalid: ${cacheGuardrails.errors.map((item) => item.message).join(" ")}`),
    )
  }

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  return {
    system,
    messages,
    tools: preparedTools,
    params: preparedParams,
    messageTransformOptions: {
      ...preparedParams.options,
      cachePlan,
      oc2CacheToolHintCount: Object.values(preparedTools).filter((tool) =>
        Boolean(cacheHintFromProviderOptions(input.model, tool.providerOptions)),
      ).length,
    },
    cacheGuardrails,
    headers: {
      "x-session-affinity": input.sessionID,
      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
      "User-Agent": USER_AGENT,
      ...input.model.headers,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return selectTools(
    Record.filter(input.tools, (_, key) => !disabled.has(key)),
    input.user.tools,
  )
}

/**
 * Applies a prompt's tool selection to the complete runtime registry. `"*": false` is an
 * allow-list boundary: tools added dynamically by plugins or MCP servers stay unavailable unless
 * the prompt explicitly sets that exact tool name to `true`.
 */
export function selectTools(tools: Record<string, Tool>, selection: Record<string, boolean> | undefined) {
  return Record.filter(
    tools,
    (_, key) => selection?.[key] !== false && (selection?.["*"] !== false || selection?.[key] === true),
  )
}

/** True only for the lifecycle reconciler's completion-only retry allow-list. */
export function isCompletionOnlyToolSelection(selection: Record<string, boolean> | undefined) {
  if (selection?.["*"] !== false || selection.team_task_update !== true) return false
  return Object.keys(selection).every((key) => key === "*" || key === "team_task_update")
}

function schemaFromTool(tool: Tool) {
  if ("inputSchema" in tool) return tool.inputSchema
  return undefined
}

function cacheRouteForModel(model: Provider.Model) {
  if (model.providerID === "anthropic" && model.api.npm === "@ai-sdk/anthropic") {
    return { routeID: "anthropic-messages", protocolID: "anthropic-messages" }
  }
  if (model.api.npm === "@ai-sdk/amazon-bedrock") {
    return { routeID: "bedrock-converse", protocolID: "bedrock-converse" }
  }
  return undefined
}

function cachePlannerMessages(model: Provider.Model, messages: ModelMessage[]) {
  return messages.map((message) => {
    const messageCache = cacheHintFromProviderOptions(model, message.providerOptions)
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content, cache: messageCache }]
        : message.content.map((part) => ({
            type: part.type,
            cache: cacheHintFromMessagePart(model, part),
          }))
    const last = content.at(-1)
    if (messageCache && last && !last.cache) {
      content[content.length - 1] = { ...last, cache: messageCache }
    }
    return { role: message.role, content }
  })
}

function cacheControlsFromMessages(model: Provider.Model, messages: ModelMessage[]) {
  return messages.flatMap((message, messageIndex) => {
    const messageControl = cacheHintFromProviderOptions(model, message.providerOptions)
    if (typeof message.content === "string") {
      return messageControl ? [{ slot: `messages:${messageIndex}:0`, control: messageControl }] : []
    }
    const controls = new Map<string, { type: "ephemeral"; ttl?: "5m" | "1h" }>()
    message.content.forEach((part, partIndex) => {
      const control = cacheHintFromMessagePart(model, part)
      if (control) controls.set(`messages:${messageIndex}:${partIndex}`, control)
    })
    const lastIndex = message.content.length - 1
    if (messageControl && lastIndex >= 0 && !controls.has(`messages:${messageIndex}:${lastIndex}`)) {
      controls.set(`messages:${messageIndex}:${lastIndex}`, messageControl)
    }
    return [...controls].map(([slot, control]) => ({ slot, control }))
  })
}

function cacheHintFromMessagePart(model: Provider.Model, part: Exclude<ModelMessage["content"], string>[number]) {
  const direct = "providerOptions" in part ? cacheHintFromProviderOptions(model, part.providerOptions) : undefined
  if (direct || part.type !== "tool-result" || !isRecord(part.output)) return direct
  const output = part.output
  let outputProviderOptions = "providerOptions" in output ? output.providerOptions : undefined
  if (outputProviderOptions === undefined && output.type === "content" && Array.isArray(output.value)) {
    for (const item of output.value) {
      if (!isRecord(item) || !("providerOptions" in item) || item.providerOptions === undefined) continue
      outputProviderOptions = item.providerOptions
      break
    }
  }
  return cacheHintFromProviderOptions(model, outputProviderOptions)
}

// Provider IDs served by Alibaba Cloud Model Studio (DashScope). Mirrors the
// alibaba family normalization in @oc2-ai/llm cache capability/guardrails.
const ALIBABA_PROVIDER_IDS = new Set([
  "alibaba",
  "alibaba-cn",
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "dashscope",
])

const isAlibabaProvider = (providerID: string): boolean =>
  ALIBABA_PROVIDER_IDS.has(providerID.toLowerCase())

function cacheHintFromProviderOptions(model: Provider.Model, value: unknown) {
  const supportsCacheHints =
    model.api.npm === "@ai-sdk/anthropic" ||
    model.api.npm === "@ai-sdk/google-vertex/anthropic" ||
    isAlibabaProvider(model.providerID)
  if (!supportsCacheHints) return undefined
  if (!isRecord(value)) return undefined
  for (const key of new Set(["anthropic", "alibaba", "alibaba-cn", String(model.providerID)])) {
    const options = value[key]
    if (!isRecord(options)) continue
    const cache = options.cacheControl ?? options.cache_control
    if (isCacheControl(cache)) return cache
  }
  return undefined
}

function cachePlanWithRequestControl(
  model: Provider.Model,
  plan: CachePlan,
  cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined,
): CachePlan {
  if (model.providerID !== "anthropic" || model.api.npm !== "@ai-sdk/anthropic" || !cacheControl) return plan
  if (plan.mode === "explicit" && !plan.requestCacheControl) return plan
  const requestCacheControl =
    cacheControl.ttl === "1h" ? ({ type: "ephemeral", ttl: "1h" } as const) : ({ type: "ephemeral" } as const)
  const mode = plan.breakpoints.length > 0 ? "automatic_and_explicit" : "automatic"
  return {
    ...plan,
    mode,
    eligible: true,
    duration: cacheControl.ttl === "1h" ? "1h" : "5m",
    requestCacheControl,
  }
}

function coordinateAnthropicCachePlan(
  model: Provider.Model,
  plan: CachePlan,
  explicit: ReadonlyArray<{
    readonly slot: string
    readonly control: { type: "ephemeral"; ttl?: "5m" | "1h" }
  }>,
): CachePlan {
  if (model.api.npm !== "@ai-sdk/anthropic" || !plan.requestCacheControl) return plan
  const requestTTL = plan.requestCacheControl.ttl ?? "5m"
  const conflict = explicit.some(({ control }) => (control.ttl ?? "5m") !== requestTTL)
  const occupied = new Set(explicit.map(({ slot }) => slot))
  for (const breakpoint of plan.breakpoints) occupied.add(`${breakpoint.component}:${breakpoint.index}`)
  const overflow = occupied.size + 1 > 4
  if (!conflict && !overflow) return plan
  return {
    ...plan,
    mode: "explicit",
    breakpoints: conflict || explicit.length >= 4 ? [] : plan.breakpoints,
    requestCacheControl: undefined,
  }
}

function requestCacheControlFromOptions(value: unknown) {
  if (!isRecord(value)) return undefined
  if (isCacheControl(value.cache_control)) return value.cache_control
  if (isCacheControl(value.cacheControl)) return value.cacheControl
  return undefined
}

function sameCacheControl(
  left: { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined,
  right: { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined,
) {
  return left?.type === right?.type && (left?.ttl ?? "5m") === (right?.ttl ?? "5m")
}

function setRequestCacheControl(options: Record<string, any>, cacheControl: { type: "ephemeral"; ttl?: "5m" | "1h" }) {
  options.cacheControl = cacheControl.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
  delete options.cache_control
}

function syncRequestCacheControl(model: Provider.Model, options: Record<string, any>, plan: CachePlan) {
  if (model.api.npm !== "@ai-sdk/anthropic") return
  if (model.providerID !== "anthropic") {
    delete options.cacheControl
    delete options.cache_control
    return
  }
  if (
    plan.eligible &&
    (plan.mode === "automatic" || plan.mode === "automatic_and_explicit") &&
    plan.requestCacheControl
  ) {
    setRequestCacheControl(options, plan.requestCacheControl)
    return
  }
  delete options.cacheControl
  delete options.cache_control
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCacheControl(value: unknown): value is { type: "ephemeral"; ttl?: "5m" | "1h" } {
  return (
    isRecord(value) &&
    value.type === "ephemeral" &&
    (value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h")
  )
}

function scrubCacheControlOptions(value: unknown, model: Provider.Model) {
  if (!isRecord(value)) return value
  const result = { ...value }
  for (const key of new Set(["anthropic", String(model.providerID)])) {
    const provider = result[key]
    if (!isRecord(provider)) continue
    const { cacheControl, cache_control, ...rest } = provider
    if (cacheControl === undefined && cache_control === undefined) continue
    if (Object.keys(rest).length === 0) delete result[key]
    else result[key] = rest
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function scrubPromptCacheKeys(options: Record<string, any>, promptCacheKey: string | undefined) {
  delete options.promptCacheKey
  delete options.prompt_cache_key
  if (promptCacheKey) options.promptCacheKey = promptCacheKey
}

function cacheRequestFields(model: Provider.Model, options: Record<string, any>, plan: CachePlan) {
  return [
    ...collectCacheFields(options),
    ...(promptCacheKeyFromOptions(options) ? ["prompt_cache_key"] : []),
    ...(plan.requestCacheControl ? ["cache_control"] : []),
    ...(plan.eligible &&
    (plan.mode === "explicit" || plan.mode === "automatic_and_explicit") &&
    plan.breakpoints.length > 0
      ? explicitCacheFields(model)
      : []),
  ]
}

function collectCacheFields(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectCacheFields)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === "cache_control" || key === "cacheControl" ? ["cache_control"] : []),
    ...(key === "cachePoint" ? ["cachePoint"] : []),
    ...collectCacheFields(item),
  ])
}

function promptCacheKeyFromOptions(options: Record<string, any>) {
  return typeof options.promptCacheKey === "string" || typeof options.prompt_cache_key === "string"
}

function explicitCacheFields(model: Provider.Model) {
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic")
    return ["cache_control"]
  return []
}

function usesOpenAICacheKey(model: Provider.Model) {
  return (
    model.providerID === "openai" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/openai-compatible" ||
    model.api.npm === "@ai-sdk/github-copilot"
  )
}

const isCachePlan = (value: unknown): value is CachePlan =>
  typeof value === "object" &&
  value !== null &&
  "provider" in value &&
  "model" in value &&
  "mode" in value &&
  "cacheKey" in value &&
  "eligible" in value &&
  "breakpoints" in value &&
  Array.isArray(value.breakpoints)

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
