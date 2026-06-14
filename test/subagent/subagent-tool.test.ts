import { expect, test } from "bun:test"

import {
  createModelService,
  createSessionService,
  createSubAgentService,
  createSubAgentTool,
  createTaskScheduler,
  createToolExecutor,
  createToolRegistry,
  defaultConfig,
  openOc2Database,
} from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

const config = {
  ...defaultConfig,
  agents: {
    worker: {
      id: "worker",
      mode: "subagent" as const,
      systemPrompt: "Worker prompt",
      allowedTools: [],
      maxIterations: 20,
    },
  },
}

test("subagent tool returns structured child run output", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1_000,
  })
  const registry = createToolRegistry([])
  const service = createSubAgentService({
    config,
    sessions,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents])], scheduler }),
    registry,
    scheduler,
  })
  registry.register(createSubAgentTool({ service }))
  const executor = createToolExecutor({ registry, scheduler, config })

  const result = await executor.execute(
    { id: "call-1", name: "subagent", arguments: { agentId: "worker", prompt: "child task" }, sessionId: parent.id },
    { workspaceRoots: [], signal: new AbortController().signal, sessionId: parent.id },
  )

  expect(result.ok).toBe(true)
  expect(result.ok ? result.output : undefined).toMatchObject({ childSessionId: expect.any(String), status: "completed" })
  expect(result.ok ? result.output : undefined).not.toHaveProperty("parentSessionId")
  db.close()
})

test("subagent tool converts child timeout into a structured tool error", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1_000,
  })
  const registry = createToolRegistry([])
  const service = createSubAgentService({
    config,
    sessions,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents], { delayMs: 50 })], scheduler }),
    registry,
    scheduler,
  })
  registry.register(createSubAgentTool({ service }))
  const executor = createToolExecutor({ registry, scheduler, config })

  const result = await executor.execute(
    {
      id: "call-1",
      name: "subagent",
      arguments: { agentId: "worker", prompt: "child task", timeoutMs: 1 },
      sessionId: parent.id,
    },
    { workspaceRoots: [], signal: new AbortController().signal, sessionId: parent.id },
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.error.code).toBe("subagent_failed")
  expect(result.ok ? undefined : result.error.runtimeError?.code).toBe("timed_out")
  db.close()
})

test("subagent tool validates CreateSubAgentInput through normal tool execution", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1_000,
  })
  const service = createSubAgentService({
    config,
    sessions,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents])], scheduler }),
    registry: createToolRegistry([]),
    scheduler,
  })
  const registry = createToolRegistry([createSubAgentTool({ service })])
  const executor = createToolExecutor({ registry, scheduler, config })

  const result = await executor.execute(
    { id: "call-1", name: "subagent", arguments: { agentId: "worker" }, sessionId: "parent-1" },
    { workspaceRoots: [], signal: new AbortController().signal, sessionId: "parent-1" },
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.error.code).toBe("validation_failed")
  db.close()
})

test("subagent tool preserves structured errors before scheduling", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1_000,
  })
  const registry = createToolRegistry([])
  const service = createSubAgentService({
    config,
    sessions,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents])], scheduler }),
    registry,
    scheduler,
  })
  registry.register(createSubAgentTool({ service }))
  const executor = createToolExecutor({ registry, scheduler, config })

  const result = await executor.execute(
    { id: "call-1", name: "subagent", arguments: { agentId: "missing", prompt: "child task" }, sessionId: parent.id },
    { workspaceRoots: [], signal: new AbortController().signal, sessionId: parent.id },
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.error.code).toBe("subagent_failed")
  expect(result.ok ? undefined : result.error.runtimeError?.code).toBe("invalid_task")
  db.close()
})
