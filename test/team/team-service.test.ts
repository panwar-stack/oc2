import { expect, test } from "bun:test"

import {
  createModelService,
  createRuntimeEventBus,
  createSessionService,
  createTaskScheduler,
  createTeamService,
  createToolRegistry,
  defaultConfig,
  openOc2Database,
} from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

const teamConfig = {
  ...defaultConfig,
  runtime: { ...defaultConfig.runtime, maxConcurrentTeamMembers: 1, defaultTimeoutMs: 1_000 },
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

test("team service persists teams, members, mailbox messages, and shutdown lifecycle", async () => {
  const { db, service, sessions, lead } = createFixture()
  const team = service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })

  const member = await service.spawn({ leadSessionId: lead.id, name: "reviewer", agentId: "worker", rolePrompt: "Review" })
  await waitForMemberStatus(service, member.id, ["completed"])
  const message = service.sendMessage({ sessionId: lead.id, senderSessionId: lead.id, recipients: ["reviewer"], body: "hello" })
  const delivered = service.getMessages({ sessionId: member.sessionId })
  const shutdown = service.shutdown({ leadSessionId: lead.id, teamId: team.id })

  expect(team.status).toBe("active")
  expect(member.teamId).toBe(team.id)
  expect(sessions.resumeSession(member.sessionId)?.teamId).toBe(team.id)
  expect(message.deliveryStatus).toBe("pending")
  expect(delivered.map((item) => item.body)).toEqual(["hello"])
  expect(shutdown.status).toBe("shutdown")
  db.close()
})

test("team spawn enforces bounded active members", async () => {
  const { db, service, lead } = createFixture({ delayMs: 50 })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })

  const first = await service.spawn({ leadSessionId: lead.id, name: "one", agentId: "worker", rolePrompt: "First" })

  await expect(service.spawn({ leadSessionId: lead.id, name: "two", agentId: "worker", rolePrompt: "Second" })).rejects.toThrow(
    "Team member limit reached",
  )
  await waitForMemberStatus(service, first.id, ["completed", "failed"])
  db.close()
})

test("team member dependencies gate blocked teammates until completion", async () => {
  const { db, service, lead } = createFixture({ delayMs: 20, maxConcurrentTeamMembers: 1 })
  const team = service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })

  const first = await service.spawn({ leadSessionId: lead.id, name: "first", agentId: "worker", rolePrompt: "First" })
  const second = await service.spawn({ leadSessionId: lead.id, name: "second", agentId: "worker", rolePrompt: "Second", dependsOn: ["first"] })
  expect(service.teams.getMember(second.id)?.status).toBe("blocked")
  await waitForMemberStatus(service, first.id, ["completed"])
  await waitForMemberStatus(service, second.id, ["completed"])

  expect(service.teams.getMember(second.id)?.status).not.toBe("blocked")
  expect(service.teams.listMembers(team.id).map((member) => member.id)).toContain(first.id)
  db.close()
})

test("dependency unblock path respects active team member capacity", async () => {
  const { db, service, lead } = createFixture({ delayMs: 25, maxConcurrentTeamMembers: 1 })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const first = await service.spawn({ leadSessionId: lead.id, name: "first", agentId: "worker", rolePrompt: "First" })
  const second = await service.spawn({ leadSessionId: lead.id, name: "second", agentId: "worker", rolePrompt: "Second", dependsOn: ["first"] })
  const third = await service.spawn({ leadSessionId: lead.id, name: "third", agentId: "worker", rolePrompt: "Third", dependsOn: ["first"] })

  await waitForMemberStatus(service, first.id, ["completed"])
  await Bun.sleep(5)
  const unblocked = [service.teams.getMember(second.id)?.status, service.teams.getMember(third.id)?.status]

  expect(unblocked.filter((status) => status === "starting" || status === "active")).toHaveLength(1)
  expect(unblocked.filter((status) => status === "blocked")).toHaveLength(1)
  await waitForMemberStatus(service, second.id, ["completed"])
  await waitForMemberStatus(service, third.id, ["completed"])
  db.close()
})

test("team task claim is dependency-aware and transactional", () => {
  const { db, service, lead } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const setup = service.createTask({ sessionId: lead.id, description: "setup" })
  const dependent = service.createTask({ sessionId: lead.id, description: "dependent", dependencyIds: [setup.id] })

  expect(() => service.claimTask({ sessionId: lead.id, taskId: dependent.id, assignee: "worker" })).toThrow("dependency is not completed")
  expect(service.tasks.get(dependent.id)?.status).toBe("pending")
  service.updateTask({ sessionId: lead.id, taskId: setup.id, status: "completed" })

  expect(service.claimTask({ sessionId: lead.id, taskId: dependent.id, assignee: "worker" }).status).toBe("in_progress")
  db.close()
})

test("daemon teammates require reporting criteria and nested teams are rejected", async () => {
  const { db, service, sessions, lead } = createFixture()
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })

  await expect(
    service.spawn({ leadSessionId: lead.id, name: "daemon", agentId: "worker", rolePrompt: "Watch", lifecycle: "daemon" }),
  ).rejects.toThrow("Daemon teammates require explicit reporting criteria")
  await expect(service.spawn({ leadSessionId: lead.id, name: "lead", agentId: "worker", rolePrompt: "Confuse alias" })).rejects.toThrow(
    "reserved",
  )

  const child = sessions.createSession({
    id: "child-1",
    parentSessionId: lead.id,
    workspaceRoots: [],
    providerId: "fake",
    modelId: "test",
    agentId: "worker",
  })
  expect(() => service.create({ leadSessionId: child.id, name: "nested", goal: "nope" })).toThrow("Nested teams")
  db.close()
})

test("task mutation and shutdown are scoped to authorized team sessions", async () => {
  const { db, service, sessions, lead } = createFixture()
  const team = service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const member = await service.spawn({ leadSessionId: lead.id, name: "worker", agentId: "worker", rolePrompt: "Work" })
  const outsider = sessions.createSession({ id: "outsider", workspaceRoots: [], providerId: "fake", modelId: "test", agentId: "main" })
  const task = service.createTask({ sessionId: lead.id, description: "scoped" })

  expect(() => service.claimTask({ sessionId: outsider.id, taskId: task.id, assignee: "outsider" })).toThrow("not part of team")
  expect(() => service.updateTask({ sessionId: outsider.id, taskId: task.id, status: "completed" })).toThrow("not part of team")
  expect(() => service.claimTask({ sessionId: member.sessionId, taskId: task.id, assignee: "other" })).toThrow("Only the lead or assignee")
  service.claimTask({ sessionId: member.sessionId, taskId: task.id, assignee: "worker" })
  expect(() => service.updateTask({ sessionId: member.sessionId, taskId: task.id, assignee: "other" })).toThrow("cannot claim or reassign")
  expect(() => service.shutdown({ leadSessionId: member.sessionId, teamId: team.id })).toThrow("Only the lead session")

  await waitForMemberStatus(service, member.id, ["completed", "failed"])
  db.close()
})

test("shutdown cancels active teammate work and preserves cancelled member state", async () => {
  const { db, service, lead } = createFixture({ delayMs: 100 })
  const team = service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const member = await service.spawn({ leadSessionId: lead.id, name: "slow", agentId: "worker", rolePrompt: "Slow work" })

  service.shutdown({ leadSessionId: lead.id, teamId: team.id })
  await Bun.sleep(20)

  expect(service.teams.getMember(member.id)?.status).toBe("cancelled")
  db.close()
})

test("shutdown cancels active teammate work from another team service instance", async () => {
  const { db, service, lead, sessions, models, registry, scheduler } = createFixture({ delayMs: 100 })
  const team = service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const member = await service.spawn({ leadSessionId: lead.id, name: "slow", agentId: "worker", rolePrompt: "Slow work" })
  const secondService = createTeamService({ config: teamConfig, sessions, models, registry, scheduler })

  secondService.shutdown({ leadSessionId: lead.id, teamId: team.id })
  await Bun.sleep(150)

  expect(secondService.teams.getMember(member.id)?.status).toBe("cancelled")
  expect(sessions.resumeSession(member.sessionId)?.status).not.toBe("completed")
  db.close()
})

test("daemon teammates cannot broadcast mailbox spam", async () => {
  const { db, service, lead } = createFixture({ maxConcurrentTeamMembers: 2 })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const daemon = await service.spawn({
    leadSessionId: lead.id,
    name: "watcher",
    agentId: "worker",
    rolePrompt: "Watch",
    lifecycle: "daemon",
    daemonReportingCriteria: "Only report build failures",
  })

  await waitForMemberStatus(service, daemon.id, ["idle", "failed"])

  expect(() => service.broadcast({ sessionId: daemon.sessionId, senderSessionId: daemon.sessionId, body: "noise" })).toThrow(
    "cannot broadcast",
  )
  db.close()
})

test("broadcast emits delivery events for each recipient", async () => {
  const events = createRuntimeEventBus()
  const delivered: string[] = []
  events.subscribe("team.message.delivered", (event) => delivered.push(event.payload.recipientId))
  const { db, service, lead } = createFixture({ events, maxConcurrentTeamMembers: 2 })
  service.create({ leadSessionId: lead.id, name: "core", goal: "ship PR 12" })
  const one = await service.spawn({ leadSessionId: lead.id, name: "one", agentId: "worker", rolePrompt: "First" })
  const two = await service.spawn({ leadSessionId: lead.id, name: "two", agentId: "worker", rolePrompt: "Second" })

  service.broadcast({ sessionId: lead.id, senderSessionId: lead.id, body: "all" })

  expect(delivered.toSorted()).toEqual(["one", "two"])
  await waitForMemberStatus(service, one.id, ["completed", "failed"])
  await waitForMemberStatus(service, two.id, ["completed", "failed"])
  db.close()
})

function createFixture(input: { readonly delayMs?: number; readonly maxConcurrentTeamMembers?: number; readonly events?: ReturnType<typeof createRuntimeEventBus> } = {}) {
  const db = openOc2Database({ path: ":memory:" })
  const sessions = createSessionService({ database: db })
  const lead = sessions.createSession({
    id: "lead-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })
  const scheduler = createTaskScheduler({
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    defaultTimeoutMs: 1_000,
  })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents, simpleAssistantEvents], {
    delayMs: input.delayMs,
  })
  const config = {
      ...teamConfig,
      runtime: {
        ...teamConfig.runtime,
        maxConcurrentTeamMembers: input.maxConcurrentTeamMembers ?? teamConfig.runtime.maxConcurrentTeamMembers,
      },
    }
  const models = createModelService({ providers: [provider], scheduler })
  const registry = createToolRegistry([])
  const service = createTeamService({
    config,
    sessions,
    models,
    registry,
    scheduler,
    events: input.events,
  })
  return { db, sessions, lead, service, models, registry, scheduler }
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
