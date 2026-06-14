import { expect, test } from "bun:test"
import { z } from "zod"

import {
  createModelService,
  createSessionService,
  createSessionRunService,
  createTaskScheduler,
  createTeamService,
  createTeamTools,
  createToolExecutor,
  createToolRegistry,
  defaultConfig,
  openOc2Database,
  type ToolDefinition,
} from "../../src"
import type { ModelEvent } from "../../src/model/provider"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

const config = {
  ...defaultConfig,
  runtime: { ...defaultConfig.runtime, maxConcurrentTeamMembers: 1, defaultTimeoutMs: 1_000 },
  agents: {
    planner: {
      id: "planner",
      name: "Planner",
      mode: "subagent" as const,
      systemPrompt: "Planner prompt",
      allowedTools: [],
      maxIterations: 20,
    },
  },
}

test("plan-mode members cannot run until lead approval", async () => {
  const { db, service, lead } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })

  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })

  expect(member.status).toBe("plan_pending")
  await waitForMemberStatus(service, member.id, ["plan_pending"])
  expect(service.teams.getMember(member.id)?.schedulerTaskId).toBeTruthy()

  const submitted = service.submitPlan({ sessionId: member.sessionId, plan: "1. inspect\n2. implement" })
  expect(submitted.planStatus).toBe("submitted")
  expect(service.mailbox.counts(submitted.teamId).pendingDeliveries).toBe(1)

  service.decidePlan({ leadSessionId: lead.id, member: "planner", decision: "approved", feedback: "Proceed" })
  await waitForMemberStatus(service, member.id, ["completed"])

  const approved = service.teams.getMember(member.id)
  expect(approved).toMatchObject({ planMode: false, planStatus: "approved", planDecision: "approved" })
  db.close()
})

test("plan rejection preserves plan gate", async () => {
  const { db, service, lead } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })

  service.submitPlan({ sessionId: member.sessionId, plan: "too broad" })
  const rejected = service.decidePlan({
    leadSessionId: lead.id,
    member: member.sessionId,
    decision: "rejected",
    feedback: "Narrow scope",
  })

  expect(rejected).toMatchObject({ status: "plan_pending", planMode: true, planStatus: "rejected" })
  await Bun.sleep(20)
  expect(service.teams.getMember(member.id)?.status).toBe("plan_pending")
  db.close()
})

test("plan-mode execution blocks hidden mutating tool calls", async () => {
  const { db, service, lead, sessions, registry } = createFixture({
    batches: [[{ type: "tool-call", call: { id: "hidden-write", name: "bash", arguments: {} } }, { type: "done" }]],
  })
  registry.register(hiddenDangerousTool())
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })

  await waitForMemberStatus(service, member.id, ["plan_pending"])

  const call = sessions.toolCalls.listBySession(member.sessionId).find((toolCall) => toolCall.id === "hidden-write")
  expect(call).toMatchObject({ name: "bash", status: "failed" })
  expect(call?.error?.message).toBe("Tool is disabled: bash")
  expect(service.teams.getMember(member.id)?.planStatus).toBe("none")
  db.close()
})

test("plan-mode execution blocks hidden team mutation tool calls", async () => {
  const { db, service, lead, sessions } = createFixture({
    batches: [
      [
        {
          type: "tool-call",
          call: { id: "hidden-task", name: "team_task_create", arguments: { description: "mutate before approval" } },
        },
        { type: "done" },
      ],
    ],
  })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })

  await waitForMemberStatus(service, member.id, ["plan_pending"])

  const call = sessions.toolCalls.listBySession(member.sessionId).find((toolCall) => toolCall.id === "hidden-task")
  expect(call).toMatchObject({ name: "team_task_create", status: "failed" })
  expect(call?.error?.message).toBe("Tool is disabled: team_task_create")
  expect(service.tasks.list(member.teamId)).toHaveLength(0)
  db.close()
})

test("plan submit and decide reject shutdown teams", async () => {
  const { db, service, lead } = createFixture()
  const team = service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })
  await Bun.sleep(30)

  service.shutdown({ leadSessionId: lead.id, teamId: team.id })

  expect(() => service.submitPlan({ sessionId: member.sessionId, teamId: team.id, plan: "late" })).toThrow(
    "Team is not active",
  )
  expect(() =>
    service.decidePlan({ leadSessionId: lead.id, teamId: team.id, member: "planner", decision: "approved" }),
  ).toThrow("Team is not active")
  expect(service.teams.getMember(member.id)?.status).toBe("cancelled")
  await Bun.sleep(30)
  db.close()
})

test("approval waits for active planning run before implementation", async () => {
  const { db, service, lead, provider } = createFixture({ delayMs: 40, maxConcurrentTeamMembers: 4 })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })

  service.submitPlan({ sessionId: member.sessionId, plan: "small plan" })
  service.decidePlan({ leadSessionId: lead.id, member: "planner", decision: "approved" })
  await waitForMemberStatus(service, member.id, ["completed"])

  expect(provider.requests).toHaveLength(2)
  expect(service.teams.getMember(member.id)).toMatchObject({ status: "completed", planStatus: "approved" })
  db.close()
})

test("dependent plan-mode members start planning after dependencies complete", async () => {
  const { db, service, lead } = createFixture({ delayMs: 20, maxConcurrentTeamMembers: 1 })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const first = await service.spawn({ leadSessionId: lead.id, name: "first", agentId: "planner", rolePrompt: "Work" })
  const second = await service.spawn({
    leadSessionId: lead.id,
    name: "second",
    agentId: "planner",
    rolePrompt: "Plan after first",
    dependsOn: ["first"],
    planMode: true,
  })

  expect(service.teams.getMember(second.id)?.status).toBe("blocked")
  await waitForMemberStatus(service, first.id, ["completed"])
  await waitForMemberStatus(service, second.id, ["plan_pending"])

  expect(service.teams.getMember(second.id)).toMatchObject({ status: "plan_pending", planMode: true })
  db.close()
})

test("generic session runs cannot bypass unapproved plan mode", async () => {
  const { db, service, lead, sessions, scheduler } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })
  await Bun.sleep(30)
  const runner = createSessionRunService({
    config,
    cwd: "/repo",
    database: db,
    sessions,
    scheduler,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
  })

  await expect(runner.run({ sessionId: member.sessionId, prompt: "bypass" })).rejects.toThrow("before plan approval")
  db.close()
})

test("plan tools execute through normal tool executor", async () => {
  const { db, service, lead, executor } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "planner",
    rolePrompt: "Plan first",
    planMode: true,
  })
  const signal = new AbortController().signal

  const submitted = await executor.execute(
    { id: "submit", name: "team_plan_submit", arguments: { plan: "minimal plan" }, sessionId: member.sessionId },
    { workspaceRoots: [], signal, sessionId: member.sessionId },
  )
  const decided = await executor.execute(
    {
      id: "decide",
      name: "team_plan_decide",
      arguments: { member: "planner", decision: "approved" },
      sessionId: lead.id,
    },
    { workspaceRoots: [], signal, sessionId: lead.id },
  )

  expect(submitted.ok).toBe(true)
  expect(decided.ok).toBe(true)
  await waitForMemberStatus(service, member.id, ["completed"])
  db.close()
})

function createFixture(
  input: {
    readonly batches?: readonly (readonly ModelEvent[])[]
    readonly delayMs?: number
    readonly maxConcurrentTeamMembers?: number
  } = {},
) {
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
  const provider = createScriptedModelProvider(input.batches ?? [simpleAssistantEvents, simpleAssistantEvents], {
    delayMs: input.delayMs,
  })
  const fixtureConfig = {
    ...config,
    runtime: {
      ...config.runtime,
      maxConcurrentTeamMembers: input.maxConcurrentTeamMembers ?? config.runtime.maxConcurrentTeamMembers,
    },
  }
  const service = createTeamService({
    config: fixtureConfig,
    sessions,
    models: createModelService({
      providers: [provider],
      scheduler,
    }),
    registry,
    scheduler,
  })
  for (const tool of createTeamTools({ service })) registry.register(tool)
  const executor = createToolExecutor({ registry, scheduler, config: fixtureConfig })
  return { db, service, lead, executor, sessions, scheduler, registry, provider }
}

function hiddenDangerousTool(): ToolDefinition<Record<string, never>, { readonly executed: true }> {
  return {
    name: "bash",
    description: "Test-only mutating tool stand-in",
    inputSchema: z.object({}),
    modelInputSchema: { type: "object", properties: {} },
    execute: () => ({ executed: true }),
  }
}

async function waitForMemberStatus(
  service: ReturnType<typeof createTeamService>,
  memberId: string,
  statuses: readonly string[],
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = service.teams.getMember(memberId)?.status
    if (status && statuses.includes(status)) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for member ${memberId}`)
}
