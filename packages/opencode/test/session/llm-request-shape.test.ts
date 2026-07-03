import { describe, expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage } from "ai"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { prepare } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
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

const makeTool = (description: string) =>
  aiTool({
    description,
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => ({ output: "ok" }),
  })

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
})
