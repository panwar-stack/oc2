import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { serviceUse } from "@oc2-ai/core/effect/service-use"
import { Log } from "@oc2-ai/core/util/log"
import { Cause, Context, DateTime, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent as LLMEventType } from "@oc2-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@oc2-ai/llm/route"
import type { LLMClientService } from "@oc2-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@oc2-ai/core/event"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMFugu } from "./llm/fugu"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import type { TaskPromptOps } from "@/tool/task"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  messageID?: string
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  promptOps?: TaskPromptOps
  retries?: number
  attempt?: number
  toolChoice?: "auto" | "required" | "none"
  forbidImplicitTools?: boolean
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

type ProviderRunResult =
  | { type: "native"; stream: Stream.Stream<LLMEventType, unknown> }
  | { type: "event-stream"; stream: Stream.Stream<LLMEventType, unknown> }
  | { type: "ai-sdk"; result: ReturnType<typeof streamText>; identity: LLMAISDK.UsageIdentity }

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEventType, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const runProvider = Effect.fn("LLM.runProvider")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      if (LLMFugu.isSelected(input.model)) {
        // log.info("INPUT", {
        //   model: input.model,
        //   messages: input.messages,
        //   tools: Object.keys(input.tools),
        // });
        const cfg = yield* config.get()
        return {
          type: "event-stream" as const,
          stream: yield* LLMFugu.run(input, cfg.fugu, provider, executeProvider, (status) =>
            events
              .publish(SessionEvent.Fugu.Status, {
                ...status,
                sessionID: SessionID.make(input.sessionID),
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
              .pipe(Effect.asVoid),
          ),
        }
      }

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })
      const telemetryAttributes = langfuseTelemetryAttributes({
        sessionID: input.sessionID,
        userID: cfg.username ?? "unknown",
        system: prepared.system,
        messages: prepared.messages,
      })
      // l.info("system.prompt", {
      //   systemPrompt,
      //   systemPromptCount: prepared.system.length,
      // })
      yield* Effect.annotateCurrentSpan(telemetryAttributes)

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                for (const [name, value] of Object.entries(telemetryAttributes)) span.setAttribute(name, value)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @oc2-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "native",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
            }),
          )
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected").pipe(
          Effect.annotateLogs({
            "llm.runtime": "ai-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
            "llm.native_unsupported_reason": native.reason,
          }),
        )
        l.info("native runtime unavailable; falling back to ai-sdk", { reason: native.reason })
      }

      yield* Effect.logInfo("llm runtime selected").pipe(
        Effect.annotateLogs({
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
        }),
      )
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      const identity = {
        providerID: String(input.model.providerID),
        modelID: String(input.model.id),
        apiPackage: input.model.api.npm,
      }
      return {
        type: "ai-sdk" as const,
        identity,
        result: streamText({
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks:
            input.model.providerID.includes("github-copilot") || LLMAISDK.requiresRawChunks(identity),
          onError(error) {
            l.error("stream error", {
              error,
            })
          },
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              l.info("repairing tool call", {
                tool: failed.toolCall.toolName,
                repaired: lower,
              })
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const toEventStream = (result: ProviderRunResult) => {
      if (result.type === "native" || result.type === "event-stream") return result.stream

      const state = LLMAISDK.adapterState(result.identity)
      return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
        e instanceof Error ? e : new Error(String(e)),
      ).pipe(
        Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
        Stream.flatMap((events) => Stream.fromIterable(events)),
      )
    }

    const executeProvider: LLMFugu.Execute = (input) =>
      Stream.unwrap(runProvider(input).pipe(Effect.map(toEventStream)))

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      return yield* runProvider(input)
    })

    const stream: Interface["stream"] = (input) => {
      const startedAt = Date.now()
      let ttftMs: number | undefined
      let eventCount = 0
      let finishReason: string | undefined
      let providerError: string | undefined
      const fields = {
        sessionID: input.sessionID,
        messageID: input.messageID ?? input.user.id,
        providerID: input.model.providerID,
        modelID: input.model.id,
        attempt: input.attempt ?? 1,
      }
      return Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })
            return toEventStream(result)
          }),
        ),
      ).pipe(
        Stream.onStart(Effect.sync(() => log.debug("stream.start", fields))),
        Stream.tap((event) =>
          Effect.sync(() => {
            eventCount++
            if (ttftMs === undefined) {
              ttftMs = Date.now() - startedAt
              log.info("stream.first", { ...fields, ttftMs })
            }
            if (event.type === "finish" || event.type === "step-finish") finishReason = event.reason
            if (event.type === "provider-error") providerError = event.message
          }),
        ),
        Stream.onEnd(
          Effect.sync(() =>
            providerError === undefined
              ? log.info("stream.complete", {
                  ...fields,
                  durationMs: Date.now() - startedAt,
                  ttftMs,
                  eventCount,
                  finishReason,
                })
              : log.warn("stream.error", {
                  ...fields,
                  durationMs: Date.now() - startedAt,
                  ttftMs,
                  error: providerError,
                }),
          ),
        ),
        Stream.onError((cause) =>
          Effect.sync(() =>
            log.warn("stream.error", {
              ...fields,
              durationMs: Date.now() - startedAt,
              ttftMs,
              error: errorText(Cause.squash(cause)),
            }),
          ),
        ),
      )
    }

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const langfuseTelemetryAttributes = (input: {
  readonly sessionID: string
  readonly userID: string
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
}) => {
  const system = input.system.filter((content) => content.length > 0)
  const messages = [
    ...system.map((content): ModelMessage => ({ role: "system", content })),
    ...input.messages.filter(
      (message) =>
        message.role !== "system" || typeof message.content !== "string" || !system.includes(message.content),
    ),
  ]
  const langfuseInput = JSON.stringify({ messages })
  const systemPrompt = system.join("\n")

  return {
    "session.id": input.sessionID,
    "langfuse.session.id": input.sessionID,
    "langfuse.user.id": input.userID,
    "gen_ai.input.messages": JSON.stringify(messages),
    "langfuse.observation.input": langfuseInput,
    "langfuse.trace.input": langfuseInput,
    "langfuse.observation.metadata.system_prompt": systemPrompt,
    "langfuse.trace.metadata.system_prompt": systemPrompt,
    "gen_ai.system_instructions": systemPrompt,
    "system.prompt": systemPrompt,
    "system.prompt.count": system.length,
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export * as LLM from "./llm"
