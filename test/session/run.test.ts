import { expect, test } from "bun:test"
import { z } from "zod"

import { createSessionRunService, createToolRegistry, defaultConfig, ModelProviderError, openOc2Database, type ToolDefinition } from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

test("run creates session, persists user prompt and assistant response", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [createScriptedModelProvider([simpleAssistantEvents])] })

  const result = await service.run({ prompt: "hello", model: "fake/test" })

  expect(result.status).toBe("completed")
  expect(service.sessions.messages.listBySession(result.sessionId).map((message) => message.role)).toEqual(["user", "assistant"])
  db.close()
})

test("run resumes an existing session and appends new prompt", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents])] })
  const first = await service.run({ prompt: "first", model: "fake/test" })

  const second = await service.run({ sessionId: first.sessionId, prompt: "second", model: "fake/test" })

  expect(second.sessionId).toBe(first.sessionId)
  expect(service.sessions.messages.listBySession(first.sessionId).filter((message) => message.role === "user")).toHaveLength(2)
  db.close()
})

test("one active model run per session is enforced", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents], { delayMs: 20 })
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })
  const session = service.sessions.createSession({ id: "session-1", workspaceRoots: [{ path: "/repo", readonly: false }], providerId: "fake", modelId: "test", agentId: "main" })

  const first = service.run({ sessionId: session.id, prompt: "first" })
  await expect(service.run({ sessionId: session.id, prompt: "second" })).rejects.toThrow("already active")
  await first
  db.close()
})

test("persisted running status blocks another run service", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const first = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [createScriptedModelProvider([simpleAssistantEvents])] })
  const second = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [createScriptedModelProvider([simpleAssistantEvents])] })
  const session = first.sessions.createSession({ id: "session-1", workspaceRoots: [{ path: "/repo", readonly: false }], providerId: "fake", modelId: "test", agentId: "main", status: "running" })

  await expect(second.run({ sessionId: session.id, prompt: "second" })).rejects.toThrow("already active")
  db.close()
})

test("per-run disabled tools are enforced during execution", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let executions = 0
  const registry = createToolRegistry([countingTool(() => { executions += 1 })])
  const provider = createScriptedModelProvider([
    [{ type: "tool-call", call: { id: "tool-1", name: "count", arguments: {} } }, { type: "done" }],
    simpleAssistantEvents,
  ])
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, registry, providers: [provider] })

  const result = await service.run({ prompt: "call disabled tool", model: "fake/test", disabledTools: ["count"] })

  expect(executions).toBe(0)
  expect(result.toolCalls).toEqual([{ id: "tool-1", name: "count", input: {}, ok: false }])
  expect(service.sessions.toolCalls.get("tool-1")?.status).toBe("failed")
  db.close()
})

test("fatal model error leaves session resumable", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const failing = {
    id: "fake",
    name: "Failing",
    async listModels() { return [{ id: "test" }] },
    async *stream() { throw new ModelProviderError({ message: "bad key", classification: "auth", retryable: false }); yield { type: "done" as const } },
  }
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [failing] })

  const result = await service.run({ prompt: "hello", model: "fake/test" })

  expect(result.status).toBe("failed")
  expect(service.sessions.resumeSession(result.sessionId)?.id).toBe(result.sessionId)
  expect(service.sessions.messages.listBySession(result.sessionId).at(-1)?.status).toBe("failed")
  db.close()
})

function countingTool(onExecute: () => void): ToolDefinition<Record<string, never>, string> {
  return {
    name: "count",
    description: "Counts executions",
    inputSchema: z.object({}),
    modelInputSchema: { type: "object", properties: {} },
    execute() {
      onExecute()
      return "counted"
    },
  }
}
