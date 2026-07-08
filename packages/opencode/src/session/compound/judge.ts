export * as SessionCompoundJudge from "./judge"

import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "./config"
import { SessionCompoundToolPolicy } from "./tool-policy"
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

export const run = Effect.fn("SessionCompoundJudge.run")(function* (input: {
  sessionID: SessionID
  judge: SessionCompoundConfig.Judge
  branches: BranchResult
  promptOps: TaskPromptOps
  abort?: AbortSignal
  compoundRunID?: string
}) {
  yield* interruptIfAborted(input.abort)
  const sessions = yield* Session.Service
  const parent = yield* sessions.get(input.sessionID)
  const roots = yield* sessions.listRoots(input.sessionID)
  const model = SessionCompoundConfig.parseModel(input.judge.model)
  const toolPolicy = input.judge.toolPolicy ?? "none"
  const role = {
    type: "judge" as const,
    tempDir: SessionCompoundToolPolicy.tempDirectory({
      parentSessionID: input.sessionID,
      compoundRunID: input.compoundRunID ?? crypto.randomUUID(),
      role: { type: "judge" },
      rootDirectories: roots.map((root) => root.directory),
    }),
  }
  const child = yield* sessions.create({
    parentID: input.sessionID,
    title: "Compound judge",
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(input.judge.variant ? { variant: input.judge.variant } : {}),
    },
    permission: SessionCompoundToolPolicy.resolveChildPermission(parent.permission ?? [], toolPolicy, {
      role,
      root: parent.directory,
    }),
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
        const parts = yield* input.promptOps.resolvePromptParts(buildPrompt({ ...input, tempDir: role.tempDir }))
        yield* interruptIfAborted(input.abort)
        const result = yield* input.promptOps.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: { providerID: model.providerID, modelID: model.modelID },
          ...(input.judge.variant ? { variant: input.judge.variant } : {}),
          tools: SessionCompoundToolPolicy.resolvePromptTools(toolPolicy, child.permission ?? [], role),
          parts,
        })
        yield* interruptIfAborted(input.abort)

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

function interruptIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) return Effect.interrupt
  return Effect.void
}

export function buildPrompt(input: { judge: SessionCompoundConfig.Judge; branches: BranchResult; tempDir: string }) {
  return [
    "Evaluate branch outputs and produce structured guidance for the synthesizer.",
    "Produce structured analysis only, not a final answer.",
    "Do not edit workspace files.",
    `If scratch files are needed, write only under ${input.tempDir}.`,
    'Return only JSON matching this shape: { consensus: string[], contradictions: string[], uniqueInsights: { branch: string, insight: string }[], blindSpots: string[], failures: { branch: string, reason: string }[], confidence: "low" | "medium" | "high" }.',
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
