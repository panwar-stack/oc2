import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "../../src/session/compound/config"
import { SessionCompound } from "../../src/session/compound/runner"
import type { SessionPrompt } from "../../src/session/prompt"
import type { TaskPromptOps } from "../../src/tool/task"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(BackgroundJob.defaultLayer, EventV2Bridge.defaultLayer, Session.defaultLayer, Database.defaultLayer, RuntimeFlags.layer({})),
)

type AssistantWithParts = Omit<SessionV1.WithParts, "info"> & { info: SessionV1.Assistant }

function reply(input: SessionPrompt.PromptInput, text: string): AssistantWithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? SessionCompoundConfig.parseModel("test/default").modelID,
      providerID: input.model?.providerID ?? SessionCompoundConfig.parseModel("test/default").providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function errorReply(input: SessionPrompt.PromptInput, message: string): SessionV1.WithParts {
  const result = reply(input, "")
  return {
    ...result,
    info: {
      ...result.info,
      error: { name: "UnknownError", data: { message } },
    },
  }
}

function config(input?: Record<string, unknown>): SessionCompoundConfig.Config {
  return SessionCompoundConfig.parse({
    branches: [{ model: "test/branch-a" }, { model: "test/branch-b", toolPolicy: "none" }],
    judge: { model: "test/judge" },
    synthesizer: { model: "test/synth" },
    ...input,
  })
}

function stubOps(input?: {
  onPrompt?: (input: SessionPrompt.PromptInput) => void
  onCancel?: (sessionID: SessionID) => void
  text?: (input: SessionPrompt.PromptInput) => string
}): TaskPromptOps {
  return {
    cancel: (sessionID) => Effect.sync(() => input?.onCancel?.(sessionID)),
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (prompt) =>
      Effect.sync(() => {
        input?.onPrompt?.(prompt)
        return reply(prompt, input?.text?.(prompt) ?? String(prompt.model?.modelID))
      }),
    wake: (sessionID) => Effect.succeed(reply({ sessionID, parts: [] }, "done")),
  }
}

describe("session compound runner", () => {
  it.instance("runs branches and returns outputs with child sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent", agent: "build" })
      const prompts: SessionPrompt.PromptInput[] = []
      const result = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "Compare options",
        config: config(),
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }),
      })
      const children = yield* sessions.children(parent.id)

      expect(result.failures).toEqual([])
      expect(result.successes.map((success) => success.output)).toEqual(["branch-a", "branch-b"])
      expect(children).toHaveLength(2)
      expect(children.every((child) => child.parentID === parent.id)).toBe(true)
      expect(prompts.map((prompt) => String(prompt.model?.modelID))).toEqual(["branch-a", "branch-b"])
      expect(prompts.map((prompt) => prompt.agent)).toEqual(["build", "build"])
    }),
  )

  it.instance("runs branch prompts concurrently", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.Scope
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            if (String(input.model?.modelID) === "branch-a") yield* Deferred.succeed(firstStarted, undefined)
            if (String(input.model?.modelID) === "branch-b") yield* Deferred.succeed(secondStarted, undefined)
            yield* Deferred.await(release)
            return reply(input, String(input.model?.modelID))
          }),
      }
      const fiber = yield* SessionCompound.run({ sessionID: parent.id, prompt: "go", config: config(), promptOps }).pipe(
        Effect.forkIn(scope),
      )

      yield* Deferred.await(firstStarted)
      yield* Deferred.await(secondStarted)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)

      expect(result.successes).toHaveLength(2)
    }),
  )

  it.instance("records partial branch failures", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const result = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config(),
        promptOps: {
          ...stubOps(),
          prompt: (input) => {
            if (String(input.model?.modelID) === "branch-b") return Effect.die(new Error("branch failed"))
            return Effect.succeed(reply(input, "ok"))
          },
        },
      })

      expect(result.successes).toHaveLength(1)
      expect(result.failures).toMatchObject([{ index: 1, model: "test/branch-b", reason: "branch failed" }])
    }),
  )

  it.instance("records assistant error results as branch failures", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const result = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/error" }], limits: { maxBranches: 1 } }),
        promptOps: {
          ...stubOps(),
          prompt: (input) => Effect.succeed(errorReply(input, "provider failed")),
        },
      })

      expect(result.successes).toEqual([])
      expect(result.failures).toMatchObject([{ index: 0, model: "test/error", reason: "provider failed" }])
    }),
  )

  it.instance("times out and cancels hanging branches", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const cancelled: SessionID[] = []
      const result = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/slow", timeout: 1 }], limits: { timeout: 50, maxBranches: 1 } }),
        promptOps: {
          ...stubOps({ onCancel: (sessionID) => cancelled.push(sessionID) }),
          prompt: () => Effect.never,
        },
      })

      expect(result.successes).toEqual([])
      expect(result.failures).toMatchObject([{ index: 0, model: "test/slow", timedOut: true }])
      expect(cancelled).toHaveLength(1)
    }),
  )

  it.instance("applies safe branch tool policies", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config(),
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }),
      })

      expect(prompts[0]?.tools).toMatchObject({
        "*": false,
        read: true,
        grep: true,
        glob: true,
        webfetch: true,
        websearch: true,
        lsp: true,
      })
      expect(prompts[1]?.tools).toEqual({ "*": false })
    }),
  )
})
