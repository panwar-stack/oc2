import { ConfigFugu } from "@opencode-ai/core/config/fugu"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Log } from "@opencode-ai/core/util/log"
import type { LLMEvent as LLMEventType } from "@opencode-ai/llm"
import { Provider } from "@/provider/provider"
import { Effect, Stream } from "effect"
import type { ModelMessage } from "ai"
import type { StreamRequest } from "../llm"

const SYNTHESIZER_INSTRUCTION =
  "You are the final response synthesizer for a proxy model. You will receive the original conversation context and multiple candidate responses from branch models. Produce a single final answer for the caller. Preserve the caller intent, follow the original system and developer instructions, correct errors where branch responses disagree, and do not mention that multiple models were used unless the caller explicitly asks about the implementation. Do not simply concatenate branch responses; reconcile them into one answer."

const log = Log.create({ service: "fugu" })

type Target = ConfigFugu.Branch | ConfigFugu.Judge | ConfigFugu.Synthesizer

type ResolvedTarget = {
  readonly index?: number
  readonly role: "branch" | "judge" | "synthesizer"
  readonly config: Target
  readonly label: string
  readonly parsed: {
    readonly providerID: ProviderV2.ID
    readonly modelID: ModelV2.ID
  }
  readonly model: Provider.Model
}

type BranchSuccess = {
  readonly index: number
  readonly model: string
  readonly variant?: string
  readonly status: "success"
  readonly text: string
}

type BranchFailure = {
  readonly index: number
  readonly model: string
  readonly variant?: string
  readonly status: "error"
  readonly error: string
}

type BranchResult = BranchSuccess | BranchFailure

type JudgeResult = {
  readonly model: string
  readonly variant?: string
  readonly status: "success" | "error"
  readonly text?: string
  readonly error?: string
}

export type Execute = (input: StreamRequest) => Stream.Stream<LLMEventType, unknown, never>

export const isSelected = (model: Provider.Model) => model.providerID === "fugu" && model.id === "fugu"

export function run(
  input: StreamRequest,
  config: ConfigFugu.Info | undefined,
  provider: Provider.Interface,
  execute: Execute,
): Effect.Effect<Stream.Stream<LLMEventType, unknown, never>, unknown> {
  return Effect.gen(function* () {
    const resolved = yield* validate(config, provider)
    yield* Effect.logInfo("fugu selected").pipe(
      Effect.annotateLogs({
        "fugu.branches": resolved.branches.length,
        "fugu.synthesizer": targetLabel(resolved.synthesizer),
      }),
    )

    const results = yield* Effect.forEach(
      resolved.branches,
      (branch) => collectBranch(input, branch, execute),
      { concurrency: "unbounded" },
    )
    const successes = results.filter((result): result is BranchSuccess => result.status === "success")
    if (successes.length === 0) {
      yield* Effect.logWarning("all fugu branches failed").pipe(
        Effect.annotateLogs({ "fugu.branch.failures": results.map(branchSummary).join("; ") }),
      )
      return yield* Effect.fail(new Error("All fugu branches failed"))
    }

    const judge = resolved.judge ? yield* collectJudge(input, resolved.judge, results, execute) : undefined

    yield* Effect.logInfo("fugu synthesizer selected").pipe(
      Effect.annotateLogs({
        "fugu.synthesizer": targetLabel(resolved.synthesizer),
        "fugu.branch.successes": successes.length,
        "fugu.branch.failures": results.length - successes.length,
      }),
    )

    const stream = execute({
      ...input,
      model: resolved.synthesizer.model,
      user: withTargetModel(input, resolved.synthesizer),
      system: [...input.system, SYNTHESIZER_INSTRUCTION],
      messages: [...input.messages, synthesizerMessage(results, judge)],
    })
    const synthesizerOutput: string[] = []
    return stream.pipe(
      Stream.tap((event) => {
        if (event.type === "text-delta") {
          synthesizerOutput.push(event.text)
          return Effect.void
        }
        if (event.type === "finish") {
          logTargetOutput(input, resolved.synthesizer, { status: "success", text: synthesizerOutput.join("") })
          return Effect.logInfo("fugu synthesizer finished").pipe(
            Effect.annotateLogs({ "fugu.synthesizer": targetLabel(resolved.synthesizer) }),
          )
        }
        if (event.type === "provider-error") {
          logTargetOutput(input, resolved.synthesizer, { status: "error", error: event.message })
          return Effect.logError("fugu synthesizer failed").pipe(
            Effect.annotateLogs({ "fugu.synthesizer": targetLabel(resolved.synthesizer), "fugu.error": event.message }),
          )
        }
        return Effect.void
      }),
      Stream.tapError((error) =>
        Effect.sync(() => logTargetOutput(input, resolved.synthesizer, { status: "error", error: errorMessage(error) })).pipe(
          Effect.andThen(
            Effect.logError("fugu synthesizer failed").pipe(
              Effect.annotateLogs({
                "fugu.synthesizer": targetLabel(resolved.synthesizer),
                "fugu.error": errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    )
  })
}

function validate(config: ConfigFugu.Info | undefined, provider: Provider.Interface) {
  return Effect.gen(function* () {
    if (!config) {
      return yield* Effect.fail(
        new Error("Fugu configuration is missing; configure fugu.branches and fugu.synthesizer before selecting fugu/fugu"),
      )
    }
    if (!config.branches || config.branches.length === 0) {
      return yield* Effect.fail(new Error("Fugu configuration requires at least one fugu.branches item"))
    }
    if (!config.synthesizer) {
      return yield* Effect.fail(new Error("Fugu configuration requires fugu.synthesizer"))
    }

    const branches = yield* Effect.forEach(
      config.branches,
      (branch, index) => resolveTarget(provider, "branch", branch, index),
      { concurrency: "unbounded" },
    )
    if (config.judge) {
      const judge = yield* resolveTarget(provider, "judge", config.judge)
      const synthesizer = yield* resolveTarget(provider, "synthesizer", config.synthesizer)
      return { branches, judge, synthesizer }
    }
    const synthesizer = yield* resolveTarget(provider, "synthesizer", config.synthesizer)
    return { branches, synthesizer }
  })
}

function resolveTarget(provider: Provider.Interface, role: ResolvedTarget["role"], target: Target, index?: number) {
  return Effect.gen(function* () {
    const label = target.model?.trim()
    if (!label) {
      return yield* Effect.fail(new Error(`Fugu ${role} target model is required`))
    }

    const [providerPart, ...modelParts] = label.split("/")
    const modelPart = modelParts.join("/")
    if (!providerPart || !modelPart) {
      return yield* Effect.fail(new Error(`Fugu ${role} target ${label} must use provider/model`))
    }

    const parsed = {
      providerID: ProviderV2.ID.make(providerPart),
      modelID: ModelV2.ID.make(modelPart),
    }
    if (parsed.providerID === "fugu" && parsed.modelID === "fugu") {
      return yield* Effect.fail(new Error(`Fugu ${role} target cannot resolve to fugu/fugu`))
    }
    const model = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(
      Effect.catchTag("ProviderModelNotFoundError", () =>
        Effect.fail(new Error(`Fugu ${role} target ${label} could not be resolved`)),
      ),
    )
    if (model.required_variant && !model.variants?.[model.required_variant]) {
      return yield* Effect.fail(
        new Error(`Fugu ${role} target ${label} requires unavailable variant ${model.required_variant}`),
      )
    }
    if (model.required_variant && !target.variant) {
      return yield* Effect.fail(new Error(`Fugu ${role} target ${label} requires variant ${model.required_variant}`))
    }
    if (model.required_variant && target.variant !== model.required_variant) {
      return yield* Effect.fail(new Error(`Fugu ${role} target ${label} requires variant ${model.required_variant}`))
    }
    if (target.variant && !model.variants?.[target.variant]) {
      return yield* Effect.fail(new Error(`Fugu ${role} target ${label} does not support variant ${target.variant}`))
    }
    return { index, role, config: target, label, parsed, model } satisfies ResolvedTarget
  })
}

function collectBranch(input: StreamRequest, branch: ResolvedTarget, execute: Execute) {
  return execute({
    ...input,
    model: branch.model,
    user: withTargetModel(input, branch),
    tools: {},
    toolChoice: "none",
    forbidImplicitTools: true,
  }).pipe(
    Stream.runCollect,
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(branchFailure(branch, errorMessage(error))),
      onSuccess: (chunk) => Effect.succeed(branchResult(branch, Array.from(chunk))),
    }),
    Effect.tap((result) =>
      result.status === "success"
        ? Effect.sync(() => logBranchResult(input, branch, result)).pipe(
            Effect.andThen(
              Effect.logInfo("fugu branch finished").pipe(
                Effect.annotateLogs({ "fugu.branch": targetLabel(branch), "fugu.branch.index": branch.index ?? 0 }),
              ),
            ),
          )
        : Effect.sync(() => logBranchResult(input, branch, result)).pipe(
            Effect.andThen(
              Effect.logWarning("fugu branch failed").pipe(
                Effect.annotateLogs({
                  "fugu.branch": targetLabel(branch),
                  "fugu.branch.index": branch.index ?? 0,
                  "fugu.error": result.error,
                }),
              ),
            ),
          ),
    ),
  )
}

function collectJudge(
  input: StreamRequest,
  judge: ResolvedTarget,
  results: BranchResult[],
  execute: Execute,
): Effect.Effect<JudgeResult> {
  return execute({
    ...input,
    model: judge.model,
    user: withTargetModel(input, judge),
    tools: {},
    toolChoice: "none",
    forbidImplicitTools: true,
    messages: [...input.messages, judgeMessage(results)],
  }).pipe(
    Stream.runCollect,
    Effect.match({
      onFailure: (error) => judgeResult(judge, { status: "error", error: errorMessage(error) }),
      onSuccess: (chunk) => judgeResult(judge, resultOutput(Array.from(chunk))),
    }),
    Effect.tap((result) => Effect.sync(() => logTargetOutput(input, judge, result))),
  )
}

function branchResult(branch: ResolvedTarget, events: LLMEventType[]): BranchResult {
  const providerError = events.find((event) => event.type === "provider-error")
  if (providerError) return branchFailure(branch, providerError.message)

  const text = events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("")
  if (!text.trim()) return branchFailure(branch, "Branch produced no text")

  return {
    index: branch.index ?? 0,
    model: branch.label,
    variant: branch.config.variant,
    status: "success",
    text,
  }
}

function branchFailure(branch: ResolvedTarget, error: string): BranchFailure {
  return {
    index: branch.index ?? 0,
    model: branch.label,
    variant: branch.config.variant,
    status: "error",
    error,
  }
}

function judgeResult(judge: ResolvedTarget, result: { status: "success"; text: string } | { status: "error"; error: string }) {
  return {
    model: judge.label,
    variant: judge.config.variant,
    ...result,
  } satisfies JudgeResult
}

function withTargetModel(input: StreamRequest, target: ResolvedTarget) {
  return {
    ...input.user,
    model: {
      providerID: target.parsed.providerID,
      modelID: target.parsed.modelID,
      variant: target.config.variant,
    },
  }
}

function synthesizerMessage(results: BranchResult[], judge?: JudgeResult): ModelMessage {
  return {
    role: "user",
    content: [
      "Synthesize the final response using the original conversation context and these fugu branch results.",
      "Branch results:",
      JSON.stringify(
        results.map((result) => ({
          index: result.index,
          model: result.model,
          variant: result.variant,
          status: result.status,
          ...(result.status === "success" ? { text: result.text } : { error: result.error }),
        })),
        null,
        2,
      ),
      ...(judge ? ["Judge result:", JSON.stringify(judge, null, 2)] : []),
    ].join("\n"),
  }
}

function judgeMessage(results: BranchResult[]): ModelMessage {
  return {
    role: "user",
    content: [
      "Evaluate these fugu branch results and produce concise guidance for the final synthesizer.",
      "Do not edit files. Return analysis only.",
      "Branch results:",
      JSON.stringify(results, null, 2),
    ].join("\n"),
  }
}

function resultOutput(events: LLMEventType[]): { status: "success"; text: string } | { status: "error"; error: string } {
  const providerError = events.find((event) => event.type === "provider-error")
  if (providerError) return { status: "error", error: providerError.message }

  const text = events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("")
  if (!text.trim()) return { status: "error", error: "Model produced no text" }
  return { status: "success", text }
}

function logBranchResult(input: StreamRequest, branch: ResolvedTarget, result: BranchResult) {
  logTargetOutput(input, branch, result.status === "success" ? { status: "success", text: result.text } : result)
}

function logTargetOutput(
  input: StreamRequest,
  target: ResolvedTarget,
  result: { status: "success"; text: string } | { status: "error"; error: string },
) {
  log.info("fugu model output", {
    "session.id": input.sessionID,
    "fugu.role": target.role,
    "fugu.target": targetLabel(target),
    "fugu.branch.index": target.index,
    "fugu.output": result,
  })
}

function targetLabel(target: ResolvedTarget) {
  return target.config.variant ? `${target.label}@${target.config.variant}` : target.label
}

function branchSummary(result: BranchResult) {
  if (result.status === "success") return `${result.model}: success`
  return `${result.model}: ${result.error}`
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export * as LLMFugu from "./fugu"
