export * as SessionCompoundJudge from "./judge"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "./config"
import type { BranchResult } from "./runner"
import type { TaskPromptOps } from "@/tool/task"

export const Result = Schema.Struct({
  consensus: Schema.Array(Schema.String),
  contradictions: Schema.Array(Schema.String),
  uniqueInsights: Schema.Array(
    Schema.Struct({
      branch: Schema.String,
      insight: Schema.String,
    }),
  ),
  blindSpots: Schema.Array(Schema.String),
  failures: Schema.Array(
    Schema.Struct({
      branch: Schema.String,
      reason: Schema.String,
    }),
  ),
  confidence: Schema.Literals(["low", "medium", "high"]),
})
export type Result = Schema.Schema.Type<typeof Result>

const decodeResult = Schema.decodeUnknownSync(Result)
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const toolsDisabled = { "*": false }

export const run = Effect.fn("SessionCompoundJudge.run")(function* (input: {
  sessionID: SessionID
  judge: SessionCompoundConfig.Judge
  branches: BranchResult
  promptOps: TaskPromptOps
  abort?: AbortSignal
}) {
  const sessions = yield* Session.Service
  const model = SessionCompoundConfig.parseModel(input.judge.model)
  const child = yield* sessions.create({
    parentID: input.sessionID,
    title: "Compound judge",
    model: { id: model.modelID, providerID: model.providerID },
  })
  const runCancel = yield* EffectBridge.make()
  const cancel = input.promptOps.cancel(child.id)

  function onAbort() {
    runCancel.fork(cancel)
  }

  return yield* Effect.acquireUseRelease(
    Effect.sync(() => input.abort?.addEventListener("abort", onAbort)),
    () =>
      Effect.gen(function* () {
        const parts = yield* input.promptOps.resolvePromptParts(buildPrompt(input))
        const result = yield* input.promptOps.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: { providerID: model.providerID, modelID: model.modelID },
          tools: toolsDisabled,
          parts,
        })

        if (result.info.role === "assistant" && result.info.error) {
          return yield* Effect.fail(new Error(errorMessage(result.info.error)))
        }
        return decodeJudgeResult(result)
      }),
    (_, exit) =>
      Effect.gen(function* () {
        if (Exit.hasInterrupts(exit)) yield* cancel
      }).pipe(Effect.ensuring(Effect.sync(() => input.abort?.removeEventListener("abort", onAbort)))),
  )
})

export function buildPrompt(input: { judge: SessionCompoundConfig.Judge; branches: BranchResult }) {
  return [
    "You are judging multiple branch responses. Produce structured analysis only, not a final answer.",
    "Return only JSON matching this shape: { consensus: string[], contradictions: string[], uniqueInsights: { branch: string, insight: string }[], blindSpots: string[], failures: { branch: string, reason: string }[], confidence: \"low\" | \"medium\" | \"high\" }.",
    ...(input.judge.prompt ? ["", "Judge guidance:", input.judge.prompt] : []),
    "",
    "Successful branches:",
    ...input.branches.successes.map((branch) =>
      [
        `<branch index="${branch.index}" model="${branch.model}" session="${branch.sessionID}">`,
        branch.output,
        "</branch>",
      ].join("\n"),
    ),
    "",
    "Failed branches:",
    ...input.branches.failures.map((branch) =>
      [`<failure index="${branch.index}" model="${branch.model}">`, branch.reason, "</failure>"].join("\n"),
    ),
  ].join("\n")
}

function decodeJudgeResult(result: SessionV1.WithParts) {
  if (result.info.role === "assistant" && result.info.structured) return decodeResult(result.info.structured)
  const text = result.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const json = decodeJson(text)
  if (Option.isNone(json)) throw new Error("Judge did not return valid JSON")
  return decodeResult(json.value)
}

function errorMessage(error: NonNullable<SessionV1.Assistant["error"]>) {
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return error.name
}
