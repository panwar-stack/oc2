import { afterEach, describe, expect } from "bun:test"
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

function errorMessage(exit: Exit.Exit<unknown, unknown>) {
  if (exit._tag !== "Failure") return ""
  return Cause.pretty(exit.cause)
}

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
      }),
    { config: loguConfig },
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
})
