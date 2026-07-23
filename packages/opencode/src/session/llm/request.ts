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
      SystemPrompt.TOKEN_BUDGET_GUIDANCE,
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
  const stablePrompt = [
    SystemPrompt.TOKEN_BUDGET_GUIDANCE,
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
  ]
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

  const cacheBoundary = CachePlanner.planCache({
    provider: input.model.providerID,
    model: input.model.api.id,
    cachePolicy: "auto",
    system: stablePrompt.map((text) => ({
      type: "text",
      text,
      metadata: { cache: { stable: true, version: CachePlanner.CACHE_PLANNER_VERSION } },
    })),
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description ?? "",
      inputSchema: schemaFromTool(tool),
    })),
    providerConfig: input.provider.options,
    modelConfig: {
      provider: input.model.providerID,
      model: input.model.api.id,
      generation,
      cachePolicy: "auto",
    },
  })
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
        cachePlan: cacheBoundary.plan,
      })
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  const promptCacheKey = typeof base.promptCacheKey === "string" ? base.promptCacheKey : undefined
  scrubPromptCacheKeys(options, promptCacheKey)
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
      cachePlan: cacheBoundary.plan,
    },
  )
  scrubPromptCacheKeys(options, promptCacheKey)
  scrubPromptCacheKeys(params.options, promptCacheKey)
  const cachePlan = isCachePlan(params.cachePlan) ? params.cachePlan : cacheBoundary.plan
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
    CacheGuardrails.checkInvalidDuration({ provider: cachePlan.provider, model: cachePlan.model, duration: cachePlan.duration }),
    CacheGuardrails.checkBreakpointOverflow({ provider: cachePlan.provider, model: cachePlan.model, breakpoints: cachePlan.breakpoints }),
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
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params: preparedParams,
    messageTransformOptions: { ...options, cachePlan },
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
  return Record.filter(
    input.tools,
    (_, k) =>
      input.user.tools?.[k] !== false &&
      (input.user.tools?.["*"] !== false || input.user.tools?.[k] === true) &&
      !disabled.has(k),
  )
}

function schemaFromTool(tool: Tool) {
  if ("inputSchema" in tool) return tool.inputSchema
  return undefined
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
    ...(plan.eligible && plan.mode === "explicit" && plan.breakpoints.length > 0 ? explicitCacheFields(model) : []),
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
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") return ["cache_control"]
  return []
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
