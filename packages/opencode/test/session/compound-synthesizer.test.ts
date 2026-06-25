import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, Exit, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionCompoundConfig } from "../../src/session/compound/config"
import { SessionCompoundJudge } from "../../src/session/compound/judge"
import { SessionCompound } from "../../src/session/compound/runner"
import { SessionCompoundSynthesizer } from "../../src/session/compound/synthesizer"
import type { BranchResult } from "../../src/session/compound/runner"
import type { SessionPrompt } from "../../src/session/prompt"
import type { TaskPromptOps } from "../../src/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(BackgroundJob.defaultLayer, EventV2Bridge.defaultLayer, Session.defaultLayer, Database.defaultLayer, RuntimeFlags.layer({})),
)

type AssistantWithParts = Omit<SessionV1.WithParts, "info"> & { info: SessionV1.Assistant }

const branches: BranchResult = {
  successes: [
    { index: 0, sessionID: SessionID.descending(), model: "test/branch-a", output: "Branch A output" },
  ],
  failures: [{ index: 1, model: "test/branch-b", reason: "failed" }],
}

const judge: SessionCompoundJudge.Result = {
  consensus: ["shared point"],
  contradictions: ["disagreement"],
  uniqueInsights: [{ branch: "0", insight: "detail" }],
  blindSpots: [],
  failures: [{ branch: "1", reason: "failed" }],
  confidence: "high",
}

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
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

function errorReply(input: SessionPrompt.PromptInput, message: string): SessionV1.WithParts {
  const result = reply(input, "")
  return { ...result, info: { ...result.info, error: { name: "UnknownError", data: { message } } } }
}

function stubOps(input: { onPrompt?: (input: SessionPrompt.PromptInput) => void; output: (input: SessionPrompt.PromptInput) => SessionV1.WithParts }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (prompt) =>
      Effect.sync(() => {
        input.onPrompt?.(prompt)
        return input.output(prompt)
      }),
    wake: (sessionID) => Effect.succeed(reply({ sessionID, parts: [] }, "done")),
  }
}

function config(input?: Record<string, unknown>) {
  return SessionCompoundConfig.parse({
    branches: [{ model: "test/branch-a" }, { model: "test/branch-b" }],
    judge: { model: "test/judge" },
    synthesizer: { model: "test/synth" },
    ...input,
  })
}

describe("compound synthesizer", () => {
  test("builds a final answer prompt from original prompt, branches, failures, and judge", () => {
    const prompt = SessionCompoundSynthesizer.buildPrompt({
      prompt: "Original user request",
      synthesizer: { model: "test/synth" },
      branches,
      judge,
    })

    expect(prompt).toContain("Original user request")
    expect(prompt).toContain("Branch A output")
    expect(prompt).toContain("failed")
    expect(prompt).toContain("shared point")
    expect(prompt).toContain("final answer")
  })

  it.instance("executes with tools disabled and returns final text", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      const result = yield* SessionCompoundSynthesizer.run({
        sessionID: parent.id,
        prompt: "Original request",
        synthesizer: { model: "test/synth", variant: "synth-low" },
        branches,
        judge,
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input), output: (input) => reply(input, "final answer") }),
      })

      expect(result.output).toBe("final answer")
      expect(String(prompts[0]?.model?.modelID)).toBe("synth")
      expect(prompts[0]?.variant).toBe("synth-low")
      expect(prompts[0]?.tools).toEqual({ "*": false })
      expect(prompts[0]?.format).toBeUndefined()
    }),
  )

  it.instance("disables team and local fusion tools for synthesizer parent delegation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      yield* SessionCompoundSynthesizer.run({
        sessionID: parent.id,
        prompt: "Original request",
        synthesizer: { model: "test/synth", toolPolicy: "parent_without_teams" },
        branches,
        judge,
        promptOps: stubOps({ onPrompt: (input) => prompts.push(input), output: (input) => reply(input, "final answer") }),
        mode: "logu",
      })
      const children = yield* sessions.children(parent.id)

      expect(prompts[0]?.tools).toEqual({
        task: true,
        team_create: false,
        team_spawn: false,
        local_fusion: false,
      })
      expect(children[0]?.permission).toEqual([
        { permission: "team_create", pattern: "*", action: "deny" },
        { permission: "team_spawn", pattern: "*", action: "deny" },
        { permission: "local_fusion", pattern: "*", action: "deny" },
      ])
    }),
  )

  it.instance("fails full run when all branches fail", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const prompts: SessionPrompt.PromptInput[] = []
      const exit = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch-a" }] }),
        promptOps: stubOps({
          onPrompt: (input) => prompts.push(input),
          output: (input) => errorReply(input, "branch failed"),
        }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(prompts).toHaveLength(1)
    }),
  )

  it.instance("fails full run when judge fails", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const exit = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch-a" }] }),
        promptOps: stubOps({
          output: (input) => (String(input.model?.modelID) === "judge" ? errorReply(input, "judge failed") : reply(input, "branch output")),
        }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("fails full run when synthesizer fails", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const exit = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch-a" }] }),
        promptOps: stubOps({
          output: (input) => {
            if (String(input.model?.modelID) === "judge") return reply(input, JSON.stringify(judge))
            if (String(input.model?.modelID) === "synth") return errorReply(input, "synth failed")
            return reply(input, "branch output")
          },
        }),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("returns synthesized output and metadata for full run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const result = yield* SessionCompound.run({
        sessionID: parent.id,
        prompt: "go",
        config: config({ branches: [{ model: "test/branch-a" }] }),
        promptOps: stubOps({
          output: (input) => {
            if (String(input.model?.modelID) === "judge") return reply(input, JSON.stringify(judge))
            if (String(input.model?.modelID) === "synth") return reply(input, "final answer")
            return reply(input, "branch output")
          },
        }),
      })

      expect(result.output).toBe("final answer")
      expect(result.metadata).toEqual({
        branchCount: 1,
        successfulBranchCount: 1,
        failedBranchCount: 0,
        judgeModel: "test/judge",
        synthesizerModel: "test/synth",
      })
    }),
  )
})
