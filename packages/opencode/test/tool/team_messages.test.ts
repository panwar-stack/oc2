import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamBroadcastTool } from "@/tool/team_broadcast"
import { TeamGetMessagesTool } from "@/tool/team_get_messages"
import { TeamPlanDecideTool } from "@/tool/team_plan_decide"
import { TeamSendMessageTool } from "@/tool/team_send_message"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { wakeTeamSession } from "@/tool/team_wake"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { SessionLegacy } from "@opencode-ai/core/session/legacy"
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
    Truncate.defaultLayer,
  ),
)

const seed = Effect.fn("TeamMessagesTest.seed")(function* () {
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
  const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
  const member = yield* team.addMember({
    teamID: info.id,
    sessionID: worker.id,
    name: "worker",
    agentType: "general",
    rolePrompt: "Do the work",
  })
  yield* team.updateMemberStatus(member.id, "active")
  return { lead, user, assistant, info, member }
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
  response: SessionLegacy.WithParts
  wake?: () => Effect.Effect<SessionLegacy.WithParts>
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.succeed(input.response),
    wake: input.wake ?? (() => Effect.succeed(input.response)),
  }
}

const responseFor = (assistant: MessageV2.Assistant): SessionLegacy.WithParts => ({ info: assistant, parts: [] })

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
  it.live("tells the lead to end the turn when the mailbox is empty", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { lead, assistant } = yield* seed()
          const tool = yield* TeamGetMessagesTool
          const def = yield* tool.init()

          const result = yield* def.execute({}, context({ lead, assistant, callID: "current-check" }))

          expect(result.title).toBe("Team Messages")
          expect(result.output).toContain("No pending messages.")
          expect(result.output).toContain("end this turn instead of polling")
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

describe("team message wake safety", () => {
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
          const { lead, assistant, member } = yield* seed()
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
          const { lead, assistant, info, member } = yield* seed()
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
          const { lead, assistant, info, member } = yield* seed()
          const tool = yield* TeamPlanDecideTool
          const def = yield* tool.init()

          const result = yield* def.execute({ member_name: member.name, decision: "reject" }, context({ lead, assistant }))
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
