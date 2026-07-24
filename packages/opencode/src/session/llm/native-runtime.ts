import type { Auth } from "@/auth"
import type { CachePlan } from "@oc2-ai/llm/cache/planner"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import {
  CacheGuardrails,
  InvalidRequestReason,
  LLMEvent,
  LLMError,
  LLMRequest,
  Tool as NativeTool,
  ToolFailure,
  ToolRuntime,
  toDefinitions,
  type JsonSchema,
} from "@oc2-ai/llm"
import type { LLMClientShape } from "@oc2-ai/llm/route"
import { LLMNative } from "./native-request"
import { ProviderTimingLifecycle } from "./provider-timing"

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly cachePlan?: CachePlan
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
  readonly timing?: ProviderTimingLifecycle.ProviderTiming
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  const providerID = input.model.providerID
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  if (providerID !== "openai" && providerID !== "anthropic" && npm !== "@ai-sdk/openai-compatible")
    return { type: "unsupported", reason: "provider is not openai, OpenAI-compatible, or anthropic" }
  if (input.auth?.type === "oauth" && !(input.provider.id === "openai" && fetch)) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  const baseURL = typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : input.model.api.url || undefined
  if (npm === "@ai-sdk/openai-compatible" && !baseURL)
    return { type: "unsupported", reason: "OpenAI-compatible provider requires a base URL" }

  return {
    type: "supported",
    apiKey,
    baseURL,
  }
}

export function stream(input: StreamInput): StreamResult {
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current

  // Integration point with @oc2-ai/llm: native-request lowers session data
  // into an LLMRequest, then LLMClient handles route selection and transport.
  //
  // ProviderTransform.providerOptions builds AI-SDK-shaped options for the
  // selected SDK key (e.g. "openai") and the native LLM SDK reads the same
  // keys via OpenAIOptions.* (store, reasoningEffort, reasoningSummary,
  // include, textVerbosity, promptCacheKey). Both sides intentionally use
  // OpenAI's official wire field names, so this is identity, not translation
  // — if a field ever needs to differ between the two surfaces, the
  // translation belongs here, not split across both packages.
  const tools = nativeTools(input.tools, input)
  const request = LLMNative.request({
    model: input.model,
    apiKey: current.apiKey,
    baseURL: current.baseURL,
    messages: ProviderTransform.message(input.messages, input.model, input.providerOptions ?? {}),
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: nativeProviderOptions(input.model, input.providerOptions ?? {}),
    headers: { ...providerHeaders(input.provider.options.headers), ...input.headers },
    cachePlan: input.cachePlan,
  })
  const stream = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const settlements = yield* FiberSet.make<void>()
        const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        const provider = Stream.suspend(() => {
          let terminal: "step-finish" | "provider-error" | undefined
          let finish = false
          ProviderTimingLifecycle.beginProviderStep(input.timing, 0)
          const requestWithTools = LLMRequest.update(request, {
            tools: [...request.tools, ...toDefinitions(tools)],
          })
          const guardrails = nativeGuardrails(requestWithTools)
          if (!guardrails.valid)
            return Stream.fail(
              new LLMError({
                module: "LLMNativeRuntime",
                method: "stream",
                reason: new InvalidRequestReason({
                  message: `Prompt cache configuration invalid: ${guardrails.errors.map((item) => item.message).join(" ")}`,
                }),
              }),
            )
          return Stream.fromEffect(
            Effect.forEach(guardrails.warnings, (warning) =>
              Effect.logWarning("prompt cache guardrail").pipe(Effect.annotateLogs({ issue: warning })),
            ),
          ).pipe(
            Stream.drain,
            Stream.concat(
              input.llmClient
                .stream(requestWithTools, {
                  onDispatch: () => ProviderTimingLifecycle.beginProviderAttempt(input.timing),
                  onDispatchFailure: () => {
                    if (input.timing?.active) ProviderTimingLifecycle.finishProviderAttempt(input.timing, "error")
                  },
                })
                .pipe(
                  Stream.mapEffect((event) =>
                    Effect.sync(() => {
                      if (terminal) {
                        if (terminal === "step-finish" && event.type === "finish" && !finish) {
                          finish = true
                          return event
                        }
                        throw new Error("Provider emitted content after a terminal event")
                      }
                      if (event.type === "step-finish") {
                        if (input.timing?.active) ProviderTimingLifecycle.finishProviderAttempt(input.timing, "success")
                        terminal = "step-finish"
                      }
                      if (event.type === "provider-error") {
                        if (input.timing?.active) ProviderTimingLifecycle.finishProviderAttempt(input.timing, "error")
                        terminal = "provider-error"
                      }
                      return event
                    }),
                  ),
                  Stream.concat(
                    Stream.suspend(() => {
                      if (terminal) return Stream.empty
                      if (input.timing?.active) ProviderTimingLifecycle.finishProviderAttempt(input.timing, "eof")
                      terminal = "provider-error"
                      return Stream.make(LLMEvent.providerError({ message: "Provider stream ended without a terminal event" }))
                    }),
                  ),
                  Stream.onError((cause) =>
                    Effect.sync(() => {
                      if (input.timing?.active) {
                        ProviderTimingLifecycle.finishProviderAttempt(
                          input.timing,
                          Cause.hasInterruptsOnly(cause) ? "interrupt" : "error",
                        )
                      }
                    }),
                  ),
                  Stream.ensuring(
                    Effect.sync(() => {
                      if (input.timing?.active) ProviderTimingLifecycle.finishProviderAttempt(input.timing, "interrupt")
                    }),
                  ),
                ),
            ),
          )
        }).pipe(
          Stream.flatMap((event) =>
            event.type !== "tool-call" || event.providerExecuted
              ? Stream.make(event)
              : Stream.make(event).pipe(
                  Stream.concat(
                    Stream.fromEffectDrain(
                      ToolRuntime.dispatch(tools, event).pipe(
                        Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
                        Effect.catchCause((cause) => Queue.failCause(results, cause)),
                        Effect.asVoid,
                        FiberSet.run(settlements, { startImmediately: true }),
                      ),
                    ),
                  ),
                ),
          ),
          Stream.concat(
            Stream.fromEffectDrain(
              FiberSet.awaitEmpty(settlements).pipe(Effect.andThen(Queue.end(results)), Effect.asVoid),
            ),
          ),
        )
        return provider.pipe(Stream.concat(Stream.fromQueue(results)))
      }),
    ),
  )

  return {
    ...current,
    stream: fetch ? stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch)) : stream,
  }
}

function nativeProviderOptions(model: Provider.Model, options: Record<string, any>) {
  if (model.api.npm === "@ai-sdk/openai-compatible") return { openai: options }
  return ProviderTransform.providerOptions(model, options)
}

function nativeGuardrails(request: LLMRequest) {
  const plan = request.metadata?.cachePlan
  if (!isCachePlan(plan)) return CacheGuardrails.combine()
  const fields = nativeCacheFields(request)
  return CacheGuardrails.combine(
    CacheGuardrails.checkUnsupportedFields({ provider: plan.provider, model: plan.model, fields }),
    CacheGuardrails.checkProviderFieldLeakage({ provider: plan.provider, model: plan.model, fields }),
    CacheGuardrails.checkInvalidDuration({ provider: plan.provider, model: plan.model, duration: plan.duration }),
    CacheGuardrails.checkBreakpointOverflow({ provider: plan.provider, model: plan.model, breakpoints: plan.breakpoints }),
  )
}

function nativeCacheFields(request: LLMRequest) {
  const options = request.providerOptions ?? {}
  return [
    ...collectOptionCacheFields(options),
    ...request.system.flatMap((part) => (part.cache ? ["cache_control"] : [])),
    ...request.tools.flatMap((tool) => (tool.cache ? ["cache_control"] : [])),
    ...request.messages.flatMap((message) =>
      message.content.flatMap((part) => ("cache" in part && part.cache ? ["cache_control"] : [])),
    ),
  ]
}

function collectOptionCacheFields(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectOptionCacheFields)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => [
    ...(key === "promptCacheKey" || key === "prompt_cache_key" ? ["prompt_cache_key"] : []),
    ...(key === "cache_control" || key === "cacheControl" ? ["cache_control"] : []),
    ...(key === "cachePoint" ? ["cachePoint"] : []),
    ...collectOptionCacheFields(item),
  ])
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

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.provider.id !== "openai" || input.auth?.type !== "oauth") return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains opencode-owned. The native runtime only adapts
      // the @oc2-ai/llm tool call back into the AI SDK Tool.execute shape.
      NativeTool.make({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
