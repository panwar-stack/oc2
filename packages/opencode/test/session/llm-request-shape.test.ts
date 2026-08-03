import { describe, expect } from "bun:test"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Effect, Layer, Schema } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage } from "ai"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLMRequestPrep, prepare } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import type { TaskPromptOps } from "@/tool/task"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Database } from "@oc2-ai/core/database/database"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelV2.ID.make("request-shape-model"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "request-shape-model",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "Request Shape Model",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const provider: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: [],
  options: {},
  models: {},
}

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
  prompt: "agent custom prompt",
  options: {},
}

const sessionID = SessionID.make("ses_request_shape")
const user: SessionV1.User = {
  id: MessageID.make("msg_request-shape"),
  sessionID,
  role: "user",
  time: { created: 0 },
  agent: agent.name,
  model: { providerID: model.providerID, modelID: model.id },
}

const plugin: Plugin.Interface = {
  trigger: (_name, _input, output) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
}

const it = testEffect(RuntimeFlags.layer())
const completionOnlyTools = { "*": false, team_task_update: true } satisfies Record<string, boolean>

const makeTool = (description: string) =>
  aiTool({
    description,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => ({ output: "ok" }),
  })

const makeRegistryTool = (description: string): Tool.Def => ({
  id: "team_task_update",
  description,
  parameters: Schema.Struct({}),
  execute: () => Effect.succeed({ title: "Task Updated", output: description, metadata: {} }),
})

function collisionLayer(kind: "plugin" | "mcp") {
  const trusted = makeRegistryTool("trusted built-in team_task_update")
  const pluginCollision = makeRegistryTool("plugin collision team_task_update")
  const registryItems = kind === "plugin" ? [{ ...trusted }, pluginCollision] : [{ ...trusted }]
  const mcpTools: Record<string, ReturnType<typeof makeTool>> = kind === "mcp"
    ? { team_task_update: makeTool("MCP collision team_task_update") }
    : {}
  return Layer.mergeAll(
    Layer.mock(Plugin.Service, {
      trigger: (_name, _input, output) => Effect.succeed(output),
    }),
    Layer.mock(Permission.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      named: () => Effect.succeed({ task: trusted, read: trusted, teamTaskUpdate: trusted } as never),
      tools: () => Effect.succeed(registryItems),
    }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed(mcpTools),
    }),
    Layer.mock(Truncate.Service, {}),
    Layer.succeed(Database.Service, Database.Service.of({ db: {} as Database.Interface["db"] })),
  )
}

const resolveCollision = (kind: "plugin" | "mcp", completionOnly: boolean) =>
  SessionTools.resolve({
    agent,
    model,
    session: { id: sessionID, permission: [] } as unknown as Session.Info,
    processor: {
      message: { id: MessageID.make("msg_tool-collision") } as SessionV1.Assistant,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [
      {
        info: {
          ...user,
          tools: completionOnly ? completionOnlyTools : undefined,
        },
        parts: [],
      },
    ],
    promptOps: {} as TaskPromptOps,
  }).pipe(Effect.provide(collisionLayer(kind)))

const getPreparedToolDescriptions = Effect.fnUntraced(function* () {
  const flags = yield* RuntimeFlags.Service
  const prepared = yield* prepare({
    user,
    sessionID,
    model,
    agent,
    system: [],
    messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
    tools: {
      zeta: makeTool("zeta sentinel guidance"),
      alpha: makeTool("alpha sentinel guidance"),
      middle: makeTool("middle sentinel guidance"),
    },
    provider,
    auth: undefined,
    plugin,
    flags,
    isWorkflow: false,
  })

  return Object.fromEntries(Object.entries(prepared.tools).map(([id, tool]) => [id, tool.description]))
})

describe("session.llm.request shape", () => {
  it.effect("keeps tool IDs sorted deterministically without freezing full descriptions", () =>
    Effect.gen(function* () {
      const first = yield* getPreparedToolDescriptions()
      const second = yield* getPreparedToolDescriptions()

      expect(Object.keys(first)).toEqual(["alpha", "middle", "zeta"])
      expect(Object.keys(second)).toEqual(Object.keys(first))
      expect(first).toMatchObject({
        alpha: expect.stringContaining("alpha sentinel"),
        middle: expect.stringContaining("middle sentinel"),
        zeta: expect.stringContaining("zeta sentinel"),
      })
    }),
  )

  for (const kind of ["plugin", "mcp"] as const) {
    it.effect(`pins the trusted completion tool across a ${kind} name collision`, () =>
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        const resolved = yield* resolveCollision(kind, true)
        const prepared = yield* prepare({
          user: { ...user, tools: completionOnlyTools },
          sessionID,
          model,
          agent,
          system: [],
          messages: [{ role: "user", content: "finish the task" }] satisfies ModelMessage[],
          tools: resolved,
          provider,
          auth: undefined,
          plugin,
          flags,
          isWorkflow: false,
        })

        expect(LLMRequestPrep.isCompletionOnlyToolSelection(completionOnlyTools)).toBe(true)
        expect(LLMRequestPrep.isCompletionOnlyToolSelection({ ...completionOnlyTools, team_send_message: false })).toBe(
          false,
        )
        expect(Object.keys(prepared.tools)).toEqual(["team_task_update"])
        expect(prepared.tools.team_task_update?.description).toBe("trusted built-in team_task_update")

        const normal = yield* resolveCollision(kind, false)
        expect(normal.team_task_update?.description).toBe(
          kind === "plugin" ? "plugin collision team_task_update" : "MCP collision team_task_update",
        )
      }),
    )
  }
})
