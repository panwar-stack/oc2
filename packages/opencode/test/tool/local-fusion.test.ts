import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Opengrep } from "@opencode-ai/core/filesystem/opengrep"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Team } from "@/team/team"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { LocalFusionTool } from "../../src/tool/local_fusion"
import * as Tool from "../../src/tool/tool"
import type { SessionPrompt } from "../../src/session/prompt"
import type { TaskPromptOps } from "../../src/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Config.defaultLayer,
    EventV2Bridge.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer({}),
  ),
)

const registryIt = testEffect(
  Layer.mergeAll(ToolRegistry.defaultLayer, Layer.mock(Opengrep.Service, { available: () => Effect.succeed(false) })),
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
      modelID: input.model?.modelID ?? ("model" as SessionV1.Assistant["modelID"]),
      providerID: input.model?.providerID ?? ("test" as SessionV1.Assistant["providerID"]),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

function promptOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.succeed(
        String(input.model?.modelID) === "judge"
          ? reply(
              input,
              JSON.stringify({
                consensus: ["ok"],
                contradictions: [],
                uniqueInsights: [],
                blindSpots: [],
                failures: [],
                confidence: "high",
              }),
            )
          : String(input.model?.modelID) === "synth"
            ? reply(input, "final fused answer")
            : reply(input, "branch output"),
      ),
    wake: (sessionID) => Effect.succeed(reply({ sessionID, parts: [] }, "done")),
  }
}

function context(sessionID: SessionID, extra?: Record<string, unknown>): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    extra,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function params(input?: Record<string, unknown>) {
  return {
    prompt: "Compare answers",
    branches: [{ model: "test/branch" }],
    judge: { model: "test/judge" },
    synthesizer: { model: "test/synth" },
    ...input,
  }
}

describe("local_fusion tool", () => {
  it.instance("executes inline config and returns final output plus metadata", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const result = yield* tool.execute(params(), context(parent.id, { promptOps: promptOps() }))

      expect(result.title).toBe("Local fusion")
      expect(result.output).toBe("final fused answer")
      expect(result.metadata).toMatchObject({
        branchCount: 1,
        successfulBranchCount: 1,
        failedBranchCount: 0,
        judgeModel: "test/judge",
        synthesizerModel: "test/synth",
      })
    }),
  )

  it.instance(
    "executes named config from opencode config",
    () =>
      Effect.gen(function* () {
        const info = yield* LocalFusionTool
        const tool = yield* Tool.init(info)
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })
        const result = yield* tool.execute(
          { prompt: "Compare answers", config: "research-panel" },
          context(parent.id, { promptOps: promptOps() }),
        )

        expect(result.output).toBe("final fused answer")
        expect(result.metadata).toMatchObject({
          branchCount: 1,
          judgeModel: "test/judge",
          synthesizerModel: "test/synth",
        })
      }),
    {
      config: {
        local_fusion: {
          "research-panel": {
            branches: [{ model: "test/branch" }],
            judge: { model: "test/judge" },
            synthesizer: { model: "test/synth" },
          },
        },
      },
    },
  )

  it.instance("exposes a top-level object JSON schema", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)

      expect(tool.jsonSchema).toMatchObject({
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          config: { type: "string" },
          branches: { type: "array" },
          judge: { type: "object" },
          synthesizer: { type: "object" },
        },
      })
      expect(tool.jsonSchema).not.toHaveProperty("anyOf")
    }),
  )

  it.instance("rejects missing named config with a safe message", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const exit = yield* tool
        .execute({ prompt: "Compare answers", config: "missing" }, context(parent.id, { promptOps: promptOps() }))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (exit._tag === "Failure") expect(errorMessage(exit.cause)).toContain("local_fusion config not found")
    }),
  )

  it.instance("rejects mixing named and inline config", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const exit = yield* tool
        .execute(params({ config: "research-panel" }), context(parent.id, { promptOps: promptOps() }))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (exit._tag === "Failure") expect(errorMessage(exit.cause)).toContain("cannot be combined")
    }),
  )

  it.instance("rejects missing inline config fields", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const exit = yield* tool.execute({ prompt: "go" }, context(parent.id, { promptOps: promptOps() })).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (exit._tag === "Failure") expect(errorMessage(exit.cause)).toContain("requires config or inline branches")
    }),
  )

  it.instance("requires prompt ops", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })
      const exit = yield* tool.execute(params(), context(parent.id)).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (exit._tag === "Failure") expect(errorMessage(exit.cause)).toContain("promptOps")
    }),
  )

  it.instance("accepts write-capable tool policies for inline configs", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent" })

      for (const toolPolicy of ["parent_without_teams", "all"] as const) {
        const result = yield* tool.execute(
          params({
            branches: [{ model: "test/branch", toolPolicy }],
            judge: { model: "test/judge", toolPolicy },
            synthesizer: { model: "test/synth", toolPolicy },
          }),
          context(parent.id, { promptOps: promptOps() }),
        )

        expect(result.output).toBe("final fused answer")
      }
    }),
  )

  it.instance(
    "accepts write-capable tool policies from named configs",
    () =>
      Effect.gen(function* () {
        const info = yield* LocalFusionTool
        const tool = yield* Tool.init(info)
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })

        for (const config of ["delegated-panel", "all-panel"]) {
          const result = yield* tool.execute({ prompt: "Compare answers", config }, context(parent.id, { promptOps: promptOps() }))

          expect(result.output).toBe("final fused answer")
        }
      }),
    {
      config: {
        local_fusion: {
          "delegated-panel": {
            branches: [{ model: "test/branch", toolPolicy: "parent_without_teams" }],
            judge: { model: "test/judge" },
            synthesizer: { model: "test/synth" },
          },
          "all-panel": {
            branches: [{ model: "test/branch", toolPolicy: "all" }],
            judge: { model: "test/judge" },
            synthesizer: { model: "test/synth" },
          },
        },
      },
    },
  )

  it.instance("rejects active team sessions", () =>
    Effect.gen(function* () {
      const info = yield* LocalFusionTool
      const tool = yield* Tool.init(info)
      const sessions = yield* Session.Service
      const team = yield* Team.Service
      const parent = yield* sessions.create({ title: "parent" })
      yield* team.create({ name: "fusion", goal: "deep research", leadSessionID: parent.id })
      const exit = yield* tool.execute(params(), context(parent.id, { promptOps: promptOps() })).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (exit._tag === "Failure") expect(errorMessage(exit.cause)).toContain("active agent team session")
    }),
  )

  registryIt.instance("registry exposes local_fusion", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("local_fusion")
    }),
  )
})

function errorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}
