import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Database } from "@oc2-ai/core/database/database"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import os from "os"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
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
  Layer.mergeAll(
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer({}),
  ),
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
      const result = yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "Compare options",
        config: config({
          branches: [
            { model: "test/branch-a", variant: "branch-fast" },
            { model: "test/branch-b", variant: "branch-careful", toolPolicy: "none" },
          ],
        }),
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }),
      })
      const children = yield* sessions.children(parent.id)

      expect(result.failures).toEqual([])
      expect(result.successes.map((success) => success.output)).toEqual(["branch-a", "branch-b"])
      expect(children).toHaveLength(2)
      expect(children.every((child) => child.parentID === parent.id)).toBe(true)
      expect(prompts.map((prompt) => String(prompt.model?.modelID))).toEqual(["branch-a", "branch-b"])
      expect(prompts.map((prompt) => prompt.variant)).toEqual(["branch-fast", "branch-careful"])
      expect(children.map((child) => child.model?.variant)).toEqual(["branch-fast", "branch-careful"])
      expect(children.map((child) => child.title)).toEqual(["Compound branch #1", "Compound branch #2"])
      expect(children.map((child) => child.metadata?.logu)).toEqual([undefined, undefined])
      expect(prompts.map((prompt) => prompt.agent)).toEqual(["build", "build"])
      const firstPromptText = prompts[0]?.parts.find((part) => part.type === "text")?.text
      expect(firstPromptText).toContain("Use tools to research and propose changes")
      expect(firstPromptText).toContain("Do not edit workspace files")
      expect(firstPromptText).toContain("If scratch files are needed, write only under")
      expect(firstPromptText).toContain("Return recommended edits as text, file paths, and rationale")
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
      const fiber = yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config(),
        promptOps,
      }).pipe(Effect.forkIn(scope))

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
      const result = yield* SessionCompound.runBranches({
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
      const children = yield* sessions.children(parent.id)
      const failed = children.find((child) => String(child.model?.id) === "branch-b")

      expect(result.successes).toHaveLength(1)
      expect(result.failures).toMatchObject([{ index: 1, model: "test/branch-b", reason: "branch failed" }])
      expect(Object.hasOwn(result.failures[0] ?? {}, "timedOut")).toBe(false)
      expect(failed?.metadata).toBeUndefined()
    }),
  )

  it.instance("records assistant error results as branch failures", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const result = yield* SessionCompound.runBranches({
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
      const result = yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/slow", timeout: 1 }], limits: { timeout: 50, maxBranches: 1 } }),
        promptOps: {
          ...stubOps({ onCancel: (sessionID) => cancelled.push(sessionID) }),
          prompt: () => Effect.never,
        },
      })
      const children = yield* sessions.children(parent.id)

      expect(result.successes).toEqual([])
      expect(result.failures).toMatchObject([{ index: 0, model: "test/slow", timedOut: true }])
      expect(children[0]?.metadata).toBeUndefined()
      expect(cancelled).toHaveLength(1)
    }),
  )

  it.instance("applies explicit global branch timeout", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const cancelled: SessionID[] = []
      const result = yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/slow" }], limits: { timeout: 1, maxBranches: 1 } }),
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

  it.instance("interrupts before branch fan-out when the signal is already aborted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const controller = new AbortController()
      const prompts: SessionPrompt.PromptInput[] = []
      const cancelled: SessionID[] = []
      controller.abort()

      const exit = yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config(),
        promptOps: {
          ...stubOps({ onCancel: (sessionID) => cancelled.push(sessionID) }),
          prompt: (input) =>
            Effect.sync(() => {
              prompts.push(input)
              return reply(input, "unexpected")
            }),
        },
        abort: controller.signal,
      }).pipe(Effect.exit)
      const children = yield* sessions.children(parent.id)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(children).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      expect(cancelled).toHaveLength(0)
    }),
  )

  it.instance("cancels active branches and skips judge and synthesizer after abort", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const controller = new AbortController()
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const cancelledBoth = yield* Deferred.make<void>()
      const scope = yield* Scope.Scope
      const prompts: string[] = []
      const cancelled: SessionID[] = []
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        cancel: (sessionID) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => cancelled.push(sessionID))
            if (cancelled.length === 2) yield* Deferred.succeed(cancelledBoth, undefined)
          }),
        prompt: (input) =>
          Effect.gen(function* () {
            const model = String(input.model?.modelID)
            prompts.push(model)
            if (model === "branch-a") yield* Deferred.succeed(firstStarted, undefined)
            if (model === "branch-b") yield* Deferred.succeed(secondStarted, undefined)
            if (model === "branch-a" || model === "branch-b") {
              yield* Deferred.await(cancelledBoth)
              return reply(input, model)
            }
            return reply(input, model)
          }),
      }
      const fiber = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config(),
        promptOps,
        abort: controller.signal,
      }).pipe(Effect.exit, Effect.forkIn(scope))

      yield* Deferred.await(firstStarted)
      yield* Deferred.await(secondStarted)
      controller.abort()
      const exit = yield* Fiber.join(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(new Set(cancelled).size).toBe(2)
      expect(prompts).toEqual(["branch-a", "branch-b"])
    }),
  )

  it.instance("interrupts direct branch fan-out after abort resolves active branches", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const controller = new AbortController()
      const started = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const scope = yield* Scope.Scope
      const fiber = yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch-a" }], limits: { maxBranches: 1 } }),
        promptOps: {
          ...stubOps(),
          cancel: () => Deferred.succeed(cancelled, undefined),
          prompt: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(cancelled)
              return reply(input, "branch result")
            }),
        },
        abort: controller.signal,
      }).pipe(Effect.exit, Effect.forkIn(scope))

      yield* Deferred.await(started)
      controller.abort()
      const exit = yield* Fiber.join(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )

  it.instance("interrupts after judge abort and skips synthesizer", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const controller = new AbortController()
      const prompts: string[] = []
      const exit = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch" }], limits: { maxBranches: 1 } }),
        promptOps: {
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              const model = String(input.model?.modelID)
              prompts.push(model)
              if (model === "judge") {
                controller.abort()
                return reply(
                  input,
                  JSON.stringify({
                    consensus: [],
                    contradictions: [],
                    uniqueInsights: [],
                    blindSpots: [],
                    failures: [],
                    confidence: "high",
                  }),
                )
              }
              return reply(input, model)
            }),
        },
        abort: controller.signal,
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(prompts).toEqual(["branch", "judge"])
    }),
  )

  it.instance("applies branch tool policies", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({
          branches: [
            { model: "test/branch-a", toolPolicy: "readonly" },
            { model: "test/branch-b", toolPolicy: "none" },
            { model: "test/branch-c", toolPolicy: "all" },
          ],
        }),
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
      expect(prompts[2]?.tools).toEqual({
        "*": false,
        read: true,
        grep: true,
        glob: true,
        webfetch: true,
        websearch: true,
        lsp: true,
        write: true,
        edit: true,
        apply_patch: false,
      })
    }),
  )

  it.instance("uses scratch tools for branch and judge write-capable policies", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({
          branches: [{ model: "test/branch", toolPolicy: "all" }],
          judge: { model: "test/judge", toolPolicy: "all" },
          synthesizer: { model: "test/synth", toolPolicy: "all" },
        }),
        promptOps: stubOps({
          onPrompt: (input) => prompts.push(input),
          text: (input) => {
            if (String(input.model?.modelID) === "judge") {
              return JSON.stringify({
                consensus: [],
                contradictions: [],
                uniqueInsights: [],
                blindSpots: [],
                failures: [],
                confidence: "high",
              })
            }
            if (String(input.model?.modelID) === "synth") return "final answer"
            return "branch output"
          },
        }),
      })

      expect(prompts.map((prompt) => String(prompt.model?.modelID))).toEqual(["branch", "judge", "synth"])
      expect(prompts.map((prompt) => prompt.tools)).toEqual([
        {
          "*": false,
          read: true,
          grep: true,
          glob: true,
          webfetch: true,
          websearch: true,
          lsp: true,
          write: true,
          edit: true,
          apply_patch: false,
        },
        {
          "*": false,
          read: true,
          grep: true,
          glob: true,
          webfetch: true,
          websearch: true,
          lsp: true,
          write: true,
          edit: true,
          apply_patch: false,
        },
        {},
      ])
    }),
  )

  it.instance("uses distinct scratch directories for branches and judge", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({
          branches: [
            { model: "test/branch-a", toolPolicy: "all" },
            { model: "test/branch-b", toolPolicy: "all" },
          ],
          judge: { model: "test/judge", toolPolicy: "all" },
        }),
        promptOps: stubOps({
          text: (input) => {
            if (String(input.model?.modelID) === "judge") {
              return JSON.stringify({
                consensus: [],
                contradictions: [],
                uniqueInsights: [],
                blindSpots: [],
                failures: [],
                confidence: "high",
              })
            }
            if (String(input.model?.modelID) === "synth") return "final answer"
            return "branch output"
          },
        }),
      })
      const children = yield* sessions.children(parent.id)
      const scratchPatterns = children
        .map(
          (child) =>
            child.permission?.find(
              (rule) => rule.permission === "edit" && rule.pattern !== "*" && rule.action === "allow",
            )?.pattern,
        )
        .filter((pattern) => pattern !== undefined)

      expect(scratchPatterns).toHaveLength(3)
      expect(scratchPatterns.every((pattern) => pattern !== undefined)).toBe(true)
      expect(new Set(scratchPatterns).size).toBe(3)
      expect(scratchPatterns.some((pattern) => pattern?.includes("branch-0"))).toBe(true)
      expect(scratchPatterns.some((pattern) => pattern?.includes("branch-1"))).toBe(true)
      expect(scratchPatterns.some((pattern) => pattern?.includes("judge"))).toBe(true)
    }),
  )

  it.instance("accepts write-capable tool policies", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      for (const input of [
        { branches: [{ model: "test/branch", toolPolicy: "parent_without_teams" }] },
        { branches: [{ model: "test/branch", toolPolicy: "all" }] },
        { judge: { model: "test/judge", toolPolicy: "parent_without_teams" } },
        { judge: { model: "test/judge", toolPolicy: "all" } },
        { synthesizer: { model: "test/synth", toolPolicy: "parent_without_teams" } },
        { synthesizer: { model: "test/synth", toolPolicy: "all" } },
      ]) {
        const parent = yield* sessions.create({ title: "parent" })
        const result = yield* SessionCompound.run({
          sessionID: parent.id,
          prompt: "go",
          config: config(input),
          promptOps: stubOps({
            text: (input) => {
              if (String(input.model?.modelID) === "judge") {
                return JSON.stringify({
                  consensus: [],
                  contradictions: [],
                  uniqueInsights: [],
                  blindSpots: [],
                  failures: [],
                  confidence: "high",
                })
              }
              if (String(input.model?.modelID) === "synth") return "final answer"
              return "branch output"
            },
          }),
        })

        expect(result.output).toBe("final answer")
      }
    }),
  )

  it.instance("uses scratch permissions for branch parent delegation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch", toolPolicy: "parent_without_teams" }] }),
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }),
      })
      const children = yield* sessions.children(parent.id)
      const childPermission = children[0]?.permission ?? []

      expect(prompts[0]?.tools).toMatchObject({ write: true, edit: true, apply_patch: false })
      expect(childPermission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
      expect(childPermission).toContainEqual({ permission: "team_create", pattern: "*", action: "deny" })
      expect(childPermission).toContainEqual({ permission: "team_spawn", pattern: "*", action: "deny" })
      expect(childPermission).toContainEqual({ permission: "local_fusion", pattern: "*", action: "deny" })
      expect(childPermission).not.toContainEqual({ permission: "edit", pattern: "*", action: "allow" })
      const tempEditAllow = childPermission.find(
        (rule) => rule.permission === "edit" && rule.pattern !== "*" && rule.action === "allow",
      )
      expect(tempEditAllow?.pattern).toContain("opencode-local-fusion")
      expect(Permission.evaluate("edit", "package.json", childPermission).action).toBe("deny")
      expect(
        Permission.evaluate("edit", tempEditAllow?.pattern.replace(/\/\*$/, "/scratch.txt") ?? "", childPermission)
          .action,
      ).toBe("allow")
      expect(children[0]?.title).toBe("Compound branch #1")
      expect(children[0]?.metadata?.logu).toBeUndefined()
      expect(
        Permission.disabled(
          ["write", "edit", "apply_patch", "team_create", "team_spawn", "local_fusion"],
          [...childPermission],
        ),
      ).toEqual(new Set(["apply_patch", "team_create", "team_spawn", "local_fusion"]))
    }),
  )

  it.instance("keeps parent edit deny above branch scratch edit allow", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({
        title: "parent",
        permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch", toolPolicy: "all" }] }),
        promptOps: stubOps(),
      })
      const children = yield* sessions.children(parent.id)
      const childPermission = children[0]?.permission ?? []
      const tempEditAllow = childPermission.find(
        (rule) => rule.permission === "edit" && rule.pattern !== "*" && rule.action === "allow",
      )

      expect(tempEditAllow).toBeDefined()
      expect(
        Permission.evaluate("edit", tempEditAllow?.pattern.replace(/\/\*$/, "/scratch.txt") ?? "", childPermission)
          .action,
      ).toBe("deny")
    }),
  )

  it.instance("keeps branch scratch directory outside session roots", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      yield* sessions.addRoot({
        sessionID: parent.id,
        directory: path.dirname(path.resolve(os.tmpdir())),
        name: "temp parent",
      })
      yield* sessions.addRoot({ sessionID: parent.id, directory: os.tmpdir(), name: "system temp" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch", toolPolicy: "parent_without_teams" }] }),
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }),
      })
      const children = yield* sessions.children(parent.id)
      const childPermission = children[0]?.permission ?? []
      const tempEditAllow = childPermission.find(
        (rule) => rule.permission === "edit" && rule.pattern !== "*" && rule.action === "allow",
      )
      const tempDir = path.resolve(parent.directory, tempEditAllow?.pattern.replace(/\/\*$/, "") ?? ".")

      expect(prompts[0]?.tools).toMatchObject({ write: true, edit: true, apply_patch: false })
      expect(containsPath(path.resolve(os.tmpdir()), tempDir)).toBe(false)
      expect(containsPath(path.dirname(path.resolve(os.tmpdir())), tempDir)).toBe(false)
      expect(Permission.evaluate("edit", "package.json", childPermission).action).toBe("deny")
      expect(
        Permission.evaluate("edit", tempEditAllow?.pattern.replace(/\/\*$/, "/scratch.txt") ?? "", childPermission)
          .action,
      ).toBe("allow")
    }),
  )

  it.instance("does not re-enable denied task for parent delegation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({
        title: "parent",
        permission: [{ permission: "task", action: "deny", pattern: "*" }],
      })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompound.runBranches({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch", toolPolicy: "parent_without_teams" }] }),
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input) }),
      })

      expect(prompts[0]?.tools).toMatchObject({ write: true, edit: true, apply_patch: false })
    }),
  )
})

function containsPath(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
