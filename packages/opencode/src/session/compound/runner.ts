export * as SessionCompound from "./runner"

import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Exit } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "./config"
import type { TaskPromptOps } from "@/tool/task"

const readonlyTools = {
  "*": false,
  read: true,
  grep: true,
  glob: true,
  webfetch: true,
  websearch: true,
  lsp: true,
}

const noTools = { "*": false }

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

export type Result = {
  successes: BranchSuccess[]
  failures: BranchFailure[]
}

export const run = Effect.fn("SessionCompound.run")(function* (input: {
  sessionID: SessionID
  prompt: string
  config: SessionCompoundConfig.Config
  agent?: string
  promptOps: TaskPromptOps
  abort?: AbortSignal
}) {
  const results = yield* Effect.forEach(
    input.config.branches,
    (branch, index) => runBranch({ ...input, branch, index }),
    { concurrency: "unbounded" },
  )

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
}) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.get(input.sessionID)
  const model = SessionCompoundConfig.parseModel(input.branch.model)
  const agent = input.branch.agent ?? parent.agent ?? input.agent
  const child = yield* sessions.create({
    parentID: input.sessionID,
    title: `Compound branch #${input.index + 1}`,
    agent,
    model: { id: model.modelID, providerID: model.providerID },
    permission: branchPermission(parent.permission ?? []),
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
        const result = yield* promptBranch(input, child.id, model, agent).pipe(
          Effect.timeoutOption(input.branch.timeout ?? input.config.limits.timeout),
        )
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
        return {
          type: "failure" as const,
          value: {
            index: input.index,
            sessionID: child.id,
            model: input.branch.model,
            agent,
            reason: `Branch timed out after ${input.branch.timeout ?? input.config.limits.timeout}ms`,
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
  },
  sessionID: SessionID,
  model: ReturnType<typeof SessionCompoundConfig.parseModel>,
  agent: string | undefined,
) {
  return Effect.gen(function* () {
    const parts = yield* input.promptOps.resolvePromptParts(branchPrompt(input.prompt, input.branch.prompt))
    return yield* input.promptOps.prompt({
      messageID: MessageID.ascending(),
      sessionID,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      agent,
      tools: input.branch.toolPolicy === "none" ? noTools : readonlyTools,
      parts,
    })
  })
}

function branchPrompt(prompt: string, guidance?: string) {
  if (!guidance) return prompt
  return [prompt, "", "Branch guidance:", guidance].join("\n")
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

function branchPermission(parent: PermissionV1.Ruleset) {
  return parent.filter((rule) => rule.action === "deny" || (rule.permission === "external_directory" && rule.action === "allow"))
}
