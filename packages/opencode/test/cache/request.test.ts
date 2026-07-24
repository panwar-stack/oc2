import { describe, expect } from "bun:test"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Effect } from "effect"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { prepare } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
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

const sessionID = SessionID.make("ses_cache-request")
const user: SessionV1.User = {
  id: MessageID.make("msg_user-cache-request"),
  sessionID,
  role: "user",
  time: { created: 0 },
  agent: agent.name,
  model: { providerID: model.providerID, modelID: model.id },
  system: "user instruction",
}

const plugin: Plugin.Interface = {
  trigger: (_name, _input, output) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
}

const it = testEffect(RuntimeFlags.layer())

describe("prompt cache request preparation", () => {
  it.effect("keeps OpenAI prompt cache keys stable when tool insertion order changes", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const alphaTool = tool({
        description: "Alpha tool",
        inputSchema: jsonSchema({
          type: "object",
          properties: { alpha: { type: "string" } },
          required: ["alpha"],
        }),
      })
      const betaTool = tool({
        description: "Beta tool",
        inputSchema: jsonSchema({
          type: "object",
          properties: { beta: { type: "string" } },
          required: ["beta"],
        }),
      })
      const firstTools: Record<string, Tool> = { beta: betaTool, alpha: alphaTool }
      const secondTools: Record<string, Tool> = { alpha: alphaTool, beta: betaTool }

      const first = yield* prepare({
        user,
        sessionID,
        model,
        agent,
        system: [],
        messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
        tools: firstTools,
        provider,
        auth: undefined,
        plugin,
        flags,
        isWorkflow: false,
      })
      const second = yield* prepare({
        user,
        sessionID,
        model,
        agent,
        system: [],
        messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
        tools: secondTools,
        provider,
        auth: undefined,
        plugin,
        flags,
        isWorkflow: false,
      })

      expect(first.params.options.promptCacheKey).toMatch(/^oc2-v1-/)
      expect(first.params.options.promptCacheKey).toBe(second.params.options.promptCacheKey)
      expect(Object.keys(first.tools)).toEqual(["alpha", "beta"])
      expect(Object.keys(second.tools)).toEqual(["alpha", "beta"])
    }),
  )

  it.effect("replaces user supplied OpenAI prompt cache keys", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const manualModel = {
        ...model,
        options: { promptCacheKey: "manual-model-camel", prompt_cache_key: "manual-model-snake" },
      }
      const manualAgent = {
        ...agent,
        options: { promptCacheKey: "manual-agent-camel", prompt_cache_key: "manual-agent-snake" },
      }
      const manualPlugin: Plugin.Interface = {
        ...plugin,
        trigger: (name, _input, output) => {
          if (name === "chat.params") {
            const params = output as { options: Record<string, unknown> }
            params.options.promptCacheKey = "manual-plugin-camel"
            params.options.prompt_cache_key = "manual-plugin-snake"
          }
          return Effect.succeed(output)
        },
      }

      const prepared = yield* prepare({
        user,
        sessionID,
        model: manualModel,
        agent: manualAgent,
        system: [],
        messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
        tools: {},
        provider,
        auth: undefined,
        plugin: manualPlugin,
        flags,
        isWorkflow: false,
      })

      expect(prepared.params.options.promptCacheKey).toMatch(/^oc2-v1-/)
      expect(prepared.params.options.promptCacheKey).not.toMatch(/^manual-/)
      expect(prepared.params.options.prompt_cache_key).toBeUndefined()
      expect(JSON.stringify(prepared.params.options)).not.toContain("manual-")
    }),
  )
})
