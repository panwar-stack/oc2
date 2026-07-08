export * as SessionCompoundSynthesizer from "./synthesizer"

import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Effect, Exit } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "./config"
import { SessionCompoundToolPolicy } from "./tool-policy"
import type { SessionCompoundJudge } from "./judge"
import type { BranchResult } from "./runner"
import type { TaskPromptOps } from "@/tool/task"

export type Result = {
  output: string
}

export const run = Effect.fn("SessionCompoundSynthesizer.run")(function* (input: {
  sessionID: SessionID
  prompt: string
  synthesizer: SessionCompoundConfig.Synthesizer
  branches: BranchResult
  judge: SessionCompoundJudge.Result
  promptOps: TaskPromptOps
  abort?: AbortSignal
}) {
  yield* interruptIfAborted(input.abort)
  const sessions = yield* Session.Service
  const parent = yield* sessions.get(input.sessionID)
  const model = SessionCompoundConfig.parseModel(input.synthesizer.model)
  const toolPolicy = input.synthesizer.toolPolicy ?? "none"
  const child = yield* sessions.create({
    parentID: input.sessionID,
    title: "Compound synthesizer",
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(input.synthesizer.variant ? { variant: input.synthesizer.variant } : {}),
    },
    permission: SessionCompoundToolPolicy.resolveChildPermission(parent.permission ?? [], toolPolicy),
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
        yield* interruptIfAborted(input.abort)
        const result = yield* input.promptOps.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: { providerID: model.providerID, modelID: model.modelID },
          ...(input.synthesizer.variant ? { variant: input.synthesizer.variant } : {}),
          tools: SessionCompoundToolPolicy.resolvePromptTools(toolPolicy, child.permission ?? []),
          parts,
        })
        yield* interruptIfAborted(input.abort)

        if (result.info.role === "assistant" && result.info.error) {
          return yield* Effect.fail(new Error(errorMessage(result.info.error)))
        }
        return { output: outputText(result) }
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

export function buildPrompt(input: {
  prompt: string
  synthesizer: SessionCompoundConfig.Synthesizer
  branches: BranchResult
  judge: SessionCompoundJudge.Result
}) {
  return [
    "Synthesize one final answer grounded in the original request, successful branch outputs, judge analysis, and explicit branch failures.",
    "You are the only stage that may make final workspace edits when tools permit.",
    "Use judge output and branch findings as inputs, but independently verify before editing.",
    ...(input.synthesizer.prompt ? ["", "Synthesizer guidance:", input.synthesizer.prompt] : []),
    "",
    "Original request:",
    input.prompt,
    "",
    "Successful branch outputs:",
    ...input.branches.successes.map((branch) =>
      [
        `<branch index="${branch.index}" model="${branch.model}" session="${branch.sessionID}">`,
        branch.output,
        "</branch>",
      ].join("\n"),
    ),
    "",
    "Branch failures:",
    ...input.branches.failures.map((branch) =>
      [`<failure index="${branch.index}" model="${branch.model}">`, branch.reason, "</failure>"].join("\n"),
    ),
    "",
    "Judge result:",
    JSON.stringify(input.judge, null, 2),
  ].join("\n")
}

function outputText(result: SessionV1.WithParts) {
  return result.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function errorMessage(error: NonNullable<SessionV1.Assistant["error"]>) {
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return error.name
}
