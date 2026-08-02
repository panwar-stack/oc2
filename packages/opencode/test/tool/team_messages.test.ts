import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamTable } from "@/team/team.sql"
import { eq } from "drizzle-orm"
import { TeamBroadcastTool } from "@/tool/team_broadcast"
import { TeamGetMessagesTool } from "@/tool/team_get_messages"
import { TeamPlanDecideTool } from "@/tool/team_plan_decide"
import { TeamPlanSubmitTool } from "@/tool/team_plan_submit"
import { TeamSendMessageTool } from "@/tool/team_send_message"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { wakeTeamSession } from "@/tool/team_wake"
import { Permission } from "@/permission"
import { SessionControl } from "@oc2-ai/core/session/control"
import { Runner } from "@/effect/runner"
import { Database } from "@oc2-ai/core/database/database"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { ModelID, ProviderID } from "@/provider/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    SessionControl.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const seed = Effect.fn("TeamMessagesTest.seed")(function* (input?: {
  planMode?: boolean
  permission?: Permission.Ruleset
}) {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const lead = yield* sessions.create({ title: "Lead" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: lead.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: lead.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  const info = yield* team.create({ name: "messages-team", goal: "Coordinate work", leadSessionID: lead.id })
  const worker = yield* sessions.create({ parentID: lead.id, title: "Worker", permission: input?.permission })
  const member = yield* team.addMember({
    teamID: info.id,
    sessionID: worker.id,
    name: "worker",
    agentType: "general",
    rolePrompt: "Do the work",
    planMode: input?.planMode,
    workMode: input?.planMode ? "plan" : "implement",
  })
  yield* team.updateMemberStatus(member.id, "active")
  return { lead, user, assistant, info, worker, member }
})

function context(input: {
  lead: Session.Info
  assistant: MessageV2.Assistant
  callID?: string
  messages?: MessageV2.WithParts[]
  extra?: { [key: string]: unknown }
}) {
  return {
    sessionID: input.lead.id,
    messageID: input.assistant.id,
    callID: input.callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: input.messages ?? [],
    extra: input.extra,
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function promptOps(input: {
  response: SessionV1.WithParts
  wake?: () => Effect.Effect<SessionV1.WithParts>
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.succeed(input.response),
    wake: input.wake ?? (() => Effect.succeed(input.response)),
    run: input.wake ?? (() => Effect.succeed(input.response)),
  }
}

const responseFor = (assistant: MessageV2.Assistant): SessionV1.WithParts => ({ info: assistant, parts: [] })

const planModePermission: Permission.Ruleset = [
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "/tmp/*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "write", pattern: "*", action: "deny" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "apply_patch", pattern: "*", action: "deny" },
]

const inheritedPermissionAfterApproval: Permission.Ruleset = [
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "/tmp/*", action: "deny" },
]

const expectedPermission = (
  rules: Permission.Ruleset,
): { permission: string; pattern: string; action: Permission.Action }[] =>
  rules.map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: rule.action }))

const previousEmptyCheck = (input: { lead: Session.Info; assistant: MessageV2.Assistant }) =>
  Session.Service.use((sessions) =>
    sessions.updatePart({
      id: PartID.ascending(),
      messageID: input.assistant.id,
      sessionID: input.lead.id,
      type: "tool",
      callID: "previous-empty-check",
      tool: "team_get_messages",
      state: {
        status: "completed",
        input: {},
        output: "No pending messages.",
        title: "Team Messages",
        metadata: { count: 0 },
        time: { start: Date.now(), end: Date.now() },
      },
    }),
  )

describe("tool.team_get_messages", () => {
  it.live("tells the lead that finalization parks automatically when the mailbox is empty", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { lead, assistant } = yield* seed()
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context({ lead, assistant, callID: "current-check" }))

          expect(result.title).toBe("Team Messages")
          expect(result.output).toContain("No pending messages.")
          expect(result.output).toContain("finalization parks automatically")
          expect(result.output).toContain("does not require ending this turn")
          expect(result.output).toContain("worker (general, active, session")
          expect(result.metadata.count).toBe(0)
          expect(result.metadata.repeated).toBe(false)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("blocks repeated empty mailbox polling in the same user turn", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { lead, user, assistant } = yield* seed()
          yield* previousEmptyCheck({ lead, assistant })
          const currentAssistant: MessageV2.Assistant = {
            ...assistant,
            id: MessageID.ascending(),
            parentID: user.id,
            time: { created: Date.now() },
          }
          yield* sessions.updateMessage(currentAssistant)
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {},
            context({
              lead,
              assistant: currentAssistant,
              callID: "current-check",
              messages: yield* sessions.messages({ sessionID: lead.id }),
            }),
          )

          expect(result.title).toBe("Team Messages (Polling Blocked)")
          expect(result.output).toContain("Repeated empty mailbox check suppressed")
          expect(result.output).toContain("Do not send routine status-check broadcasts")
          expect(result.metadata.count).toBe(0)
          expect(result.metadata.repeated).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("still delivers new messages after a previous empty check", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed()
          yield* previousEmptyCheck({ lead, assistant })
          yield* team.sendMessage({
            teamID: info.id,
            sender: member.session_id,
            recipients: [lead.id],
            body: "Implementation is complete.",
          })
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context({ lead, assistant, callID: "current-check" }))

          expect(result.title).toBe("Team Messages")
          expect(result.output).toContain("Implementation is complete.")
          expect(result.metadata.count).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("delivers a pending message to only one concurrent team_get_messages caller", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed()
          yield* team.sendMessage({
            teamID: info.id,
            sender: member.session_id,
            recipients: [lead.id],
            body: "Concurrent delivery check.",
          })
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const results = yield* Effect.all(
            [
              def.execute({}, context({ lead, assistant, callID: "read-a" })),
              def.execute({}, context({ lead, assistant, callID: "read-b" })),
            ],
            { concurrency: "unbounded" },
          )

          expect(results.reduce((count, result) => count + result.metadata.count, 0)).toBe(1)
          expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("tool.team_send_message", () => {
  it.live("rejects ambiguous recipient names", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const duplicate = yield* sessions.create({ parentID: lead.id, title: "Duplicate worker" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: duplicate.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Duplicate work",
          })
          const tool = yield* TeamSendMessageTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { recipient: "worker", body: "Please review." },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Team Message")
          expect(result.output).toContain("ambiguous")
          expect(result.output).toContain("session IDs")
          expect(yield* team.getPendingMessages(duplicate.id, info.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("sends to a session ID when names are ambiguous", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info, member } = yield* seed()
          const duplicate = yield* sessions.create({ parentID: lead.id, title: "Duplicate worker" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: duplicate.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Duplicate work",
          })
          const tool = yield* TeamSendMessageTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { recipient: member.session_id, body: "Please review." },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Message Sent")
          expect(yield* team.getPendingMessages(member.session_id, info.id)).toHaveLength(1)
          expect(yield* team.getPendingMessages(duplicate.id, info.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects messages to completed finite members without mailbox rows or wakes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const done = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_terminal_completed",
            name: "doneMember",
            agentType: "general",
            rolePrompt: "Finish",
          })
          yield* team.updateMemberStatus(done.id, "completed")
          const tool = yield* TeamSendMessageTool
          const def = yield* tool.init()

          const messagesBefore = yield* team.getMessages(info.id)
          const wakeCount = { value: 0 }
          const result = yield* def.execute(
            { recipient: "doneMember", body: "Hello" },
            context({
              lead,
              assistant,
              extra: {
                promptOps: promptOps({
                  response: responseFor(assistant),
                  wake: () =>
                    Effect.sync(() => {
                      wakeCount.value++
                    }).pipe(Effect.as(responseFor(assistant))),
                }),
              },
            }),
          )

          expect(result.title).toBe("Team Message")
          expect(result.output).toBe("Recipient 'doneMember' is completed and cannot receive messages.")
          expect(wakeCount.value).toBe(0)
          expect(yield* team.getPendingMessages(done.session_id, info.id)).toHaveLength(0)
          expect((yield* team.getMessages(info.id)).length).toBe(messagesBefore.length)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects multi-recipient sends when any finite member is terminal", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const done = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_terminal_multi_done",
            name: "doneMember",
            agentType: "general",
            rolePrompt: "Finish",
          })
          const cancelled = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_terminal_multi_cancelled",
            name: "cancelledMember",
            agentType: "general",
            rolePrompt: "Cancelled",
          })
          const failed = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_terminal_multi_failed",
            name: "failedMember",
            agentType: "general",
            rolePrompt: "Fail",
          })
          yield* team.updateMemberStatus(done.id, "completed")
          yield* team.updateMemberStatus(cancelled.id, "cancelled")
          yield* team.updateMemberStatus(failed.id, "failed", { failureCode: "provider_error" })
          const tool = yield* TeamSendMessageTool
          const def = yield* tool.init()

          const messagesBefore = yield* team.getMessages(info.id)
          const result = yield* def.execute(
            { recipient: `${done.session_id},${cancelled.session_id},${failed.session_id}`, body: "Hi" },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Team Message")
          expect(result.output).toContain("Recipient 'doneMember' is completed and cannot receive messages.")
          expect(result.output).toContain("Recipient 'cancelledMember' is cancelled and cannot receive messages.")
          expect(result.output).toContain("Recipient 'failedMember' is failed and cannot receive messages.")
          expect((yield* team.getMessages(info.id)).length).toBe(messagesBefore.length)
          for (const sessionID of [done.session_id, cancelled.session_id, failed.session_id]) {
            expect(yield* team.getPendingMessages(sessionID, info.id)).toHaveLength(0)
          }
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("still delivers to active members and idle daemons", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed()
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: "ses_idle_daemon",
            name: "sentinel",
            agentType: "general",
            rolePrompt: "Monitor",
            lifecycle: "daemon",
            daemonState: "initializing",
            daemonLastActive: Date.now(),
          })
          yield* team.updateMemberStatus(daemon.id, "idle", {
            daemonState: "idle",
            daemonLastActive: Date.now(),
          })
          const tool = yield* TeamSendMessageTool
          const def = yield* tool.init()

          const activeResult = yield* def.execute(
            { recipient: member.name, body: "Review this." },
            context({ lead, assistant }),
          )
          expect(activeResult.title).toBe("Message Sent")
          expect(yield* team.getPendingMessages(member.session_id, info.id)).toHaveLength(1)

          const daemonResult = yield* def.execute(
            { recipient: "sentinel", body: "Keep watching." },
            context({ lead, assistant }),
          )
          expect(daemonResult.title).toBe("Message Sent")
          expect(yield* team.getPendingMessages(daemon.session_id, info.id)).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("tool.team_plan_submit", () => {
  it.live("allows plan-mode members to submit plans", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { assistant, info, lead, worker } = yield* seed({ planMode: true })
          const tool = yield* TeamPlanSubmitTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { plan: "I will inspect then patch." },
            context({ lead: worker, assistant }),
          )

          expect(result.title).toBe("Plan Submitted")
          expect(result.output).toContain("Plan submitted")
          expect((yield* team.getPendingMessages(lead.id, info.id))[0]?.body).toContain("I will inspect then patch")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects non-members", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { assistant, lead } = yield* seed({ planMode: true })
          const outsider = yield* sessions.create({ title: "Outsider" })
          const tool = yield* TeamPlanSubmitTool
          const def = yield* tool.init()

          const result = yield* def.execute({ plan: "I should not submit." }, context({ lead: outsider, assistant }))

          expect(result.title).toBe("Plan Submit Failed")
          expect(result.output).toContain("Not a team member")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects members that are not in plan mode", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { assistant, worker } = yield* seed()
          const tool = yield* TeamPlanSubmitTool
          const def = yield* tool.init()

          const result = yield* def.execute({ plan: "I should not submit." }, context({ lead: worker, assistant }))

          expect(result.title).toBe("Plan Submit Failed")
          expect(result.output).toContain("Not in plan mode")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("tool.team_plan_decide", () => {
  it.live("rejects non-plan-mode members", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { assistant, lead, member } = yield* seed()
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { member_name: member.name, decision: "approve", feedback: "Proceed." },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Plan Decide Failed")
          expect(result.output).toContain("not in plan mode")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects ambiguous member names", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { assistant, info, lead } = yield* seed({ planMode: true })
          const duplicate = yield* sessions.create({ parentID: lead.id, title: "Duplicate worker" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: duplicate.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Duplicate work",
            planMode: true,
            workMode: "plan",
          })
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { member_name: "worker", decision: "reject", feedback: "Revise." },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Plan Decide Failed")
          expect(result.output).toContain("ambiguous")
          expect(result.output).toContain("session ID")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("approval clears plan mode and removes only the plan-mode permission overlay", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { assistant, lead, member } = yield* seed({ planMode: true, permission: planModePermission })
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { member_name: member.session_id, decision: "approve", feedback: "Proceed." },
            context({ lead, assistant }),
          )

          const approved = (yield* team.getMembers(member.team_id)).find((candidate) => candidate.id === member.id)
          expect(result.title).toBe("Plan Approved")
          expect(approved?.plan_mode).toBe(false)
          expect(approved?.work_mode).toBe("implement")
          expect(approved?.status).toBe("active")
          expect((yield* sessions.get(SessionID.make(member.session_id))).permission).toEqual(
            expectedPermission(inheritedPermissionAfterApproval),
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejection keeps plan-mode restrictions intact", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { assistant, lead, member } = yield* seed({ planMode: true, permission: planModePermission })
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { member_name: member.name, decision: "reject", feedback: "Revise." },
            context({ lead, assistant }),
          )

          const rejected = (yield* team.getMembers(member.team_id)).find((candidate) => candidate.id === member.id)
          expect(result.title).toBe("Plan Rejected")
          expect(rejected?.plan_mode).toBe(true)
          expect(rejected?.work_mode).toBe("plan")
          expect((yield* sessions.get(SessionID.make(member.session_id))).permission).toEqual(
            expectedPermission(planModePermission),
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("team message wake safety", () => {
  it.live("mailbox claims require an explicit durable acknowledgement", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, info, worker } = yield* seed()
          const message = yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [worker.id],
            body: "Persist before acknowledging.",
          })

          expect(yield* team.claimPendingMessages(worker.id, info.id)).toHaveLength(1)
          expect(yield* team.getPendingMessages(worker.id, info.id)).toHaveLength(0)
          expect((yield* team.getMessages(info.id)).find((item) => item.id === message.id)?.delivery_status).toBe(
            "pending",
          )

          yield* team.releaseClaimedMessages([message.id], worker.id)
          expect(yield* team.getPendingMessages(worker.id, info.id)).toHaveLength(1)

          yield* team.claimPendingMessages(worker.id, info.id)
          yield* team.markMessageDelivered(message.id, worker.id)
          expect((yield* team.getMessages(info.id)).find((item) => item.id === message.id)?.delivery_status).toBe(
            "delivered",
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("paused mailbox claims stay pending and fail with suspension", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const control = yield* SessionControl.Service
          const { lead, info, worker } = yield* seed()
          yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [worker.id],
            body: "Keep this pending.",
          })
          yield* control.pause({ rootSessionID: worker.id })

          const exit = yield* team.claimPendingMessages(worker.id, info.id).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
          expect(yield* team.getPendingMessages(worker.id, info.id)).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("paused team wake records a resume intent without starting the loop", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const { assistant, member } = yield* seed()
          const wakeCount = { value: 0 }
          yield* control.pause({ rootSessionID: SessionID.make(member.session_id) })

          yield* wakeTeamSession(
            promptOps({
              response: responseFor(assistant),
              wake: () =>
                Effect.sync(() => {
                  wakeCount.value++
                }).pipe(Effect.as(responseFor(assistant))),
            }),
            member.session_id,
          )

          expect(wakeCount.value).toBe(0)
          expect(yield* control.release(SessionID.make(member.session_id))).toMatchObject({
            resumableSessionIDs: [member.session_id],
          })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("wakeTeamSession intentionally wakes the target twice", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { assistant, member } = yield* seed()
          const wakeCount = { value: 0 }

          yield* wakeTeamSession(
            promptOps({
              response: responseFor(assistant),
              wake: () =>
                Effect.sync(() => {
                  wakeCount.value++
                }).pipe(Effect.as(responseFor(assistant))),
            }),
            member.session_id,
          )

          expect(wakeCount.value).toBe(2)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("team_send_message bounds lead wake waits", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { lead, assistant } = yield* seed()
          const tool = yield* TeamSendMessageTool
          const def = yield* tool.init()

          const result = yield* awaitWithTimeout(
            def.execute(
              { recipient: "worker", body: "Please review." },
              context({
                lead,
                assistant,
                extra: { promptOps: promptOps({ response: responseFor(assistant), wake: () => Effect.never }) },
              }),
            ),
            "team_send_message wake wait was unbounded",
            "3 seconds",
          )

          expect(result.title).toBe("Message Sent")
          expect(result.output).toContain("wake waits are bounded")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("team_broadcast bounds lead wake waits", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { lead, assistant } = yield* seed()
          const tool = yield* TeamBroadcastTool
          const def = yield* tool.init()

          const result = yield* awaitWithTimeout(
            def.execute(
              { body: "Scope changed." },
              context({
                lead,
                assistant,
                extra: { promptOps: promptOps({ response: responseFor(assistant), wake: () => Effect.never }) },
              }),
            ),
            "team_broadcast wake wait was unbounded",
            "3 seconds",
          )

          expect(result.title).toBe("Broadcast Sent")
          expect(result.output).toContain("wake waits are bounded")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("team_plan_decide bounds lead wake waits", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { lead, assistant, member } = yield* seed({ planMode: true })
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* awaitWithTimeout(
            def.execute(
              { member_name: member.name, decision: "reject", feedback: "Revise." },
              context({
                lead,
                assistant,
                extra: { promptOps: promptOps({ response: responseFor(assistant), wake: () => Effect.never }) },
              }),
            ),
            "team_plan_decide wake wait was unbounded",
            "3 seconds",
          )

          expect(result.title).toBe("Plan Rejected")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("team message usage events", () => {
  it.live("records broadcast events after successful sends", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamBroadcastTool
          const def = yield* tool.init()

          const result = yield* def.execute({ body: "Scope changed." }, context({ lead, assistant }))
          const events = yield* team.getUsageEvents(info.id)

          expect(result.title).toBe("Broadcast Sent")
          expect(events).toHaveLength(1)
          expect(events[0]).toEqual(
            expect.objectContaining({
              team_id: info.id,
              session_id: lead.id,
              type: "broadcast_sent",
              metadata: expect.objectContaining({ recipient_count: 1, lead_sender: true }),
            }),
          )
          expect(events[0].metadata.message_id).toBe(result.metadata.messageID)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("records plan approval events", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed({ planMode: true })
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { member_name: member.name, decision: "approve", feedback: "Proceed." },
            context({ lead, assistant }),
          )
          const events = yield* team.getUsageEvents(info.id)

          expect(result.title).toBe("Plan Approved")
          expect(events).toHaveLength(1)
          expect(events[0]).toEqual(
            expect.objectContaining({
              team_id: info.id,
              session_id: lead.id,
              member_id: member.id,
              type: "plan_approved",
              metadata: expect.objectContaining({
                member_name: member.name,
                target_session_id: member.session_id,
                feedback_provided: true,
              }),
            }),
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("records plan rejection events", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed({ planMode: true })
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            { member_name: member.name, decision: "reject" },
            context({ lead, assistant }),
          )
          const events = yield* team.getUsageEvents(info.id)

          expect(result.title).toBe("Plan Rejected")
          expect(events).toHaveLength(1)
          expect(events[0]).toEqual(
            expect.objectContaining({
              team_id: info.id,
              session_id: lead.id,
              member_id: member.id,
              type: "plan_rejected",
              metadata: expect.objectContaining({
                member_name: member.name,
                target_session_id: member.session_id,
                feedback_provided: false,
              }),
            }),
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

describe("team revision", () => {
  const revisionOf = (teamID: string) =>
    Database.Service.use((database) =>
      database.db
        .select({ revision: TeamTable.revision })
        .from(TeamTable)
        .where(eq(TeamTable.id, teamID))
        .get()
        .pipe(Effect.orDie),
    ).pipe(Effect.map((row) => row?.revision ?? -1))

  it.live("sending a message bumps the revision by exactly one", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, info, member } = yield* seed()
          const before = yield* revisionOf(info.id)

          yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [member.session_id],
            body: "Revision bump check.",
          })

          expect(yield* revisionOf(info.id)).toBe(before + 1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("claiming, delivering, reading, and waking do not bump the revision", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info, member } = yield* seed()
          const message = yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [member.session_id],
            body: "Delivery state must not bump.",
          })
          const afterSend = yield* revisionOf(info.id)

          // Claim (pending -> read) must not bump.
          yield* team.claimPendingMessages(member.session_id, info.id)
          expect(yield* revisionOf(info.id)).toBe(afterSend)

          // Delivery acknowledgement must not bump.
          yield* team.markMessageDelivered(message.id, member.session_id)
          expect(yield* revisionOf(info.id)).toBe(afterSend)

          // Reading the mailbox must not bump.
          yield* team.getPendingMessages(member.session_id, info.id)
          expect(yield* revisionOf(info.id)).toBe(afterSend)

          // Waking a session must not bump.
          yield* wakeTeamSession(
            promptOps({
              response: responseFor(assistant),
              wake: () => Effect.succeed(responseFor(assistant)),
            }),
            member.session_id,
          )
          expect(yield* revisionOf(info.id)).toBe(afterSend)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
