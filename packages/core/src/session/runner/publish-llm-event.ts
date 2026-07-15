import {
  CanonicalUsage,
  ToolOutput as LLMToolOutput,
  type LLMEvent,
  type ProviderMetadata,
  type ToolOutput as LLMToolOutputType,
  type ToolResultValue,
  type Usage,
} from "@oc2-ai/llm"
import { DateTime, Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionAccounting } from "../accounting"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly catalog: ModelV2.Info
  readonly clock?: () => number
}

type Settlement = "success" | "error" | "interrupt" | "eof"

const providerAmount = (usage: CanonicalUsage) => {
  const copilot = usage.providerMetadata?.copilot
  const totalNanoAiu = copilot && typeof copilot.totalNanoAiu === "number" ? copilot.totalNanoAiu : undefined
  if (totalNanoAiu !== undefined && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0)
    return totalNanoAiu / 100_000_000_000
  const openrouter = usage.providerMetadata?.openrouter
  const details = openrouter?.usage
  if (!details || typeof details !== "object" || !("cost" in details)) return undefined
  const cost = details.cost
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

const compatibility = (usage: CanonicalUsage | undefined, pricing: SessionEvent.Step.Accounting["pricing"]) => ({
  cost: usage ? (pricing?.amount ?? 0) : 0,
  tokens: {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    reasoning: usage?.reasoning ?? 0,
    cache: { read: usage?.cache.read ?? 0, write: usage?.cache.write ?? 0 },
  },
})

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type ToolOutput =
  | { readonly structured: Record<string, unknown>; readonly content: LLMToolOutputType["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: LLMToolOutputType | undefined, result: ToolResultValue): ToolOutput => {
  if (result.type === "error") return { error: { type: "unknown", message: message(result.value) } }
  const settled = value ?? LLMToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  const timestamp = DateTime.now
  const assistantMessageID = SessionMessage.ID.create()
  const clock = input.clock ?? Date.now
  const intervals = new Array<{ readonly started: number; readonly completed: number; readonly duration: number }>()
  let assistantStarted = false
  let providerFailed = false
  let activeAttempt: number | undefined
  let stepStart: number | undefined
  let stepFinish: Extract<LLMEvent, { readonly type: "step-finish" }> | undefined
  let finish: Extract<LLMEvent, { readonly type: "finish" }> | undefined
  let providerError: Extract<LLMEvent, { readonly type: "provider-error" }> | undefined
  let terminal: "ended" | "failed" | undefined

  const startAttempt = () => {
    if (activeAttempt !== undefined) throw new Error("Provider attempt is already active")
    activeAttempt = clock()
  }

  const completeAttempt = (outcome: Settlement) => {
    if (activeAttempt === undefined) return
    const completed = clock()
    intervals.push({
      started: activeAttempt,
      completed,
      duration: Math.max(0, Math.floor(completed - activeAttempt)),
    })
    activeAttempt = undefined
    return outcome
  }

  const timing = () => {
    if (!intervals.length) return undefined
    return {
      started: intervals[0].started,
      completed: intervals.at(-1)!.completed,
      duration: intervals.reduce((total, interval) => total + interval.duration, 0),
    }
  }

  const canonical = (usage: Usage | undefined) => (usage ? CanonicalUsage.fromUsage(usage) : undefined)

  const accounting = (
    time: NonNullable<ReturnType<typeof timing>>,
    usage:
      | {
          readonly authoritative: CanonicalUsage
          readonly source: "step-finish" | "finish-fallback" | "provider-error"
          readonly finalObservation?: CanonicalUsage
          readonly anomaly?: "final-usage-mismatch"
        }
      | undefined,
  ): SessionEvent.Step.Accounting => {
    const pricing = usage
      ? SessionAccounting.calculate({
          model: input.catalog,
          variant: input.model.variant,
          usage: usage.authoritative,
          providerAmount: providerAmount(usage.authoritative),
        })
      : undefined
    return {
      mode: "aggregate",
      purpose: "assistant",
      model: input.model,
      time: {
        started: DateTime.makeUnsafe(time.started),
        completed: DateTime.makeUnsafe(time.completed),
        duration: time.duration,
      },
      usage,
      pricing,
    }
  }

  const startAssistant = Effect.fnUntraced(function* (startedAt?: DateTime.Utc) {
    if (assistantStarted) return assistantMessageID
    assistantStarted = true
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      assistantMessageID,
      timestamp: startedAt ?? (yield* timestamp),
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    !assistantStarted ? Effect.die("Tool event before assistant step start") : Effect.succeed(assistantMessageID)

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<string, string[]>()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: string, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments("text", (textID, value) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
      tool.inputEnded = true
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
  ) {
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message },
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const settle = Effect.fn("SessionRunner.settleLLMEventPublisher")(function* (
    outcome: Settlement,
    failureMessage?: string,
  ) {
    if (terminal) return terminal
    completeAttempt(outcome)
    const time =
      timing() ??
      (() => {
        const completed = clock()
        return { started: completed, completed, duration: 0 }
      })()
    const stepUsage = canonical(stepFinish?.usage)
    const finalUsage = canonical(finish?.usage)
    const failedUsage = canonical(providerError?.usage)
    if (stepFinish || finish) {
      const usage = stepUsage
        ? {
            authoritative: stepUsage,
            source: "step-finish" as const,
            ...(finalUsage && !isDeepStrictEqual(stepUsage, finalUsage)
              ? {
                  finalObservation: finalUsage,
                  anomaly: "final-usage-mismatch" as const,
                }
              : {}),
          }
        : !stepFinish && stepStart !== undefined && finalUsage
          ? { authoritative: finalUsage, source: "finish-fallback" as const }
          : undefined
      const owned = accounting(time, usage)
      const projected = compatibility(usage?.authoritative, owned.pricing)
      yield* flush()
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(time.completed),
        assistantMessageID: yield* startAssistant(DateTime.makeUnsafe(time.started)),
        finish: stepFinish?.reason ?? finish!.reason,
        ...projected,
        accounting: owned,
      })
      terminal = "ended"
      return terminal
    }
    const usage = failedUsage ? { authoritative: failedUsage, source: "provider-error" as const } : undefined
    const owned = accounting(time, usage)
    yield* flush()
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: DateTime.makeUnsafe(time.completed),
      assistantMessageID: yield* startAssistant(DateTime.makeUnsafe(time.started)),
      error: {
        type: "unknown",
        message:
          providerError?.message ??
          failureMessage ??
          (outcome === "interrupt" ? "Provider stream interrupted" : "Provider stream ended without a terminal event"),
      },
      accounting: owned,
    })
    terminal = "failed"
    return terminal
  })

  const localSettlementAfterTerminal = (event: LLMEvent) => {
    if (event.type === "tool-result") {
      const tool = tools.get(event.id)
      return event.providerExecuted !== true && tool?.providerExecuted !== true
    }
    if (event.type === "tool-error") return tools.get(event.id)?.providerExecuted !== true
    return false
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    if ((terminal || finish || providerError || stepFinish) && !localSettlementAfterTerminal(event)) {
      const reconciliation = stepFinish && !finish && !providerError && event.type === "finish"
      if (!reconciliation) return yield* Effect.die(`Provider content after terminal: ${event.type}`)
    }
    switch (event.type) {
      case "step-start":
        if (stepStart !== undefined) return yield* Effect.die(`Duplicate provider step start: ${event.index}`)
        stepStart = event.index
        return
      case "text-start":
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta":
        yield* text.append(event.id, event.text)
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID: event.id,
          delta: event.text,
        })
        return
      case "text-end":
        yield* text.end(event.id)
        return
      case "reasoning-start":
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: event.providerMetadata,
        })
        return
      case "reasoning-delta":
        yield* reasoning.append(event.id, event.text)
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          delta: event.text,
        })
        return
      case "reasoning-end":
        yield* reasoning.end(event.id, event.providerMetadata)
        return
      case "tool-input-start":
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* toolInput.append(event.id, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-call": {
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${event.id}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            provider,
          })
          return
        }
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          outputPaths,
          ...(provider.executed ? { result: event.result } : {}),
          provider,
        })
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool error before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: { type: "unknown", message: event.message },
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "step-finish":
        if (stepFinish) return yield* Effect.die("Duplicate provider step finish")
        if (stepStart !== undefined && stepStart !== event.index)
          return yield* Effect.die(`Provider step index changed: ${stepStart} -> ${event.index}`)
        stepFinish = event
        completeAttempt("success")
        return
      case "finish":
        finish = event
        completeAttempt("success")
        return
      case "provider-error":
        providerFailed = true
        providerError = event
        completeAttempt("error")
        return
    }
  })

  return {
    publish,
    flush,
    failUnsettledTools,
    settle,
    startAttempt,
    failAttempt: () => completeAttempt("error"),
    completeRawAttempt: (outcome: Exclude<Settlement, "success">) => completeAttempt(outcome),
    hasAssistantStarted: () => assistantStarted,
    hasAuthoritativeSuccess: () => stepFinish !== undefined || finish !== undefined,
    hasProviderError: () => providerFailed,
    startAssistant,
    plannedAssistantMessageID: () => assistantMessageID,
    assistantMessageID: assistantMessageIDForTool,
  }
}
