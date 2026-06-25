import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { SessionLogu } from "@/session/logu"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Plugin } from "@/plugin"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelMessage } from "ai"
import type { SessionPrompt } from "../../src/session/prompt"
import type { TaskPromptOps } from "../../src/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const baseLayer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Config.defaultLayer,
  EventV2Bridge.defaultLayer,
  Session.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.layer({}),
)

const it = testEffect(baseLayer)

const agent = { name: "build", mode: "primary", permission: [], options: {} } satisfies Agent.Info

const loguConfig = {
  local_fusion: {
    logu: {
      branches: [{ model: "test/branch" }],
      judge: { model: "test/judge" },
      synthesizer: { model: "test/synth" },
    },
  },
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
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
      modelID: input.model?.modelID ?? ModelV2.ID.make("model"),
      providerID: input.model?.providerID ?? ProviderV2.ID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

function promptOps(input?: {
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
        return reply(prompt, input?.text?.(prompt) ?? defaultText(prompt))
      }),
    wake: (sessionID) => Effect.succeed(reply({ sessionID, parts: [] }, "done")),
  }
}

function defaultText(prompt: SessionPrompt.PromptInput) {
  if (String(prompt.model?.modelID) === "judge") {
    return JSON.stringify({
      consensus: ["ok"],
      contradictions: [],
      uniqueInsights: [],
      blindSpots: [],
      failures: [],
      confidence: "high",
    })
  }
  if (String(prompt.model?.modelID) === "synth") return "final answer"
  return "ok"
}

function loguModel(): Provider.Model {
  return {
    id: ModelV2.ID.make("logu"),
    providerID: ProviderV2.ID.make("logu"),
    name: "logu",
    family: "local",
    api: { id: "logu", url: "", npm: "" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_384 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

function loguInput(sessionID: SessionID): LLM.StreamInput {
  return {
    user: {
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("logu"), modelID: ModelV2.ID.make("logu") },
    },
    sessionID,
    model: loguModel(),
    agent,
    system: [],
    messages: [{ role: "user", content: "hello" }],
    tools: {},
  }
}

function llmLayerWithoutProviderPath() {
  return LLM.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(
      Layer.mock(Provider.Service, {
        getModel: () => Effect.die("provider model lookup should be bypassed"),
        getLanguage: () => Effect.die("provider language lookup should be bypassed"),
        getProvider: () => Effect.die("provider info lookup should be bypassed"),
      }),
    ),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)))),
    Layer.provide(RuntimeFlags.layer({})),
  )
}

function errorMessage(exit: Exit.Exit<unknown, unknown>) {
  if (exit._tag !== "Failure") return ""
  return Cause.pretty(exit.cause)
}

describe("session logu route", () => {
  test("preserves legacy fusion routing without top-level logu config", () => {
    expect(SessionLogu.route({ system: [], messages: [] })).toBe("fusion")
  })

  test("honors explicit routing modes", () => {
    expect(SessionLogu.route({ config: { routing: { mode: "always" } }, system: [], messages: [] })).toBe("fusion")
    expect(SessionLogu.route({ config: { routing: { mode: "never" } }, system: [], messages: [] })).toBe("direct")
  })

  test("defaults omitted mode to auto for simple requests", () => {
    expect(SessionLogu.route({ config: {}, system: [], messages: [{ role: "user", content: "hello" }] })).toBe("direct")
    expect(
      SessionLogu.route({
        config: { routing: {} },
        system: [],
        messages: [{ role: "user", content: "what time is it?" }],
      }),
    ).toBe("direct")
  })

  test("routes complex latest user requests to fusion", () => {
    for (const content of [
      "please do a code review of this diff",
      "compare multiple approaches and tradeoffs for the architecture",
      "write an implementation plan for the migration",
      "find the root cause of this auth serialization regression",
    ]) {
      expect(SessionLogu.route({ config: {}, system: [], messages: [{ role: "user", content }] })).toBe("fusion")
    }
  })

  test("routes long latest user requests to fusion", () => {
    expect(SessionLogu.route({ config: {}, system: [], messages: [{ role: "user", content: "x".repeat(1201) }] })).toBe(
      "fusion",
    )
  })

  test("routes recent assistant or tool failure context to fusion", () => {
    expect(
      SessionLogu.route({
        config: {},
        system: [],
        messages: [{ role: "user", content: "this failed with exit code 1" }],
      }),
    ).toBe("fusion")

    expect(
      SessionLogu.route({
        config: {},
        system: [],
        messages: [
          { role: "user", content: "run the command" },
          { role: "assistant", content: "The command failed with exit code 1." },
          { role: "user", content: "what now?" },
        ],
      }),
    ).toBe("fusion")

    expect(
      SessionLogu.route({
        config: {},
        system: [],
        messages: [
          { role: "user", content: "run tests" },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: "Error: boom" }] },
          { role: "user", content: "explain" },
        ] as ModelMessage[],
      }),
    ).toBe("fusion")
  })
})

describe("session logu", () => {
  it.instance("fails with docs pointer when local_fusion.logu is missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "parent", agent: "build" })
      const exit = yield* SessionLogu.run({
        sessionID: parent.id,
        model: loguModel(),
        agent,
        system: [],
        messages: [],
        abort: new AbortController().signal,
        promptOps: promptOps(),
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(errorMessage(exit)).toContain("logu requires local_fusion.logu config")
      expect(errorMessage(exit)).toContain("packages/web/src/content/docs/local-fusion.mdx")
    }),
  )

  it.instance(
    "renders the current conversation and returns synthesizer output",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const prompts: SessionPrompt.PromptInput[] = []
        const result = yield* SessionLogu.run({
          sessionID: parent.id,
          model: loguModel(),
          agent,
          system: ["You are careful."],
          messages: [
            { role: "user", content: "Earlier request" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "I will inspect." },
                { type: "tool-call", toolCallId: "call-1", toolName: "read", input: { file: "a.ts" } },
              ],
            },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "read", output: "contents" }] },
            { role: "user", content: [{ type: "text", text: "Latest request" }, { type: "file", mediaType: "image/png", data: "x" }] },
          ] as ModelMessage[],
          abort: new AbortController().signal,
          promptOps: promptOps({ onPrompt: (input) => prompts.push(input) }),
        })

        expect(result.output).toBe("final answer")
        expect(String(prompts[0]?.parts[0]?.type)).toBe("text")
        const branchPrompt = prompts[0]?.parts[0]?.type === "text" ? prompts[0].parts[0].text : ""
        expect(branchPrompt).toContain("System 1:\nYou are careful.")
        expect(branchPrompt).toContain("User:\nEarlier request")
        expect(branchPrompt).toContain("Assistant:\nI will inspect.\nTool call read (call-1): {\"file\":\"a.ts\"}")
        expect(branchPrompt).toContain("Tool:\nTool result read (call-1): contents")
        expect(branchPrompt).toContain("User (latest request):\nLatest request\n[unsupported attachment: image/png]")
        expect(prompts[1]?.tools).toEqual({ "*": false })
        expect(prompts[2]?.tools).toEqual({ "*": false })
        const children = yield* sessions.children(parent.id)
        expect(children.map((child) => child.title)).toEqual(["Logu branch #1", "Logu judge", "Logu synthesizer"])
        expect(children.map((child) => child.metadata?.logu?.stage)).toEqual(["branch", "judge", "synthesizer"])
        expect(children.map((child) => child.metadata?.logu?.model)).toEqual(["test/branch", "test/judge", "test/synth"])
        expect(new Set(children.map((child) => child.metadata?.logu?.parentRunID)).size).toBe(1)
        expect(children.map((child) => child.metadata?.logu?.parentSessionID)).toEqual([parent.id, parent.id, parent.id])
      }),
    { config: loguConfig },
  )

  it.instance(
    "allows task delegation while disabling team and local fusion tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const prompts: SessionPrompt.PromptInput[] = []
        const result = yield* SessionLogu.run({
          sessionID: parent.id,
          model: loguModel(),
          agent,
          system: [],
          messages: [{ role: "user", content: "Use a subagent if useful" }],
          abort: new AbortController().signal,
          promptOps: promptOps({ onPrompt: (input) => prompts.push(input) }),
        })

        expect(result.output).toBe("final answer")
        expect(prompts[0]?.tools).toEqual({
          task: true,
          team_create: false,
          team_spawn: false,
          local_fusion: false,
        })
      }),
    {
      config: {
        local_fusion: {
          logu: {
            branches: [{ model: "test/branch", toolPolicy: "parent_without_teams" }],
            judge: { model: "test/judge" },
            synthesizer: { model: "test/synth" },
          },
        },
      },
    },
  )

  it.instance(
    "rejects recursive logu model references before creating child sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const exit = yield* SessionLogu.run({
          sessionID: parent.id,
          model: loguModel(),
          agent,
          system: [],
          messages: [],
          abort: new AbortController().signal,
          promptOps: promptOps(),
        }).pipe(Effect.exit)
        const children = yield* sessions.children(parent.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("branches[0].model")
        expect(children).toHaveLength(0)
      }),
    {
      config: {
        local_fusion: {
          logu: {
            branches: [{ model: "logu/logu" }],
            judge: { model: "test/judge" },
            synthesizer: { model: "test/synth" },
          },
        },
      },
    },
  )

  it.instance(
    "rejects recursive judge model references before creating child sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const exit = yield* SessionLogu.run({
          sessionID: parent.id,
          model: loguModel(),
          agent,
          system: [],
          messages: [],
          abort: new AbortController().signal,
          promptOps: promptOps(),
        }).pipe(Effect.exit)
        const children = yield* sessions.children(parent.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("judge.model")
        expect(children).toHaveLength(0)
      }),
    {
      config: {
        local_fusion: {
          logu: {
            branches: [{ model: "test/branch" }],
            judge: { model: "logu/logu" },
            synthesizer: { model: "test/synth" },
          },
        },
      },
    },
  )

  it.instance(
    "rejects recursive synthesizer model references before creating child sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const exit = yield* SessionLogu.run({
          sessionID: parent.id,
          model: loguModel(),
          agent,
          system: [],
          messages: [],
          abort: new AbortController().signal,
          promptOps: promptOps(),
        }).pipe(Effect.exit)
        const children = yield* sessions.children(parent.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("synthesizer.model")
        expect(children).toHaveLength(0)
      }),
    {
      config: {
        local_fusion: {
          logu: {
            branches: [{ model: "test/branch" }],
            judge: { model: "test/judge" },
            synthesizer: { model: "logu/logu" },
          },
        },
      },
    },
  )

  it.instance(
    "prefixes all-branch failure errors",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const exit = yield* SessionLogu.run({
          sessionID: parent.id,
          model: loguModel(),
          agent,
          system: [],
          messages: [],
          abort: new AbortController().signal,
          promptOps: {
            ...promptOps(),
            prompt: () => Effect.die(new Error("branch failed")),
          },
        }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("logu failed: All compound branches failed")
      }),
    { config: loguConfig },
  )

  it.instance(
    "streams synthesized output without provider lookup for logu/logu",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent", agent: "build" })
        const layer = LLM.layer.pipe(
          Layer.provide(Auth.defaultLayer),
          Layer.provide(Config.defaultLayer),
          Layer.provide(
            Layer.mock(Provider.Service, {
              getLanguage: () => Effect.die("provider language lookup should be bypassed"),
              getProvider: () => Effect.die("provider info lookup should be bypassed"),
            }),
          ),
          Layer.provide(Plugin.defaultLayer),
          Layer.provide(
            LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
          ),
          Layer.provide(RuntimeFlags.layer({})),
        )

        const events = yield* LLM.Service.use((svc) =>
          svc
            .stream({
              user: {
                id: MessageID.ascending(),
                role: "user",
                sessionID: parent.id,
                time: { created: Date.now() },
                agent: "build",
                model: { providerID: ProviderV2.ID.make("logu"), modelID: ModelV2.ID.make("logu") },
              },
              sessionID: parent.id,
              model: loguModel(),
              agent,
              system: [],
              messages: [{ role: "user", content: "answer" }],
              tools: {},
              promptOps: promptOps(),
            })
            .pipe(Stream.runCollect),
        ).pipe(Effect.provide(layer))

        expect(Array.from(events).map((event) => event.type)).toEqual([
          "step-start",
          "text-start",
          "text-delta",
          "text-end",
          "step-finish",
          "finish",
        ])
        expect(Array.from(events).find((event) => event.type === "text-delta")).toMatchObject({ text: "final answer" })
        expect(Array.from(events).find((event) => event.type === "step-finish")).toMatchObject({
          reason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        })
      }),
    { config: loguConfig },
  )

  it.instance(
    "fails direct route when logu.model is missing",
    () =>
      Effect.gen(function* () {
        const exit = yield* LLM.Service.use((svc) =>
          svc.stream(loguInput(SessionID.make("session-logu-missing-model"))).pipe(Stream.runCollect),
        ).pipe(Effect.provide(llmLayerWithoutProviderPath()), Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("logu direct route requires logu.model")
      }),
    { config: { logu: { routing: { mode: "never" } } } },
  )

  it.instance(
    "rejects recursive direct logu.model before provider lookup",
    () =>
      Effect.gen(function* () {
        const exit = yield* LLM.Service.use((svc) =>
          svc.stream(loguInput(SessionID.make("session-logu-recursive-model"))).pipe(Stream.runCollect),
        ).pipe(Effect.provide(llmLayerWithoutProviderPath()), Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("logu.model cannot reference logu/logu")
      }),
    { config: { logu: { model: "logu/logu", routing: { mode: "never" } } } },
  )

  it.instance(
    "uses route-specific missing fusion config errors",
    () =>
      Effect.gen(function* () {
        const exit = yield* LLM.Service.use((svc) =>
          svc.stream(loguInput(SessionID.make("session-logu-missing-fusion"))).pipe(Stream.runCollect),
        ).pipe(Effect.provide(llmLayerWithoutProviderPath()), Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(errorMessage(exit)).toContain("logu fusion route requires local_fusion.custom config")
        expect(errorMessage(exit)).toContain("packages/web/src/content/docs/local-fusion.mdx")
      }),
    { config: { logu: { fusion: "custom", routing: { mode: "always" } } } },
  )
})
