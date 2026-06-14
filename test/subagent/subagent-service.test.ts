import { expect, test } from "bun:test"

import {
  createModelService,
  createSessionService,
  createSubAgentService,
  createTaskScheduler,
  createToolRegistry,
  defaultConfig,
  openOc2Database,
} from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

const subagentConfig = {
  ...defaultConfig,
  agents: {
    worker: {
      id: "worker",
      name: "Worker",
      mode: "subagent" as const,
      systemPrompt: "Worker prompt",
      allowedTools: [],
      maxIterations: 20,
    },
  },
}

test("subagent creates a child session without copying hidden parent transcript", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  sessions.appendMessage({ sessionId: parent.id, role: "user", parts: [{ type: "text", text: "parent secret" }] })
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const service = createService({ db, sessions, provider })

  const result = await service.run({ parentSessionId: parent.id, agentId: "worker", prompt: "child task" })

  const child = sessions.resumeSession(result.sessionId)
  expect(result.status).toBe("completed")
  expect(child?.parentSessionId).toBe(parent.id)
  expect(child?.workspaceRoots.map(({ path, readonly }) => ({ path, readonly }))).toEqual(
    parent.workspaceRoots.map(({ path, readonly }) => ({ path, readonly })),
  )
  expect(child?.agentId).toBe("worker")
  expect(sessions.messages.listBySession(result.sessionId).map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(provider.requests[0]?.messages.some((message) => message.content.includes("parent secret"))).toBe(false)
  db.close()
})

test("subagent rejects background mode unless explicitly configured", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const service = createService({ db, sessions, provider: createScriptedModelProvider([simpleAssistantEvents]) })

  await expect(
    service.run({ parentSessionId: parent.id, agentId: "worker", prompt: "child task", background: true }),
  ).rejects.toThrow("Background subagents require explicit service configuration")
  db.close()
})

test("subagent returns a running background result when configured", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const service = createService({
    db,
    sessions,
    provider: createScriptedModelProvider([simpleAssistantEvents], { delayMs: 5 }),
    allowBackground: true,
  })

  const result = await service.run({
    parentSessionId: parent.id,
    agentId: "worker",
    prompt: "child task",
    background: true,
  })

  expect(result.status).toBe("running")
  expect(result.background).toBe(true)
  expect(result.taskId).toBeTruthy()
  await Bun.sleep(20)
  db.close()
})

test("subagent parent cancellation cancels the child task", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const provider = createScriptedModelProvider([simpleAssistantEvents], { delayMs: 50 })
  const service = createService({ db, sessions, provider })
  const controller = new AbortController()

  const result = service.run({
    parentSessionId: parent.id,
    agentId: "worker",
    prompt: "child task",
    signal: controller.signal,
  })
  controller.abort("stop parent")

  await expect(result).resolves.toMatchObject({ status: "failed", errors: [{ code: "cancelled" }] })
  db.close()
})

test("subagent timeout returns a structured failed result", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const parent = sessions.createSession({
    id: "parent-1",
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const provider = createScriptedModelProvider([simpleAssistantEvents], { delayMs: 50 })
  const service = createService({ db, sessions, provider })

  const result = await service.run({
    parentSessionId: parent.id,
    agentId: "worker",
    prompt: "child task",
    timeoutMs: 1,
  })

  expect(result.status).toBe("failed")
  expect(result.errors[0]?.code).toBe("timed_out")
  db.close()
})

function createService(input: {
  readonly db: ReturnType<typeof openOc2Database>
  readonly sessions: ReturnType<typeof createSessionService>
  readonly provider: ReturnType<typeof createScriptedModelProvider>
  readonly allowBackground?: boolean
}) {
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1_000,
  })
  return createSubAgentService({
    config: subagentConfig,
    sessions: input.sessions,
    models: createModelService({ providers: [input.provider], scheduler }),
    registry: createToolRegistry([]),
    scheduler,
    allowBackground: input.allowBackground,
  })
}
