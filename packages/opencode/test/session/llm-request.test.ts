import { describe, expect } from "bun:test"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { prepare } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { SystemPrompt } from "@/session/system"
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

const sessionID = SessionID.make("ses_request")
const user: SessionV1.User = {
  id: MessageID.make("msg_user-request"),
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

describe("session.llm.request", () => {
  it.effect("prepends token-budget guidance before all other system sections", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const prepared = yield* prepare({
        user,
        sessionID,
        model,
        agent,
        system: ["session instruction"],
        messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
        tools: {},
        provider,
        auth: undefined,
        plugin,
        flags,
        isWorkflow: false,
      })

      const expectedSystem = [
        SystemPrompt.TOKEN_BUDGET_GUIDANCE,
        "agent custom prompt",
        "session instruction",
        "user instruction",
      ].join("\n")

      expect(prepared.system).toEqual([expectedSystem])
      expect(prepared.messages[0]).toEqual({ role: "system", content: expectedSystem })
    }),
  )

  it.effect("uses standard affinity headers for oc2 provider IDs", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const prepared = yield* prepare({
        user,
        sessionID,
        model: { ...model, providerID: ProviderV2.ID.oc2 },
        agent,
        system: [],
        messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
        tools: {},
        provider: { ...provider, id: ProviderV2.ID.oc2 },
        auth: undefined,
        plugin,
        flags,
        isWorkflow: false,
      })

      expect(prepared.headers).toMatchObject({
        "x-session-affinity": sessionID,
        "User-Agent": expect.stringMatching(/^oc2\//),
      })
      expect(Object.hasOwn(prepared.headers, "x-oc2-project")).toBe(false)
      expect(Object.hasOwn(prepared.headers, "x-oc2-session")).toBe(false)
    }),
  )

  it.effect("derives and scrubs prompt cache request fields across provider families", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const cases = [
        {
          providerID: "openai",
          modelID: "gpt-5-mini",
          npm: "@ai-sdk/openai",
          expectedMode: "automatic",
          expectsPromptCacheKey: true,
        },
        {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          npm: "@ai-sdk/anthropic",
          expectedMode: "explicit",
          expectsPromptCacheKey: false,
        },
        {
          providerID: "moonshot",
          modelID: "kimi-k2",
          npm: "@ai-sdk/openai-compatible",
          expectedMode: "automatic",
          expectsPromptCacheKey: false,
        },
        {
          providerID: "kimi",
          modelID: "kimi-latest",
          npm: "@ai-sdk/openai-compatible",
          expectedMode: "automatic",
          expectsPromptCacheKey: false,
        },
        {
          providerID: "deepseek",
          modelID: "deepseek-chat",
          npm: "@ai-sdk/openai-compatible",
          expectedMode: "automatic",
          expectsPromptCacheKey: false,
        },
        {
          providerID: "future",
          modelID: "future-model",
          npm: "@ai-sdk/openai-compatible",
          expectedMode: "disabled",
          expectsPromptCacheKey: false,
        },
      ] as const

      for (const item of cases) {
        const providerID = ProviderV2.ID.make(item.providerID)
        const modelID = ModelV2.ID.make(item.modelID)
        const prepared = yield* prepare({
          user: { ...user, model: { providerID, modelID } },
          sessionID,
          model: {
            ...model,
            id: modelID,
            providerID,
            api: {
              id: item.modelID,
              url: `https://api.${item.providerID}.test/v1`,
              npm: item.npm,
            },
          },
          agent,
          system: [],
          messages: [{ role: "user", content: "hello" }] satisfies ModelMessage[],
          tools: {},
          provider: {
            ...provider,
            id: providerID,
            options: { promptCacheKey: "manual-camel", prompt_cache_key: "manual-snake" },
          },
          auth: undefined,
          plugin,
          flags,
          isWorkflow: false,
        })

        expect(prepared.params.cachePlan).toMatchObject({ provider: item.providerID, model: item.modelID, mode: item.expectedMode })
        const messageTransformOptions: Record<string, unknown> = prepared.messageTransformOptions
        if (item.expectsPromptCacheKey) {
          expect(prepared.params.options.promptCacheKey).toMatch(/^oc2-v1-/)
          expect(messageTransformOptions.promptCacheKey).toBe(prepared.params.options.promptCacheKey)
        } else {
          expect(prepared.params.options.promptCacheKey).toBeUndefined()
          expect(messageTransformOptions.promptCacheKey).toBeUndefined()
        }
        expect(prepared.params.options.prompt_cache_key).toBeUndefined()
        expect(messageTransformOptions.prompt_cache_key).toBeUndefined()
      }
    }),
  )
})
