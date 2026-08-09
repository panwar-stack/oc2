import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamSpawnTool } from "@/tool/team_spawn"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { ModelID, ProviderID } from "@/provider/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { pollWithTimeout, testEffect, awaitWithTimeout } from "../lib/effect"
import { BackgroundJob } from "@/background/job"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Runner } from "@/effect/runner"

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
    BackgroundJob.defaultLayer,
    SessionControl.defaultLayer,
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

function context(input: {
  lead: Session.Info
  assistant: MessageV2.Assistant
  promptOps?: TaskPromptOps
  abort?: AbortSignal
}) {
  return {
    sessionID: input.lead.id,
    messageID: input.assistant.id,
    agent: "build",
    abort: input.abort ?? new AbortController().signal,
    extra: input.promptOps ? { promptOps: input.promptOps } : undefined,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const waitUntil = Effect.fn("TeamSpawnTest.waitUntil")(function* (predicate: () => Effect.Effect<boolean>) {
  yield* pollWithTimeout(
    Effect.gen(function* () {
      return (yield* predicate()) ? true : undefined
    }),
    "Timed out waiting for condition",
  )
})

describe("tool.team_spawn", () => {
  it.live("uses the lead wait contract in its description", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* TeamSpawnTool
          const description = (yield* tool.init()).description

          expect(description).toContain("Continue useful decomposition, integration, review, or decision work.")
          expect(description).toContain("When no useful work remains, finish the current response normally.")
          expect(description).toContain(
            "The runtime parks successful finalization while finite teammates remain active.",
          )
          expect(description).toContain(
            "Do not sleep, repeatedly read team state, ask for routine updates, or send filler.",
          )
          expect(description).toContain(
            "Teammates must send material progress, blockers, questions, and results without a lead status request.",
          )
          expect(description).toContain("Relevant teammate or user events wake the lead.")
          expect(description).not.toContain("Do not finalize while finite teammates remain nonterminal.")
          expect(description).not.toContain("Ask for periodic updates.")
          expect(description).not.toContain("An empty mailbox does not require ending this turn.")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

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
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
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

          // The member starts on the reconciler poll (up to 500 ms), not inside the tool call.
          yield* waitUntil(() => Effect.sync(() => calls.length > 0))
          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(calls[0]?.model).toEqual(ref)
          expect(calls[0]?.variant).toBe("lead-variant")
          expect(child?.model).toEqual({ id: ref.modelID, providerID: ref.providerID, variant: "lead-variant" })
          expect(child?.permission).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
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
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
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

          yield* waitUntil(() => Effect.sync(() => calls.length > 0))
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
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
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

          yield* waitUntil(() => Effect.sync(() => calls.length > 0))
          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(result.title).toBe("Teammate Started")
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
            run: () => Effect.die(new Error("should not wake")),
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
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
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

          yield* waitUntil(() => Effect.sync(() => calls.length > 0))
          const child = (yield* sessions.children(lead.id))[0]
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(result.title).toBe("Teammate Started")
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

  it.live("initializes daemon teammates without completing them", () =>
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
                return reply(input, "initialized")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "sentinel",
              agent_type: "general",
              role_prompt: "Watch for integration risks",
              lifecycle: "daemon",
            },
            context({ lead, assistant, promptOps }),
          )

          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "sentinel")
          expect(result.title).toBe("Daemon Teammate Initialized")
          expect(result.output).toContain("initialized")
          expect(calls).toHaveLength(1)
          const prompt = calls[0]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
          expect(prompt).toContain("You are a daemon teammate.")
          expect(prompt).toContain("Your assignment is long-lived and remains active until the team shuts down.")
          expect(prompt).toContain("Use team_get_messages at natural boundaries, not in a polling loop.")
          expect(prompt).not.toContain(
            "When your assigned work is complete, put the concrete result in your final answer",
          )
          expect(member?.lifecycle).toBe("daemon")
          expect(member?.status).toBe("idle")
          expect(member?.daemon_state).toBe("idle")
          expect(member?.daemon_last_active).toBeNumber()
          expect(member?.daemon_error).toBeNull()
          expect(member?.result).toBeNull()
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("records daemon initialization failure", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: () =>
              Effect.sync(() => {
                throw new Error("boom")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "sentinel",
              agent_type: "general",
              role_prompt: "Watch for integration risks",
              lifecycle: "daemon",
            },
            context({ lead, assistant, promptOps }),
          )

          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "sentinel")
          expect(result.title).toBe("Daemon Teammate Initialization Failed")
          expect(result.output).toContain("boom")
          expect(member?.lifecycle).toBe("daemon")
          expect(member?.status).toBe("cancelled")
          expect(member?.daemon_state).toBe("error")
          expect(member?.daemon_error).toBe("boom")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a provider/session error during a finite member run settles the member cancelled with provider_error", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: () =>
              Effect.sync(() => {
                throw new Error("boom")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
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

          // The spawn returns a started handle; the failing member run happens on the reconciler.
          expect(result.title).toBe("Teammate Started")
          yield* waitUntil(() =>
            Effect.gen(function* () {
              const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
              return member?.status === "cancelled"
            }),
          )
          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(member?.status).toBe("cancelled")
          expect(member?.failure_code).toBe("provider_error")
          const cancelled = (yield* team.getMessages(info.id)).find(
            (message) => message.id === `lifecycle:member:${member?.id}:cancelled:1`,
          )
          expect(cancelled?.body).toContain("boom")
          // Exactly one canonical terminal notification per transition.
          expect(
            (yield* team.getMessages(info.id)).filter((message) => message.id.includes(":cancelled:")),
          ).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a setup failure between addMember and startMember terminalizes the member as notified cancelled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          // The first getMembers call (pre-addMember existence check) succeeds; the second
          // (post-addMember latest-members read) dies, simulating a setup failure.
          let getMembersCalls = 0
          const failingTeam = {
            ...team,
            getMembers: Effect.fn("Team.getMembers.setupFailure")(function* (teamID: string) {
              getMembersCalls += 1
              if (getMembersCalls >= 2) return yield* Effect.die(new Error("setup boom"))
              return yield* team.getMembers(teamID)
            }),
          }
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: () =>
              Effect.sync(() => {
                throw new Error("boom")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          // The tool resolves its Team service when `TeamSpawnTool` itself is evaluated, so the
          // override must wrap that evaluation (not `tool.init()`).
          const tool = yield* TeamSpawnTool.pipe(Effect.provideService(Team.Service, failingTeam))
          const def = yield* tool.init()

          const exit = yield* def
            .execute(
              { name: "worker", agent_type: "general", role_prompt: "Do the work" },
              context({ lead, assistant, promptOps }),
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)

          const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
          expect(member?.status).toBe("cancelled")
          expect(member?.result).toBe("setup boom")
          const notifications = (yield* team.getMessages(info.id)).filter(
            (message) => message.id === `team:member:${member?.id}:terminal:cancelled`,
          )
          expect(notifications).toHaveLength(1)
          expect(notifications[0]?.body).toContain("setup boom")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a released parent-pause interrupt preserves the new member while a real failure still terminalizes", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const entered = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const cleanupEntered = yield* Deferred.make<void>()
          const cleanupGate = yield* Deferred.make<void>()
          const scope = yield* Scope.Scope
          let mode: "pause" | "failure" = "pause"
          let modeCalls = 0
          const controlledTeam = {
            ...team,
            getMembers: Effect.fn("Team.getMembers.pauseOrFailure")(function* (teamID: string) {
              modeCalls += 1
              if (modeCalls >= 2) {
                if (mode === "failure") return yield* Effect.die(new Error("setup boom"))
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(gate).pipe(
                  Effect.ensuring(
                    Deferred.succeed(cleanupEntered, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                  ),
                )
              }
              return yield* team.getMembers(teamID)
            }),
          }
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) => Effect.succeed(reply(input, "work complete")),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const tool = yield* TeamSpawnTool.pipe(Effect.provideService(Team.Service, controlledTeam))
          const def = yield* tool.init()
          const runner = Runner.make<unknown>(scope)
          const pausedFiber = yield* runner
            .ensureRunning(
              def.execute(
                { name: "paused-worker", agent_type: "general", role_prompt: "Do paused work" },
                context({ lead, assistant, promptOps }),
              ),
            )
            .pipe(Effect.forkScoped)
          yield* awaitWithTimeout(Deferred.await(entered), "spawn did not reach the pause gate")
          const paused = yield* control.pause({ rootSessionID: lead.id })
          yield* runner.suspendWith({
            _tag: "SessionControl.PauseProvenance",
            rootSessionID: paused.rootSessionID,
            cascadeID: paused.cascadeID,
            generation: paused.generation,
          })
          yield* awaitWithTimeout(Deferred.await(cleanupEntered), "spawn cleanup did not start")
          yield* control.release(lead.id)
          expect((yield* control.state(lead.id)).paused).toBe(false)
          yield* Deferred.succeed(cleanupGate, undefined)
          yield* pollWithTimeout(
            Effect.sync(() => (runner.state._tag === "Idle" ? true : undefined)),
            "spawn target did not finish cleanup",
          )
          const pausedExit = yield* Fiber.await(pausedFiber)
          expect(Exit.isFailure(pausedExit)).toBe(true)
          if (Exit.isFailure(pausedExit)) expect(Cause.squash(pausedExit.cause)).toBeInstanceOf(Runner.Suspended)

          const pausedMember = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "paused-worker")
          expect(pausedMember?.status).toBe("starting")
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `team:member:${pausedMember?.id}:terminal:cancelled`,
            ),
          ).toHaveLength(0)

          mode = "failure"
          modeCalls = 0
          const failedExit = yield* def
            .execute(
              { name: "failed-worker", agent_type: "general", role_prompt: "Fail during setup" },
              context({ lead, assistant, promptOps }),
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(failedExit)).toBe(true)
          if (Exit.isFailure(failedExit)) expect(Cause.hasInterruptsOnly(failedExit.cause)).toBe(false)

          const failedMember = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "failed-worker")
          expect(failedMember?.status).toBe("cancelled")
          expect(failedMember?.result).toBe("setup boom")
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `team:member:${failedMember?.id}:terminal:cancelled`,
            ),
          ).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a pause committed before its delayed signal preserves a member created before that signal", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const beforeSnapshot = yield* Deferred.make<void>()
          const allowSnapshot = yield* Deferred.make<void>()
          const memberCreated = yield* Deferred.make<void>()
          const memberGate = yield* Deferred.make<void>()
          let getMembersCalls = 0
          const controlledTeam = {
            ...team,
            getMembers: Effect.fn("Team.getMembers.commitBeforeSnapshot")(function* (teamID: string) {
              getMembersCalls += 1
              if (getMembersCalls === 1) {
                yield* Deferred.succeed(beforeSnapshot, undefined)
                yield* Deferred.await(allowSnapshot)
              }
              if (getMembersCalls === 2) {
                yield* Deferred.succeed(memberCreated, undefined)
                yield* Deferred.await(memberGate)
              }
              return yield* team.getMembers(teamID)
            }),
          }
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) => Effect.succeed(reply(input, "work complete")),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const controller = new AbortController()
          const tool = yield* TeamSpawnTool.pipe(Effect.provideService(Team.Service, controlledTeam))
          const def = yield* tool.init()
          const spawnFiber = yield* def
            .execute(
              { name: "ordered-worker", agent_type: "general", role_prompt: "Do ordered work" },
              context({ lead, assistant, promptOps, abort: controller.signal }),
            )
            .pipe(Effect.forkScoped)

          yield* awaitWithTimeout(Deferred.await(beforeSnapshot), "spawn did not reach the pre-snapshot gate")
          const signalEntered = yield* Deferred.make<void>()
          const allowSignal = yield* Deferred.make<void>()
          const unregister = yield* control.registerInterrupter((sessionIDs, provenance) =>
            Effect.gen(function* () {
              if (!sessionIDs.includes(lead.id)) return []
              yield* Deferred.succeed(signalEntered, undefined)
              yield* Deferred.await(allowSignal)
              controller.abort(provenance)
              yield* Fiber.interrupt(spawnFiber)
              return [lead.id]
            }),
          )
          const pauseFiber = yield* control.pause({ rootSessionID: lead.id }).pipe(Effect.forkScoped)

          // SessionControl invokes interrupters only after the pause transaction commits.
          yield* awaitWithTimeout(Deferred.await(signalEntered), "pause did not commit before the blocker snapshot")
          yield* Deferred.succeed(allowSnapshot, undefined)
          yield* awaitWithTimeout(Deferred.await(memberCreated), "pause signal did not wait for member creation")
          yield* Deferred.succeed(allowSignal, undefined)
          const pauseResult = yield* awaitWithTimeout(Fiber.join(pauseFiber), "pause signal did not finish")
          expect(pauseResult.interruptionSignalledSessionIDs).toContain(lead.id)
          expect(controller.signal.reason).toEqual({
            _tag: "SessionControl.PauseProvenance",
            rootSessionID: lead.id,
            cascadeID: pauseResult.cascadeID,
            generation: pauseResult.generation,
          })

          const spawnExit = yield* Fiber.await(spawnFiber)
          expect(Exit.isFailure(spawnExit)).toBe(true)
          if (Exit.isFailure(spawnExit)) expect(Cause.hasInterruptsOnly(spawnExit.cause)).toBe(true)
          const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "ordered-worker")
          expect(member?.status).toBe("starting")
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `team:member:${member?.id}:terminal:cancelled`,
            ),
          ).toHaveLength(0)

          yield* unregister
          yield* control.release(lead.id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("an ordinary abort wins over unrelated Runner provenance and historical pauses", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          yield* control.pause({ rootSessionID: lead.id })
          yield* control.release(lead.id)
          const unrelated = yield* sessions.create({ title: "Unrelated" })
          const unrelatedPause = yield* control.pause({ rootSessionID: unrelated.id })
          // The second getMembers call (the post-addMember latest-members read) blocks on a
          // gate until the fiber is interrupted, simulating an abort between member creation
          // and start (before the acquireUseRelease release handler exists).
          let getMembersCalls = 0
          const entered = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const blockingTeam = {
            ...team,
            getMembers: Effect.fn("Team.getMembers.interrupt")(function* (teamID: string) {
              getMembersCalls += 1
              if (getMembersCalls >= 2) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(gate)
              }
              return yield* team.getMembers(teamID)
            }),
          }
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: () =>
              Effect.sync(() => {
                throw new Error("boom")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const controller = new AbortController()
          const scope = yield* Scope.Scope
          const tool = yield* TeamSpawnTool.pipe(Effect.provideService(Team.Service, blockingTeam))
          const def = yield* tool.init()
          const runner = Runner.make<unknown>(scope)
          const fiber = yield* runner
            .ensureRunning(
              def.execute(
                { name: "worker", agent_type: "general", role_prompt: "Do the work" },
                context({ lead, assistant, promptOps, abort: controller.signal }),
              ),
            )
            .pipe(Effect.forkScoped)
          yield* awaitWithTimeout(Deferred.await(entered), "spawn did not reach the setup gate")
          controller.abort(new DOMException("ordinary interrupt", "AbortError"))
          yield* runner.suspendWith({
            _tag: "SessionControl.PauseProvenance",
            rootSessionID: unrelatedPause.rootSessionID,
            cascadeID: unrelatedPause.cascadeID,
            generation: unrelatedPause.generation,
          })
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)

          yield* waitUntil(() =>
            Effect.gen(function* () {
              const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
              return member?.status === "cancelled"
            }),
          )

          const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
          expect(member?.status).toBe("cancelled")
          const notifications = (yield* team.getMessages(info.id)).filter(
            (message) => message.id === `team:member:${member?.id}:terminal:cancelled`,
          )
          expect(notifications).toHaveLength(1)
          yield* control.release(unrelated.id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("does not unblock dependents from daemon initialization", () =>
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
                return reply(input, "initialized")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          yield* def.execute(
            {
              name: "sentinel",
              agent_type: "general",
              role_prompt: "Watch for integration risks",
              lifecycle: "daemon",
            },
            context({ lead, assistant, promptOps }),
          )
          const result = yield* def.execute(
            {
              name: "implementer",
              agent_type: "general",
              role_prompt: "Implement after sentinel handoff",
              depends_on: ["sentinel"],
            },
            context({ lead, assistant, promptOps }),
          )

          const members = yield* team.getMembers(info.id)
          expect(result.title).toBe("Teammate Spawned")
          expect(members.find((member) => member.name === "sentinel")?.status).toBe("idle")
          expect(members.find((member) => member.name === "implementer")?.status).toBe("blocked")
          expect(calls).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
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

  it.live("rejects duplicate teammate names before creating a child session", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const existing = yield* sessions.create({ parentID: lead.id, title: "Existing worker" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: existing.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Existing work",
          })
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.die(new Error("should not resolve prompt parts")),
            prompt: () => Effect.die(new Error("should not prompt")),
            wake: () => Effect.die(new Error("should not wake")),
            run: () => Effect.die(new Error("should not wake")),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Duplicate work",
            },
            context({ lead, assistant, promptOps }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain("already exists")
          expect(yield* team.getMembers(info.id)).toHaveLength(1)
          expect(yield* sessions.children(lead.id)).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects ambiguous dependency names", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const sessions = yield* Session.Service
          const { lead, assistant, info } = yield* seed()
          const first = yield* sessions.create({ parentID: lead.id, title: "First worker" })
          const second = yield* sessions.create({ parentID: lead.id, title: "Second worker" })
          yield* team.addMember({
            teamID: info.id,
            sessionID: first.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "First work",
          })
          yield* team.addMember({
            teamID: info.id,
            sessionID: second.id,
            name: "worker",
            agentType: "general",
            rolePrompt: "Second work",
          })
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.die(new Error("should not resolve prompt parts")),
            prompt: () => Effect.die(new Error("should not prompt")),
            wake: () => Effect.die(new Error("should not wake")),
            run: () => Effect.die(new Error("should not wake")),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "implementer",
              agent_type: "general",
              role_prompt: "Implement after worker",
              depends_on: ["worker"],
            },
            context({ lead, assistant, promptOps }),
          )

          expect(result.title).toBe("Team Spawn Failed")
          expect(result.output).toContain("ambiguous")
          expect(result.output).toContain("session IDs")
          expect(yield* team.getMembers(info.id)).toHaveLength(2)
          expect(yield* sessions.children(lead.id)).toHaveLength(2)
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
            run: () => Effect.die(new Error("should not wake")),
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
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { lead, assistant, info } = yield* seed()
          let releaseArchitect = () => {}
          const architectReleased = new Promise<void>((resolve) => {
            releaseArchitect = resolve
          })
          const calls: SessionPrompt.PromptInput[] = []
          const completionWakeDependentStatuses: string[] = []
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
            wake: (sessionID) =>
              Effect.gen(function* () {
                const pending = yield* team.getPendingMessages(lead.id, info.id)
                if (pending.some((message) => message.body.includes("architecture ready"))) {
                  completionWakeDependentStatuses.push(
                    (yield* team.getMembers(info.id)).find((member) => member.name === "implementer")?.status ??
                      "missing",
                  )
                }
                return reply({ sessionID, parts: [] }, "looped")
              }),
            run: (sessionID) =>
              Effect.gen(function* () {
                const pending = yield* team.getPendingMessages(lead.id, info.id)
                if (pending.some((message) => message.body.includes("architecture ready"))) {
                  completionWakeDependentStatuses.push(
                    (yield* team.getMembers(info.id)).find((member) => member.name === "implementer")?.status ??
                      "missing",
                  )
                }
                return reply({ sessionID, parts: [] }, "looped")
              }),
          }
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
          // The spawn returned immediately (the forked tool call finished) while the member runs
          // in the background on the reconciler: the member is active, not completed.
          expect(architectDone).toBe(true)
          const architectRunning = (yield* team.getMembers(info.id)).find((member) => member.name === "architect")
          expect(architectRunning?.status).toBe("active")
          expect(architectRunning?.result).toBeNull()
          const architectPrompt = calls[0]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
          expect(architectPrompt).toContain("Proactive communication requirements:")
          expect(architectPrompt).toContain("Never ask the user questions directly")
          expect(architectPrompt).toContain("If a child subagent needs user input")
          expect(architectPrompt).toContain('team_send_message recipient "lead"')
          expect(calls[0]?.tools).toEqual({ team_create: false, team_spawn: false, local_fusion: false })
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
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile

          expect(calls).toHaveLength(2)
          expect(calls[1]?.model).toEqual(ref)
          expect(calls[1]?.variant).toBe("lead-variant")
          expect(calls[1]?.tools).toEqual({ team_create: false, team_spawn: false, local_fusion: false })
          const architectResult = yield* Fiber.join(architectFiber)
          expect(architectDone).toBe(true)
          expect(architectResult.title).toBe("Teammate Started")
          expect(architectResult.output).toContain("running in background")
          expect(calls[1]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
            "architecture ready",
          )
          expect(completionWakeDependentStatuses.length).toBeGreaterThan(0)
          expect(completionWakeDependentStatuses).not.toContain("blocked")
          expect(completionWakeDependentStatuses).not.toContain("missing")
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
            run: (sessionID) =>
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
          expect(result.title).toBe("Teammate Started")
          expect(observedCompletionWakeStatuses).toContain("completed")
          expect(observedCompletionWakeStatuses).not.toContain("active")
          expect((yield* team.getMembers(info.id)).find((member) => member.name === "worker")?.status).toBe("completed")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("reconstructs paused teammate completion once from durable session facts", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const lifecycle = yield* LifecycleReconciler.Service
          const control = yield* SessionControl.Service
          const database = yield* Database.Service
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          let release = () => {}
          const released = new Promise<void>((resolve) => {
            release = resolve
          })
          let wakes = 0
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => released)
                const result = reply(input, "durable teammate result")
                yield* sessions.updateMessage(result.info)
                for (const part of result.parts) yield* sessions.updatePart(part)
                return result
              }),
            wake: (sessionID) =>
              Effect.sync(() => {
                wakes++
                return reply({ sessionID, parts: [] }, "woke")
              }),
            run: (sessionID) =>
              Effect.sync(() => {
                wakes++
                return reply({ sessionID, parts: [] }, "woke")
              }),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()
          const fiber = yield* def
            .execute(
              { name: "worker", agent_type: "general", role_prompt: "Do durable work" },
              context({ lead, assistant, promptOps }),
            )
            .pipe(Effect.forkChild)

          yield* waitUntil(() =>
            Effect.gen(function* () {
              return (yield* team.getMembers(info.id)).some(
                (member) => member.name === "worker" && member.status === "active",
              )
            }),
          )
          yield* control.pause({ rootSessionID: lead.id })
          release()
          yield* Fiber.join(fiber)

          const pausedMember = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          expect(pausedMember?.status).toBe("active")
          const pausedSession = yield* database.db
            .select({ metadata: SessionTable.metadata })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionID.make(pausedMember!.session_id)))
            .get()
            .pipe(Effect.orDie)
          expect(pausedSession?.metadata?.lifecycleTeamMember).toMatchObject({
            memberID: pausedMember?.id,
            state: "completed",
            output: "durable teammate result",
          })
          expect(
            (yield* team.getMessages(info.id)).filter((message) => message.id.endsWith(":completed")),
          ).toHaveLength(0)

          yield* control.release(lead.id)
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile

          const member = (yield* team.getMembers(info.id)).find((member) => member.name === "worker")
          const completion = (yield* team.getMessages(info.id)).filter((message) => message.id.includes(":completed:"))
          expect(member?.status).toBe("completed")
          expect(member?.result).toBe("durable teammate result")
          expect(completion).toHaveLength(1)
          expect(completion[0]?.id).toBe(`lifecycle:member:${member?.id}:completed:1`)
          expect(wakes).toBe(1)
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
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const { lead, assistant, info } = yield* seed()
          const team = yield* Team.Service
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

          expect(results.map((result) => result.title)).toEqual(["Teammate Started", "Teammate Started"])
          expect(results.map((result) => result.output)).toEqual([
            expect.stringContaining("running in background"),
            expect.stringContaining("running in background"),
          ])
          // The spawn results no longer embed the member results; completion arrives via the
          // mailbox auto-notification once the background runs finish.
          yield* waitUntil(() =>
            Effect.gen(function* () {
              const members = yield* team.getMembers(info.id)
              return members.filter((member) => member.status === "completed").length === 2
            }),
          )
          const pendingLead = yield* team.getPendingMessages(lead.id, info.id)
          expect(pendingLead.some((message) => message.body.includes("routes done"))).toBe(true)
          expect(pendingLead.some((message) => message.body.includes("cli done"))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("returns a started handle immediately and delivers completion via the mailbox", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, assistant, info } = yield* seed()
          let release = () => {}
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.promise(async () => {
                calls.push(input)
                await gate
                return reply(input, "background result")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Do background work",
            },
            context({ lead, assistant, promptOps }),
          )
          const memberRow = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
          expect(result.title).toBe("Teammate Started")
          expect(result.output).toContain("running in background")
          expect(result.metadata).toMatchObject({
            memberID: memberRow?.id,
            sessionID: memberRow?.session_id,
            dependencyIDs: [],
          })

          // The member starts on the reconciler poll (up to 500 ms) and runs in the background
          // after the spawn call has already returned.
          yield* waitUntil(() =>
            Effect.gen(function* () {
              const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
              return member?.status === "active"
            }),
          )
          const activeMember = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
          expect(activeMember?.status).toBe("active")
          expect(activeMember?.result).toBeNull()

          release()
          yield* waitUntil(() =>
            Effect.gen(function* () {
              const current = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
              return current?.status === "completed"
            }),
          )
          const completed = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
          expect(completed?.status).toBe("completed")
          expect(completed?.result).toBe("background result")
          // Completion is observed via the durable mailbox, not the spawn tool result.
          const pendingLead = yield* team.getPendingMessages(lead.id, info.id)
          expect(pendingLead.some((message) => message.body.includes("background result"))).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("starts a task member exactly once while the reconciler poll and manual reconciles overlap", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { lead, assistant, info } = yield* seed()
          let release = () => {}
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          const calls: SessionPrompt.PromptInput[] = []
          const promptOps: TaskPromptOps = {
            cancel: () => Effect.void,
            resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: (input) =>
              Effect.promise(async () => {
                calls.push(input)
                await gate
                return reply(input, "single run")
              }),
            wake: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
            run: (sessionID) => Effect.sync(() => reply({ sessionID, parts: [] }, "looped")),
          }
          const tool = yield* TeamSpawnTool
          const def = yield* tool.init()

          yield* def.execute(
            {
              name: "worker",
              agent_type: "general",
              role_prompt: "Run once",
            },
            context({ lead, assistant, promptOps }),
          )

          // Wait until the member is running (its prompt was called once), then force additional
          // reconcile passes while the run is still in flight: the runningMembers guard must
          // suppress every re-start.
          yield* waitUntil(() =>
            Effect.gen(function* () {
              const member = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
              return member?.status === "active"
            }),
          )
          expect(calls).toHaveLength(1)
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile
          expect(calls).toHaveLength(1)

          release()
          yield* waitUntil(() =>
            Effect.gen(function* () {
              const current = (yield* team.getMembers(info.id)).find((candidate) => candidate.name === "worker")
              return current?.status === "completed"
            }),
          )
          // After completion the member is terminal, so neither the poll nor manual reconciles
          // can start it again.
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile
          expect(calls).toHaveLength(1)
          expect(
            (yield* team.getMessages(info.id)).filter((message) => message.id.includes(":completed:")),
          ).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
