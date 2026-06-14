import { expect, test } from "bun:test"
import { z } from "zod"

import {
  MainAgent,
  buildAgentModelContext,
  createModelService,
  createSessionService,
  createToolExecutor,
  createToolRegistry,
  openOc2Database,
  resolveMainAgentProfile,
  defaultConfig,
  type ToolDefinition,
} from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "./helpers"

const createRuntime = () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  return { db, sessions }
}

test("main agent profile supplies default prompt, model, and loop limits", () => {
  const profile = resolveMainAgentProfile(defaultConfig)

  expect(profile.id).toBe("main")
  expect(profile.systemPrompt).toContain("local-first coding assistant")
  expect(profile.maxIterations).toBeGreaterThan(0)
})

test("agent context includes system prompt, workspace roots, persisted messages, tools, and profile", () => {
  const { db, sessions } = createRuntime()
  const session = sessions.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  sessions.appendMessage({ sessionId: session.id, role: "user", parts: [{ type: "text", text: "hello" }] })
  const registry = createToolRegistry([testTool])

  const context = buildAgentModelContext({
    session,
    messages: sessions.messages.listBySession(session.id),
    profile: resolveMainAgentProfile(defaultConfig),
    registry,
    config: defaultConfig,
  })

  expect(context.messages[0]?.content).toContain("/repo")
  expect(context.messages.map((message) => message.role)).toEqual(["system", "user"])
  expect(context.tools.map((tool) => tool.name)).toEqual(["answer"])
  db.close()
})

test("agent loop persists final assistant text without tools", async () => {
  const { db, sessions } = createRuntime()
  const session = sessions.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const registry = createToolRegistry([testTool])
  const agent = new MainAgent({
    sessions,
    registry,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents])] }),
    tools: createToolExecutor({ registry }),
  })

  const result = await agent.run({
    session,
    profile: resolveMainAgentProfile(defaultConfig),
    prompt: "hello",
    config: defaultConfig,
    signal: new AbortController().signal,
  })

  expect(result.status).toBe("completed")
  expect(result.text).toBe("fake response")
  expect(sessions.messages.listBySession(session.id).map((message) => message.role)).toEqual(["user", "assistant"])
  db.close()
})

test("agent loop executes tool calls and persists tool results", async () => {
  const { db, sessions } = createRuntime()
  const session = sessions.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const registry = createToolRegistry([testTool])
  const provider = createScriptedModelProvider([
    [{ type: "tool-call", call: { id: "tool-1", name: "answer", arguments: { value: "42" } } }, { type: "done" }],
    simpleAssistantEvents,
  ])
  const agent = new MainAgent({
    sessions,
    registry,
    models: createModelService({ providers: [provider] }),
    tools: createToolExecutor({ registry }),
  })

  const result = await agent.run({
    session,
    profile: resolveMainAgentProfile(defaultConfig),
    prompt: "use tool",
    config: defaultConfig,
    signal: new AbortController().signal,
  })

  expect(result.status).toBe("completed")
  expect(result.toolCalls).toEqual([{ id: "tool-1", name: "answer", input: { value: "42" }, ok: true }])
  expect(sessions.messages.listBySession(session.id).map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ])
  expect(sessions.toolCalls.get("tool-1")?.status).toBe("completed")
  expect(provider.requests).toHaveLength(2)
  db.close()
})

const testTool: ToolDefinition<{ value: string }, { value: string }> = {
  name: "answer",
  description: "Returns a value",
  inputSchema: z.object({ value: z.string() }),
  modelInputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  execute(input) {
    return { value: input.value }
  },
}
