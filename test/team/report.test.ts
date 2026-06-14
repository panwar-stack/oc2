import { expect, test } from "bun:test"

import {
  createModelService,
  createSessionService,
  createTaskScheduler,
  createTeamService,
  createToolRegistry,
  defaultConfig,
  openOc2Database,
} from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

const config = {
  ...defaultConfig,
  runtime: { ...defaultConfig.runtime, maxConcurrentTeamMembers: 2, defaultTimeoutMs: 1_000 },
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

test("team report is deterministic for the same persisted team state", async () => {
  const { db, service, lead } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const member = await service.spawn({ leadSessionId: lead.id, name: "worker", agentId: "worker", rolePrompt: "Work" })
  const task = service.createTask({ sessionId: lead.id, description: "verify report", assignee: "worker" })
  service.updateTask({ sessionId: lead.id, taskId: task.id, status: "completed" })
  service.sendMessage({ sessionId: lead.id, senderSessionId: lead.id, recipients: ["worker"], body: "status?" })
  await waitForMemberStatus(service, member.id, ["completed"])

  const first = service.report({ sessionId: lead.id })
  const second = service.report({ sessionId: lead.id })

  expect(second).toEqual(first)
  expect(first.summary.members.completed).toBe(1)
  expect(first.summary.tasks.completed).toBe(1)
  expect(first.summary.mailbox.messages).toBe(1)
  expect(first.summary.placeholders).toEqual({ runtimeMs: null, costUsd: null })
  db.close()
})

test("team report includes pending approvals, daemon state, and residual failures", async () => {
  const { db, service, lead } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 13" })
  const planner = await service.spawn({
    leadSessionId: lead.id,
    name: "planner",
    agentId: "worker",
    rolePrompt: "Plan",
    planMode: true,
  })
  service.submitPlan({ sessionId: planner.sessionId, plan: "pending plan" })

  const report = service.report({ sessionId: lead.id })

  expect(report.summary.planApprovals).toMatchObject({ pending: 1, submitted: 1 })
  expect(report.summary.deterministicFindings).toContain("Member planner is awaiting plan approval.")
  expect(report.markdown).toContain("runtimeMs: unavailable")
  await Bun.sleep(30)
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
  const service = createTeamService({
    config,
    sessions,
    models: createModelService({ providers: [createScriptedModelProvider([simpleAssistantEvents])], scheduler }),
    registry: createToolRegistry([]),
    scheduler,
  })
  return { db, service, lead }
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
