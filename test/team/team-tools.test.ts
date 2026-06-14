import { expect, test } from "bun:test"

import {
  createModelService,
  createSessionService,
  createTaskScheduler,
  createTeamService,
  createTeamTools,
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

test("team tools register only PR 12 team tool names", () => {
  const { registry, db } = createFixture()

  expect(
    registry
      .list()
      .map((tool) => tool.name)
      .toSorted(),
  ).toEqual([
    "team_broadcast",
    "team_create",
    "team_get_messages",
    "team_send_message",
    "team_shutdown",
    "team_spawn",
    "team_task_claim",
    "team_task_create",
    "team_task_list",
    "team_task_update",
  ])
  expect(registry.get("team_report")).toBeUndefined()
  expect(registry.get("team_plan_submit")).toBeUndefined()
  db.close()
})

test("team create and task tools execute through the normal tool executor", async () => {
  const { executor, lead, db } = createFixture()
  const signal = new AbortController().signal

  const created = await executor.execute(
    { id: "call-1", name: "team_create", arguments: { name: "core", goal: "ship PR 12" }, sessionId: lead.id },
    { workspaceRoots: [], signal, sessionId: lead.id },
  )
  const task = await executor.execute(
    { id: "call-2", name: "team_task_create", arguments: { description: "write tests" }, sessionId: lead.id },
    { workspaceRoots: [], signal, sessionId: lead.id },
  )
  const list = await executor.execute(
    { id: "call-3", name: "team_task_list", arguments: {}, sessionId: lead.id },
    { workspaceRoots: [], signal, sessionId: lead.id },
  )

  expect(created.ok).toBe(true)
  expect(task.ok ? task.output : undefined).toMatchObject({ description: "write tests", status: "pending" })
  expect(list.ok ? list.output : undefined).toMatchObject([{ description: "write tests" }])
  db.close()
})

test("team tools validate input and preserve structured runtime failures", async () => {
  const { executor, lead, db } = createFixture()
  const signal = new AbortController().signal

  const invalid = await executor.execute(
    { id: "call-1", name: "team_create", arguments: { name: "missing goal" }, sessionId: lead.id },
    { workspaceRoots: [], signal, sessionId: lead.id },
  )
  const missingTeam = await executor.execute(
    { id: "call-2", name: "team_task_list", arguments: {}, sessionId: lead.id },
    { workspaceRoots: [], signal, sessionId: lead.id },
  )

  expect(invalid.ok).toBe(false)
  expect(invalid.ok ? undefined : invalid.error.code).toBe("validation_failed")
  expect(missingTeam.ok).toBe(false)
  expect(missingTeam.ok ? undefined : missingTeam.error.code).toBe("team_failed")
  expect(missingTeam.ok ? undefined : missingTeam.error.runtimeError?.kind).toBe("team")
  db.close()
})

test("team tools require a session context", async () => {
  const { executor, db } = createFixture()

  const result = await executor.execute(
    { id: "call-1", name: "team_create", arguments: { name: "core", goal: "ship" } },
    { workspaceRoots: [], signal: new AbortController().signal },
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.error.code).toBe("missing_session")
  db.close()
})

function createFixture() {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const lead = sessions.createSession({
    id: "lead-1",
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
  const service = createTeamService({
    config,
    sessions,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents])], scheduler }),
    registry,
    scheduler,
  })
  for (const teamTool of createTeamTools({ service })) registry.register(teamTool)
  const executor = createToolExecutor({ registry, scheduler, config })
  return { db, sessions, lead, registry, executor }
}
