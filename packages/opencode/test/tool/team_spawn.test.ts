import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamSpawnTool } from "@/tool/team_spawn"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { ModelID, ProviderID } from "@/provider/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const explicitRef = {
  providerID: ProviderID.make("openai"),
  modelID: ModelID.make("gpt-4"),
}
const leadModel = ProviderTest.model({
  id: ref.modelID,
  providerID: ref.providerID,
  variants: { "lead-variant": {}, low: {}, high: {} },
})
const explicitModel = ProviderTest.model({
  id: explicitRef.modelID,
  providerID: explicitRef.providerID,
  variants: { "agent-low": {}, "agent-high": {} },
})
const provider = ProviderTest.fake({
  model: leadModel,
  getModel: (providerID, modelID) => {
    if (providerID === leadModel.providerID && modelID === leadModel.id) return Effect.succeed(leadModel)
    if (providerID === explicitModel.providerID && modelID === explicitModel.id) return Effect.succeed(explicitModel)
    return Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
  },
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    Database.defaultLayer,
    provider.layer,
  ),
)

const seed = Effect.fn("TeamSpawnTest.seed")(function* () {
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
    variant: "lead-variant",
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  const info = yield* team.create({ name: "test-team", goal: "Coordinate work", leadSessionID: lead.id })
  return { lead, assistant, info }
})

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function context(input: { lead: Session.Info; assistant: MessageV2.Assistant; promptOps?: TaskPromptOps }) {
  return {
    sessionID: input.lead.id,
    messageID: input.assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: input.promptOps ? { promptOps: input.promptOps } : undefined,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const waitUntil = Effect.fn("TeamSpawnTest.waitUntil")(function* (predicate: () => Effect.Effect<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (yield* predicate()) return
    yield* Effect.sleep("10 millis")
  }
  throw new Error("Timed out waiting for condition")
})

describe("tool.team_spawn", () => {
  it.live("inherits lead model and variant for teammates without explicit model", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.sync(() => {
                calls.push(input)
                return reply(input, "work complete")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Do the work",
            },
            context({ lead, assistant, promptOps }),
          )

          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(calls[0]?.model).toEqual(ref)
          expect(calls[0]?.variant).toBe("lead-variant")
          expect(child?.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "lead-variant" })
          expect(member?.model).toEqual({ ...ref, variant: "lead-variant" })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("uses explicit teammate model without inheriting lead variant", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.sync(() => {
                calls.push(input)
                return reply(input, "work complete")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          yield* def.execute(
            {
              name: "worker",
              agent_type: "model_worker",
              role_prompt: "Do the work",
            },
            context({ lead, assistant, promptOps }),
          )

          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(calls[0]?.model).toEqual(explicitRef)
          expect(calls[0]?.variant).toBeUndefined()
          expect(child?.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "lead-variant" })
          expect(member?.model).toEqual(explicitRef)
        }),
      {
        config: {
          experimental: { agent_teams: true },
            agent: {
              model_worker: {
                model: "openai/gpt-4",
                variant: "agent-high",
              },
            },
          },
      },
    ),
  )

  it.live("explicit requested variant overrides inherited lead variant", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.sync(() => {
                calls.push(input)
                return reply(input, "work complete")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Do the work",
              variant: "low",
            },
            context({ lead, assistant, promptOps }),
          )

          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(result.title).toBe("Teammate Completed")
          expect(calls[0]?.model).toEqual(ref)
          expect(calls[0]?.variant).toBe("low")
          expect(child?.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "low" })
          expect(member?.model).toEqual({ ...ref, variant: "low" })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("invalid requested variant fails before teammate creation", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.die(new Error("should not resolve prompt parts")),
            prompt: () => Effect.die(new Error("should not prompt")),
            wake: () => Effect.die(new Error("should not wake")),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Do the work",
              variant: "missing",
            },
            context({ lead, assistant, promptOps }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain('Invalid teammate variant "missing"')
          expect(result.output).toContain("test/test-model")
          expect(result.output).toContain("low")
          expect(result.output).toContain("high")
          expect(result.output).toContain("Omit team_spawn.variant")
          expect(yield* team.getMembers(info.id)).toHaveLength(0)
          expect(yield* sessions.children(lead.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("requested variant validates against explicit teammate agent model", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.sync(() => {
                calls.push(input)
                return reply(input, "work complete")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "worker",
              agent_type: "model_worker",
              role_prompt: "Do the work",
              variant: "agent-low",
            },
            context({ lead, assistant, promptOps }),
          )

          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(result.title).toBe("Teammate Completed")
          expect(calls[0]?.model).toEqual(explicitRef)
          expect(calls[0]?.variant).toBe("agent-low")
          expect(child?.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "lead-variant" })
          expect(member?.model).toEqual({ ...explicitRef, variant: "agent-low" })
        }),
      {
        config: {
          experimental: { agent_teams: true },
          agent: {
            model_worker: {
              model: "openai/gpt-4",
            },
          },
        },
      },
    ),
  )

  it.live("does not create an inert teammate when prompt operations are unavailable", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "architect",
              agent_type: "general",
              role_prompt: "Design the architecture",
            },
            context({ lead, assistant }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain("prompt operations are unavailable")
          expect(yield* team.getMembers(info.id)).toHaveLength(0)
          expect(yield* sessions.children(lead.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects direct calls from teammate sessions before creating nested teammates", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const teammate = yield* sessions.create({ parentID: lead.id, title: "Teammate" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: teammate.id,
            name: "teammate",
            agentType: "general",
            rolePrompt: "Work",
          })
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.die(new Error("should not resolve prompt parts")),
            prompt: () => Effect.die(new Error("should not prompt")),
            wake: () => Effect.die(new Error("should not wake")),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "nested",
              agent_type: "general",
              role_prompt: "Nested work",
            },
            context({ lead: teammate, assistant, promptOps }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain("Team members cannot spawn nested teammates")
          expect(yield* team.getMembers(info.id)).toHaveLength(1)
          expect(yield* sessions.children(teammate.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects direct calls from child sessions before resolving dependencies", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const child = yield* sessions.create({ parentID: lead.id, title: "Subagent" })
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "nested",
              agent_type: "general",
              role_prompt: "Nested work",
              depends_on: ["missing"],
            },
            context({ lead: child, assistant }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain("Child sessions cannot spawn teammates")
          expect(yield* team.getMembers(info.id)).toHaveLength(0)
          expect(yield* sessions.children(child.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("starts blocked teammates when their dependency completes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          let releaseArchitect = () => {}
          const architectReleased = new Promise<void>((resolve) => {
            releaseArchitect = resolve
          })
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.promise(async () => {
                const index = calls.length
                calls.push(input)
                if (index === 0) await architectReleased
                return reply(input, index === 0 ? "architecture ready" : "implementation done")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          let architectDone = false
          const architectFiber = yield* def
            .execute(
              {
                name: "architect",
                agent_type: "general",
                role_prompt: "Design the architecture",
              },
              context({ lead, assistant, promptOps }),
            )
            .pipe(
              Effect.tap(() => Effect.sync(() => (architectDone = true))),
              Effect.forkChild,
            )
          yield* waitUntil(() => Effect.sync(() => calls.length === 1))
          expect(architectDone).toBe(false)
          const architectPrompt = calls[0]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
          expect(architectPrompt).toContain("Proactive communication requirements:")
          expect(architectPrompt).toContain('team_send_message recipient "lead"')
          expect(calls[0]?.tools).toEqual({ team_create: false, team_spawn: false })
          const pendingLeadAfterStart = yield* team.getPendingMessages(lead.id, info.id)
          expect(pendingLeadAfterStart.some((message) => message.body.includes("architect (general) started"))).toBe(
            true,
          )

          yield* def.execute(
            {
              name: "implementer",
              agent_type: "general",
              role_prompt: "Implement after architecture is ready",
              depends_on: ["architect"],
            },
            context({ lead, assistant, promptOps }),
          )

          const blocked = (yield* team.getMembers(info.id)).find((member) => member.name === "implementer")
          expect(blocked?.status).toBe("blocked")
          expect(blocked?.model).toEqual({ ...ref, variant: "lead-variant" })
          expect(calls).toHaveLength(1)
          const architect = (yield* team.getMembers(info.id)).find((member) => member.name === "architect")
          expect(architect).toBeDefined()
          const pendingArchitect = yield* team.getPendingMessages(architect?.session_id ?? "", info.id)
          expect(pendingArchitect.some((message) => message.body.includes("waiting on your work"))).toBe(true)

          releaseArchitect()
          yield* waitUntil(() =>
            Effect.gen(function* () {
              return (yield* team.getMembers(info.id)).some(
                (member) => member.name === "implementer" && member.status === "completed",
              )
            }),
          )

          expect(calls).toHaveLength(2)
          expect(calls[1]?.model).toEqual(ref)
          expect(calls[1]?.variant).toBe("lead-variant")
          expect(calls[1]?.tools).toEqual({ team_create: false, team_spawn: false })
          const architectResult = yield* Fiber.join(architectFiber)
          expect(architectDone).toBe(true)
          expect(architectResult.title).toBe("Teammate Completed")
          expect(architectResult.output).toContain("architecture ready")
          expect(calls[1]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
            "architecture ready",
          )
          const pendingLead = yield* team.getPendingMessages(lead.id, info.id)
          expect(pendingLead.some((message) => message.body.includes("implementation done"))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("marks a finished teammate completed before the lead wake observes it", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const observedCompletionWakeStatuses: string[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) => Effect.succeed(reply(input, "work complete")),
            wake: (sessionID) =>
              Effect.gen(function* () {
                const pending = yield* team.getPendingMessages(lead.id, info.id)
                if (pending.some((message) => message.body.includes("completed and returned this result"))) {
                  observedCompletionWakeStatuses.push(
                    (yield* team.getMembers(info.id)).find((member) => member.name === "worker")?.status ?? "missing",
                  )
                }
                return reply({ sessionID, parts: [] }, "lead woke")
              }),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Do the work",
            },
            context({ lead, assistant, promptOps }),
          )

          yield* waitUntil(() => Effect.sync(() => observedCompletionWakeStatuses.length > 0))
          expect(result.title).toBe("Teammate Completed")
          expect(observedCompletionWakeStatuses).toContain("completed")
          expect(observedCompletionWakeStatuses).not.toContain("active")
          expect((yield* team.getMembers(info.id)).find((member) => member.name === "worker")?.status).toBe(
            "completed",
          )
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("starts independent teammates in parallel", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          let releaseFirst = () => {}
          let releaseSecond = () => {}
          const firstReleased = new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          const secondReleased = new Promise<void>((resolve) => {
            releaseSecond = resolve
          })
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.promise(async () => {
                const release = calls.length === 0 ? firstReleased : secondReleased
                calls.push(input)
                await release
                return reply(
                  input,
                  input.parts.some((part) => part.type === "text" && part.text.includes("Review workflow CLI"))
                    ? "cli done"
                    : "routes done",
                )
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const { lead, assistant } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const first = yield* def
            .execute(
              {
                name: "routes",
                agent_type: "general",
                role_prompt: "Review workflow routes",
              },
              context({ lead, assistant, promptOps }),
            )
            .pipe(Effect.forkChild)
          const second = yield* def
            .execute(
              {
                name: "cli",
                agent_type: "general",
                role_prompt: "Review workflow CLI",
              },
              context({ lead, assistant, promptOps }),
            )
            .pipe(Effect.forkChild)

          yield* waitUntil(() => Effect.sync(() => calls.length === 2))
          releaseFirst()
          releaseSecond()

          const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: "unbounded" })

          expect(results.map((result) => result.title)).toEqual(["Teammate Completed", "Teammate Completed"])
          expect(results.map((result) => result.output).join("\n")).toContain("routes done")
          expect(results.map((result) => result.output).join("\n")).toContain("cli done")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
