export * as SessionCompound from "./runner"

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit, Option } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "./config"
import { SessionCompoundJudge } from "./judge"
import { SessionCompoundSynthesizer } from "./synthesizer"
import { SessionCompoundToolPolicy } from "./tool-policy"
import type { TaskPromptOps } from "@/tool/task"

export type BranchSuccess = {
  index: number
  sessionID: SessionID
  model: string
  agent?: string
  output: string
}

export type BranchFailure = {
  index: number
  sessionID?: SessionID
  model: string
  agent?: string
  reason: string
  timedOut?: boolean
}

export type BranchResult = {
  successes: BranchSuccess[]
  failures: BranchFailure[]
}

export type RunResult = {
  output: string
  branches: BranchResult
  judge: SessionCompoundJudge.Result
  metadata: {
    branchCount: number
    successfulBranchCount: number
    failedBranchCount: number
    judgeModel: string
    synthesizerModel: string
  }
}

export const run = Effect.fn("SessionCompound.run")(function* (input: {
  sessionID: SessionID
  prompt: string
  config: SessionCompoundConfig.Config
  agent?: string
  promptOps: TaskPromptOps
  abort?: AbortSignal
  mode?: "logu"
  loguRunID?: string
}) {
  SessionCompoundToolPolicy.validate(input)
  yield* interruptIfAborted(input.abort)
  const compoundRunID = input.loguRunID ?? crypto.randomUUID()
  const branches = yield* runBranches({ ...input, compoundRunID })
  yield* interruptIfAborted(input.abort)
  if (branches.successes.length === 0) {
    return yield* Effect.fail(
      new Error(`All compound branches failed: ${branches.failures.map((failure) => failure.reason).join("; ")}`),
    )
  }

  const judge = yield* SessionCompoundJudge.run({ ...input, branches, judge: input.config.judge, compoundRunID })
  yield* interruptIfAborted(input.abort)
  const synthesis = yield* SessionCompoundSynthesizer.run({
    ...input,
    branches,
    judge,
    synthesizer: input.config.synthesizer,
  })
  yield* interruptIfAborted(input.abort)

  return {
    output: synthesis.output,
    branches,
    judge,
    metadata: {
      branchCount: input.config.branches.length,
      successfulBranchCount: branches.successes.length,
      failedBranchCount: branches.failures.length,
      judgeModel: input.config.judge.model,
      synthesizerModel: input.config.synthesizer.model,
    },
  }
})

export const runBranches = Effect.fn("SessionCompound.runBranches")(function* (input: {
  sessionID: SessionID
  prompt: string
  config: SessionCompoundConfig.Config
  agent?: string
  promptOps: TaskPromptOps
  abort?: AbortSignal
  mode?: "logu"
  loguRunID?: string
  compoundRunID?: string
}) {
  SessionCompoundToolPolicy.validate(input)
  yield* interruptIfAborted(input.abort)
  const compoundRunID = input.compoundRunID ?? input.loguRunID ?? crypto.randomUUID()
  const results = yield* Effect.forEach(
    input.config.branches,
    (branch, index) => runBranch({ ...input, branch, index, compoundRunID }),
    { concurrency: "unbounded" },
  )
  yield* interruptIfAborted(input.abort)

  return {
    successes: results.filter((result) => result.type === "success").map((result) => result.value),
    failures: results.filter((result) => result.type === "failure").map((result) => result.value),
  }
})

const runBranch = Effect.fn("SessionCompound.runBranch")(function* (input: {
  sessionID: SessionID
  prompt: string
  config: SessionCompoundConfig.Config
  branch: SessionCompoundConfig.Branch
  index: number
  agent?: string
  promptOps: TaskPromptOps
  abort?: AbortSignal
  mode?: "logu"
  loguRunID?: string
  compoundRunID: string
}) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.get(input.sessionID)
  const model = SessionCompoundConfig.parseModel(input.branch.model)
  const agent = input.branch.agent ?? parent.agent ?? input.agent
  const role = {
    type: "branch" as const,
    index: input.index,
    tempDir: SessionCompoundToolPolicy.tempDirectory({
      parentSessionID: input.sessionID,
      compoundRunID: input.compoundRunID,
      role: { type: "branch", index: input.index },
    }),
  }
  const child = yield* sessions.create({
    parentID: input.sessionID,
    title: input.mode === "logu" ? `Logu branch #${input.index + 1}` : `Compound branch #${input.index + 1}`,
    agent,
    model: {
      id: model.modelID,
      providerID: model.providerID,
      ...(input.branch.variant ? { variant: input.branch.variant } : {}),
    },
    ...(input.mode === "logu"
      ? {
          metadata: {
            logu: {
              stage: "branch",
              index: input.index,
              model: input.branch.model,
              ...(input.branch.variant ? { variant: input.branch.variant } : {}),
              parentRunID: input.loguRunID ?? input.sessionID,
              parentSessionID: input.sessionID,
            },
          },
        }
      : {}),
    permission: SessionCompoundToolPolicy.resolveChildPermission(parent.permission ?? [], input.branch.toolPolicy, input.mode, {
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
        const timeout = input.branch.timeout ?? input.config.limits.timeout
        const result = yield* (timeout
          ? promptBranch(input, child.id, child.permission ?? [], model, agent, role).pipe(Effect.timeoutOption(timeout))
          : promptBranch(input, child.id, child.permission ?? [], model, agent, role).pipe(Effect.map(Option.some)))
        if (result._tag === "Some") {
          if (result.value.info.role === "assistant" && result.value.info.error) {
            return {
              type: "failure" as const,
              value: {
                index: input.index,
                sessionID: child.id,
                model: input.branch.model,
                agent,
                reason: errorMessage(result.value.info.error),
              },
            }
          }

          return {
            type: "success" as const,
            value: {
              index: input.index,
              sessionID: child.id,
              model: input.branch.model,
              agent,
              output: outputText(result.value),
            },
          }
        }

        yield* cancel
        if (input.mode === "logu") {
          yield* sessions.setMetadata({
            sessionID: child.id,
            metadata: {
              ...child.metadata,
              logu: {
                ...child.metadata?.logu,
                timedOut: true,
                timeoutMS: timeout,
              },
            },
          })
        }
        return {
          type: "failure" as const,
          value: {
            index: input.index,
            sessionID: child.id,
            model: input.branch.model,
            agent,
            reason: `Branch timed out after ${timeout}ms`,
            timedOut: true,
          },
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt
            const error = Cause.squash(cause)
            return {
              type: "failure" as const,
              value: {
                index: input.index,
                sessionID: child.id,
                model: input.branch.model,
                agent,
                reason: error instanceof Error ? error.message : String(error),
              },
            }
          }),
        ),
      ),
    (_, exit) =>
      Effect.gen(function* () {
        if (Exit.hasInterrupts(exit)) yield* cancel
      }).pipe(Effect.ensuring(Effect.sync(() => input.abort?.removeEventListener("abort", onAbort)))),
  )
})

function promptBranch(
  input: {
    prompt: string
    branch: SessionCompoundConfig.Branch
    index: number
    promptOps: TaskPromptOps
    abort?: AbortSignal
    mode?: "logu"
  },
  sessionID: SessionID,
  permission: PermissionV1.Ruleset,
  model: ReturnType<typeof SessionCompoundConfig.parseModel>,
  agent: string | undefined,
  role: Extract<SessionCompoundToolPolicy.CompoundRole, { type: "branch" }>,
) {
  return Effect.gen(function* () {
    const parts = yield* input.promptOps.resolvePromptParts(branchPrompt(input.prompt, input.branch.prompt, role.tempDir))
    yield* interruptIfAborted(input.abort)
    const result = yield* input.promptOps.prompt({
      messageID: MessageID.ascending(),
      sessionID,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      ...(input.branch.variant ? { variant: input.branch.variant } : {}),
      agent,
      tools: SessionCompoundToolPolicy.resolvePromptTools(input.branch.toolPolicy, input.mode, permission, role),
      parts,
    })
    yield* interruptIfAborted(input.abort)
    return result
  })
}

function interruptIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) return Effect.interrupt
  return Effect.void
}

function branchPrompt(prompt: string, guidance: string | undefined, tempDir: string) {
  return [
    "You are a local fusion branch.",
    "Use tools to research and propose changes when tools are available.",
    "Do not edit workspace files.",
    `If scratch files are needed, write only under ${tempDir}.`,
    "Return recommended edits as text, file paths, and rationale.",
    "",
    "Original request:",
    prompt,
    ...(guidance ? ["", "Branch guidance:", guidance] : []),
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
