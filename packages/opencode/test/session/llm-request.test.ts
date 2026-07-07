import { describe, expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { Naming } from "@opencode-ai/core/naming"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { prepare } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { SystemPrompt } from "@/session/system"
import { InstanceRef } from "@/effect/instance-ref"
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

  it.effect("sends canonical oc2 headers for managed providers", () =>
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
      }).pipe(
        Effect.provideService(InstanceRef, {
          directory: "/tmp/oc2-request-test",
          worktree: "/tmp/oc2-request-test",
          project: {
            id: ProjectV2.ID.make("proj_request"),
            worktree: "/tmp/oc2-request-test",
            time: { created: 0, updated: 0 },
            sandboxes: [],
          },
        }),
      )

      expect(prepared.headers).toMatchObject({
        [Naming.headers.project[0]]: ProjectV2.ID.make("proj_request"),
        [Naming.headers.session[0]]: sessionID,
        [Naming.headers.request[0]]: user.id,
        [Naming.headers.client[0]]: flags.client,
      })
      expect(Object.hasOwn(prepared.headers, Naming.headers.project[1])).toBe(false)
      expect(Object.hasOwn(prepared.headers, "x-session-affinity")).toBe(false)
    }),
  )
})
