import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Runner } from "@/effect/runner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Team } from "@/team/team"
import { TeamMemberTable, TeamTable } from "@/team/team.sql"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { eq, isNull } from "drizzle-orm"
import fs from "fs/promises"
import path from "path"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { TeamFileOwnershipTable } from "@oc2-ai/core/team/ownership.sql"
import { canonicalize } from "@/team/file-ownership"
import { jsonSchema, tool as aiTool } from "ai"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
    FSUtil.defaultLayer,
    Session.defaultLayer,
    SessionControl.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
  ),
)

function assistant(sessionID: SessionID, parentID: MessageID, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      sessionID,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

function textPart(
  sessionID: SessionID,
  messageID: MessageID,
  text: string,
  flags?: { synthetic?: boolean; ignored?: boolean },
): SessionV1.TextPart {
  return {
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text",
    text,
    ...(flags?.synthetic ? { synthetic: true } : {}),
    ...(flags?.ignored ? { ignored: true } : {}),
  }
}

type OpsSpy = {
  readonly ops: TaskPromptOps
  readonly prompts: Ref.Ref<number>
  readonly wakes: Ref.Ref<number>
  readonly runs: Ref.Ref<number>
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Builds prompt ops that count every entry point separately, so a test can prove which contract the
 * reconciler used. `wake` is deliberately non-blocking and answers no result.
 */
const spyOps = Effect.fn("LifecycleReconcilerTest.spyOps")(function* (input?: {
  readonly text?: string
  readonly result?: (sessionID: SessionID, parentID: MessageID) => SessionV1.WithParts
  readonly onPrompt?: (promptInput: SessionPrompt.PromptInput) => Effect.Effect<void, Runner.Suspended>
  readonly onRun?: (sessionID: SessionID) => Effect.Effect<void, Runner.Suspended>
  readonly wakeFails?: boolean
}) {
  const sessions = yield* Session.Service
  const prompts = yield* Ref.make(0)
  const wakes = yield* Ref.make(0)
  const runs = yield* Ref.make(0)
  const text = input?.text ?? "done"
  const resultFor = (sessionID: SessionID, parentID: MessageID) =>
    input?.result ? input.result(sessionID, parentID) : assistant(sessionID, parentID, text)
  const persist = Effect.fn("LifecycleReconcilerTest.persist")(function* (result: SessionV1.WithParts) {
    yield* sessions.updateMessage(result.info)
    for (const part of result.parts) yield* sessions.updatePart(part)
    return result
  })
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (promptInput) =>
      Effect.gen(function* () {
        yield* Ref.update(prompts, (count) => count + 1)
        // The real prompt admits the user message durably before it can suspend.
        const messageID = promptInput.messageID ?? MessageID.ascending()
        yield* sessions.updateMessage({
          id: messageID,
          role: "user",
          sessionID: promptInput.sessionID,
          agent: promptInput.agent ?? "general",
          model: promptInput.model ?? ref,
          time: { created: Date.now() },
        })
        if (input?.onPrompt) yield* input.onPrompt(promptInput)
        return yield* persist(resultFor(promptInput.sessionID, messageID))
      }),
    wake: () =>
      Ref.update(wakes, (count) => count + 1).pipe(
        Effect.andThen(input?.wakeFails ? Effect.fail(new Runner.Suspended()) : Effect.void),
      ),
    run: (sessionID) =>
      Effect.gen(function* () {
        yield* Ref.update(runs, (count) => count + 1)
        if (input?.onRun) yield* input.onRun(sessionID)
        return yield* persist(resultFor(sessionID, MessageID.ascending()))
      }),
  }
  return { ops, prompts, wakes, runs } satisfies OpsSpy
})

/** The retry is an allow-list, so unknown runtime tools are denied without naming them here. */
function expectRetryPromptToolAllowList(tools: SessionPrompt.PromptInput["tools"]) {
  expect(tools).toEqual({ "*": false, team_task_update: true })
}

const requestTool = () =>
  aiTool({
    description: "Test tool",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
  })

const backgroundState = Effect.fn("LifecycleReconcilerTest.backgroundState")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.metadata?.lifecycleReconciler as
    | { state?: string; output?: string; error?: string; notification?: string; generation?: number }
    | undefined
})

/** Writes the durable "member is running" fact that a previous process would have left behind. */
const seedMemberMetadata = Effect.fn("LifecycleReconcilerTest.seedMemberMetadata")(function* (input: {
  sessionID: SessionID
  memberID: string
  promptMessageID: MessageID
  generation?: number
  phase?: "running" | "retry_admitted" | "retry_running" | "terminal"
  state?: "running" | "completed" | "idle" | "cancelled" | "failed"
}) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  yield* db
    .update(SessionTable)
    .set({
      metadata: {
        ...(row?.metadata ?? {}),
        lifecycleTeamMember: {
          kind: "team-member",
          memberID: input.memberID,
          promptMessageID: input.promptMessageID,
          state: input.state ?? "running",
          ...(input.generation !== undefined ? { generation: input.generation } : {}),
          ...(input.phase ? { phase: input.phase } : {}),
        },
      },
      time_updated: Date.now(),
    })
    .where(eq(SessionTable.id, input.sessionID))
    .run()
    .pipe(Effect.orDie)
})

const setMemberRunGeneration = Effect.fn("LifecycleReconcilerTest.setMemberRunGeneration")(function* (
  memberID: string,
  generation: number,
) {
  const { db } = yield* Database.Service
  yield* db
    .update(TeamMemberTable)
    .set({ run_generation: generation, time_updated: Date.now() })
    .where(eq(TeamMemberTable.id, memberID))
    .run()
    .pipe(Effect.orDie)
})

/** Reads the durable team revision, the anchor for the final-report checkpoint. */
const teamRevision = Effect.fn("LifecycleReconcilerTest.teamRevision")(function* (teamID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ revision: TeamTable.revision })
    .from(TeamTable)
    .where(eq(TeamTable.id, teamID))
    .get()
    .pipe(Effect.orDie)
  return row?.revision ?? 0
})

/** Reads the persisted member lifecycle metadata of a session. */
const memberState = Effect.fn("LifecycleReconcilerTest.memberState")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.metadata?.lifecycleTeamMember as
    | {
        state?: string
        output?: string
        error?: string
        failureCode?: string
        generation?: number
        phase?: string
      }
    | undefined
})

/** Runs work against a reconciler instance with no shared in-memory state, like a fresh process. */
function afterRestart<A, E>(work: Effect.Effect<A, E, LifecycleReconciler.Service>) {
  return work.pipe(Effect.provide(Layer.fresh(LifecycleReconciler.layer)))
}

function isTaskNotification(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "text" && part.synthetic === true && part.text.startsWith("<task id="))
  )
}

/** Matches a generation-scoped member lifecycle notification like `lifecycle:member:<id>:<kind>:<gen>`. */
function memberMessage(kind: string) {
  return (message: { id: string }) => message.id.includes(`:${kind}:`)
}

/** Minimal tool context used to canonicalize reservation paths inside this test file. */
function toolContext(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const seedTeam = Effect.fn("LifecycleReconcilerTest.seedTeam")(function* () {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const lead = yield* sessions.create({ title: "Lead" })
  const info = yield* team.create({ name: "team", goal: "Coordinate work", leadSessionID: lead.id })
  const memberSession = yield* sessions.create({ parentID: lead.id, title: "Member" })
  const member = yield* team.addMember({
    teamID: info.id,
    sessionID: memberSession.id,
    name: "worker",
    agentType: "general",
    model: ref,
    rolePrompt: "Do durable work",
  })
  return { lead, info, member, memberSession }
})

describe("session.lifecycle-reconciler", () => {
  it.live("restart while paused keeps a background task running and resumes it exactly once after start", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const control = yield* SessionControl.Service
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
        const spy = yield* spyOps({ text: "resumed result" })

        // A previous process registered the running background task and then died.
        const registration = yield* afterRestart(
          Effect.gen(function* () {
            const lifecycle = yield* LifecycleReconciler.Service
            return yield* lifecycle.registerBackground({
              sessionID: child.id,
              parentSessionID: parent.id,
              description: "durable work",
              agent: "general",
              model: ref,
              notifyParent: true,
              ops: spy.ops,
            })
          }),
        )

        yield* control.pause({ rootSessionID: parent.id })

        yield* afterRestart(
          Effect.gen(function* () {
            const lifecycle = yield* LifecycleReconciler.Service
            yield* lifecycle.attach(spy.ops)
            yield* lifecycle.reconcile
            yield* lifecycle.reconcile
          }),
        )

        expect(yield* backgroundState(child.id)).toMatchObject({
          state: "running",
          generation: registration.generation,
        })
        expect(yield* Ref.get(spy.runs)).toBe(0)
        expect(yield* Ref.get(spy.wakes)).toBe(0)
        expect(yield* Ref.get(spy.prompts)).toBe(0)
        expect(yield* control.runnableResumeTickets([child.id])).toHaveLength(0)

        yield* control.release(parent.id)
        expect(yield* control.runnableResumeTickets([child.id])).toHaveLength(1)

        yield* afterRestart(
          Effect.gen(function* () {
            const lifecycle = yield* LifecycleReconciler.Service
            yield* lifecycle.attach(spy.ops)
            yield* lifecycle.reconcile
            yield* lifecycle.reconcile
          }),
        )

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const state = yield* backgroundState(child.id)
            return state?.state === "completed" ? state : undefined
          }),
          "Timed out waiting for the resumed background task",
        )
        expect(yield* backgroundState(child.id)).toMatchObject({ state: "completed", output: "resumed result" })
        expect(yield* Ref.get(spy.runs)).toBe(1)
        expect(yield* Ref.get(spy.prompts)).toBe(0)
        // The parent is only nudged; its notification must not be awaited as the task result.
        expect(yield* Ref.get(spy.wakes)).toBe(1)
        expect((yield* MessageV2.stream(parent.id)).filter(isTaskNotification)).toHaveLength(1)
      }),
    ),
  )

  it.live("pause racing a member run suspends the teammate instead of cancelling it", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { lead, info, member, memberSession } = yield* seedTeam()
          const paused = yield* Deferred.make<void>()
          // The prompt loses the race with pause: the durable barrier commits first, so the fiber
          // is signalled and the prompt reports suspension instead of a result.
          const spy = yield* spyOps({
            onPrompt: () =>
              Effect.gen(function* () {
                yield* control.pause({ rootSessionID: lead.id }).pipe(Effect.orDie)
                yield* Deferred.succeed(paused, undefined)
                return yield* new Runner.Suspended()
              }),
          })

          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
          yield* Deferred.await(paused)

          expect(outcome).toContain("suspended")
          const suspended = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(suspended?.status).toBe("active")
          expect(suspended?.result).toBeFalsy()
          expect(yield* team.getMessages(info.id)).toHaveLength(1)
          expect((yield* team.getMessages(info.id))[0]?.id).toBe(`lifecycle:member:${member.id}:started:1`)
          expect(yield* control.state(SessionID.make(memberSession.id))).toMatchObject({ paused: true })

          yield* control.release(lead.id)
          expect(
            (yield* control.runnableResumeTickets([SessionID.make(memberSession.id)])).map((ticket) => ticket.reason),
          ).toEqual(["running"])
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("resuming a teammate awaits run and never settles from a wake result", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const spy = yield* spyOps({
            text: "resumed teammate result",
            onRun: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          })

          // A previous process already admitted the teammate prompt and left the member running.
          const promptMessageID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: promptMessageID,
            role: "user",
            sessionID: memberSession.id,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          yield* seedMemberMetadata({ sessionID: memberSession.id, memberID: member.id, promptMessageID })
          yield* team.updateMemberStatus(member.id, "active")

          const resumed = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops }).pipe(Effect.forkChild)

          yield* Deferred.await(started)
          expect(yield* Ref.get(spy.runs)).toBe(1)
          expect(yield* Ref.get(spy.prompts)).toBe(0)
          expect(yield* Ref.get(spy.wakes)).toBe(0)
          // A wake would have returned immediately; the member must not settle before run answers.
          expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)?.status).toBe(
            "active",
          )
          expect(
            (yield* team.getMessages(info.id)).filter((message) => memberMessage("completed")(message)),
          ).toHaveLength(0)

          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(resumed)).toContain("resumed teammate result")
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("completed")
          expect(settled?.result).toBe("resumed teammate result")
          expect(yield* Ref.get(spy.runs)).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("repeated and concurrent starts dispatch a paused teammate exactly once", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { lead, info, member } = yield* seedTeam()
          const spy = yield* spyOps({ text: "single dispatch" })

          yield* control.pause({ rootSessionID: lead.id })
          expect(yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })).toContain("suspended")
          expect(yield* Ref.get(spy.prompts)).toBe(0)

          yield* Effect.all(
            [
              control.release(lead.id),
              control.release(lead.id),
              control.release(lead.id),
              lifecycle.reconcile,
              lifecycle.reconcile,
            ],
            { concurrency: "unbounded", discard: true },
          )
          yield* Effect.all([lifecycle.reconcile, lifecycle.reconcile, lifecycle.reconcile], {
            concurrency: "unbounded",
            discard: true,
          })

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
              return settled?.status === "completed" ? settled : undefined
            }),
            "Timed out waiting for the resumed teammate",
          )
          expect(yield* Ref.get(spy.prompts)).toBe(1)
          expect(
            (yield* team.getMessages(info.id)).filter((message) => memberMessage("completed")(message)),
          ).toHaveLength(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("retrying a notification after a failed nudge does not duplicate the injected result", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
        const failing = yield* spyOps({ wakeFails: true })

        yield* afterRestart(
          Effect.gen(function* () {
            const lifecycle = yield* LifecycleReconciler.Service
            const created = yield* lifecycle.registerBackground({
              sessionID: child.id,
              parentSessionID: parent.id,
              description: "retry once",
              agent: "general",
              model: ref,
              notifyParent: true,
              ops: failing.ops,
            })
            yield* lifecycle.settleBackground({
              sessionID: child.id,
              generation: created.generation,
              state: "completed",
              text: "single answer",
              ops: failing.ops,
            })
          }),
        )

        // The result is durably injected, but the nudge failed, so delivery stays outstanding.
        expect((yield* MessageV2.stream(parent.id)).filter(isTaskNotification)).toHaveLength(1)
        expect(yield* Ref.get(failing.wakes)).toBe(1)
        expect(yield* backgroundState(child.id)).toMatchObject({ notification: "pending" })
        const first = (yield* MessageV2.stream(parent.id)).filter(isTaskNotification)[0]!.info.id

        const retry = yield* spyOps()
        yield* afterRestart(
          Effect.gen(function* () {
            const lifecycle = yield* LifecycleReconciler.Service
            yield* lifecycle.attach(retry.ops)
            yield* lifecycle.reconcile
            yield* lifecycle.reconcile
          }),
        )

        // The retry reuses the recorded message ID instead of injecting a second result.
        const notifications = (yield* MessageV2.stream(parent.id)).filter(isTaskNotification)
        expect(notifications).toHaveLength(1)
        expect(notifications[0]?.info.id).toBe(first)
        expect(yield* backgroundState(child.id)).toMatchObject({ notification: "delivered" })
        expect(yield* Ref.get(retry.wakes)).toBe(1)
      }),
    ),
  )

  it.live("restart recovery returns a crashed mailbox claim to pending", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { lead, info, memberSession } = yield* seedTeam()
          yield* team.sendMessage({
            teamID: info.id,
            sender: lead.id,
            recipients: [memberSession.id],
            body: "handle this",
          })

          // The claim marks the row "read". A crash before the prompt turn acknowledges it would
          // otherwise strand the message, because "read" is no longer pending.
          const claimed = yield* team.claimPendingMessages(memberSession.id, info.id).pipe(Effect.orDie)
          expect(claimed).toHaveLength(1)
          expect(yield* team.getPendingMessages(memberSession.id, info.id)).toHaveLength(0)

          yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.init()))

          const recovered = yield* team.getPendingMessages(memberSession.id, info.id)
          expect(recovered).toHaveLength(1)
          expect(recovered[0]?.body).toBe("handle this")
          const reclaimed = yield* team.claimPendingMessages(memberSession.id, info.id).pipe(Effect.orDie)
          expect(reclaimed).toHaveLength(1)
          yield* team.markMessageDelivered(reclaimed[0]!.id, memberSession.id)

          // An acknowledged row must stay delivered across a later restart.
          yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.init()))
          expect(yield* team.getPendingMessages(memberSession.id, info.id)).toHaveLength(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("concurrent reconcilers deliver a background notification exactly once", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
        const spy = yield* spyOps()

        const registration = yield* afterRestart(
          Effect.gen(function* () {
            const lifecycle = yield* LifecycleReconciler.Service
            const created = yield* lifecycle.registerBackground({
              sessionID: child.id,
              parentSessionID: parent.id,
              description: "notify once",
              agent: "general",
              model: ref,
              notifyParent: true,
              ops: spy.ops,
            })
            yield* lifecycle.settleBackground({
              sessionID: child.id,
              generation: created.generation,
              state: "completed",
              text: "background answer",
              ops: spy.ops,
            })
            return created
          }),
        )
        expect(registration.generation).toBe(1)

        // Every reconciler owns separate in-memory state, so only the durable claim can serialize them.
        yield* Effect.all(
          [
            afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile)),
            afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile)),
            afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile)),
            afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile)),
          ],
          { concurrency: "unbounded", discard: true },
        )

        const notifications = (yield* MessageV2.stream(parent.id)).filter(isTaskNotification)
        expect(notifications).toHaveLength(1)
        expect(
          notifications[0]?.parts.some((part) => part.type === "text" && part.text.includes("background answer")),
        ).toBe(true)
        expect(yield* backgroundState(child.id)).toMatchObject({ notification: "delivered" })
      }),
    ),
  )

  test("assistantResult treats tool-calls and unknown finishes as nonterminal", () => {
    const sessionID = SessionID.make("ses-unit")
    const parentID = MessageID.ascending()
    const base = assistant(sessionID, parentID, "intermediate")
    const info = base.info as SessionV1.Assistant
    const userInfo: SessionV1.Info = {
      id: info.id,
      role: "user",
      sessionID,
      agent: "general",
      model: ref,
      time: { created: Date.now() },
    }
    expect(LifecycleReconciler.assistantResult(undefined)).toBeUndefined()
    expect(LifecycleReconciler.assistantResult(userInfo, base.parts)).toBeUndefined()
    expect(LifecycleReconciler.assistantResult({ ...info, finish: undefined }, base.parts)).toBeUndefined()
    expect(LifecycleReconciler.assistantResult({ ...info, finish: "tool-calls" }, base.parts)).toBeUndefined()
    expect(LifecycleReconciler.assistantResult({ ...info, finish: "unknown" }, base.parts)).toBeUndefined()
  })

  test("completion-only tool selection excludes arbitrary plugin and MCP tools", () => {
    const tools = {
      team_task_update: requestTool(),
      plugin_vendor_delete_project: requestTool(),
      mcp_database_execute: requestTool(),
    }

    const selected = LLMRequestPrep.selectTools(tools, { "*": false, team_task_update: true })

    expect(Object.keys(selected)).toEqual(["team_task_update"])
  })

  test("normal tool selection keeps dynamic tools unless the prompt denies them", () => {
    const tools = {
      team_spawn: requestTool(),
      plugin_vendor_read: requestTool(),
      mcp_database_query: requestTool(),
    }

    expect(LLMRequestPrep.selectTools(tools, undefined)).toEqual(tools)
    expect(Object.keys(LLMRequestPrep.selectTools(tools, { team_spawn: false }))).toEqual([
      "plugin_vendor_read",
      "mcp_database_query",
    ])
  })

  test("assistantResult joins non-synthetic non-ignored text parts in PartTable.id order and trims once", () => {
    const sessionID = SessionID.make("ses-unit")
    const parentID = MessageID.ascending()
    const base = assistant(sessionID, parentID, "")
    const id = base.info.id
    const result = LifecycleReconciler.assistantResult(base.info, [
      textPart(sessionID, id, "  first  "),
      textPart(sessionID, id, "hidden", { synthetic: true }),
      textPart(sessionID, id, "second", { ignored: true }),
      textPart(sessionID, id, "third"),
    ])
    expect(result).toEqual({ state: "completed", messageID: id, text: "first  \nthird", valid: true })
  })

  test("assistantResult reports synthetic-only and ignored-only turns as invalid blank results", () => {
    const sessionID = SessionID.make("ses-unit")
    const parentID = MessageID.ascending()
    const base = assistant(sessionID, parentID, "")
    const id = base.info.id
    expect(
      LifecycleReconciler.assistantResult(base.info, [textPart(sessionID, id, "hidden", { synthetic: true })]),
    ).toEqual({
      state: "completed",
      messageID: id,
      text: "",
      valid: false,
    })
    expect(
      LifecycleReconciler.assistantResult(base.info, [textPart(sessionID, id, "hidden", { ignored: true })]),
    ).toEqual({
      state: "completed",
      messageID: id,
      text: "",
      valid: false,
    })
  })

  test("assistantResult keeps a trailing blank text part from invalidating the result", () => {
    const sessionID = SessionID.make("ses-unit")
    const parentID = MessageID.ascending()
    const base = assistant(sessionID, parentID, "")
    const id = base.info.id
    const result = LifecycleReconciler.assistantResult(base.info, [
      textPart(sessionID, id, "real"),
      textPart(sessionID, id, "   "),
    ])
    expect(result).toEqual({ state: "completed", messageID: id, text: "real", valid: true })
  })

  test("assistantResult treats a tool-only turn as an invalid blank completed result", () => {
    const sessionID = SessionID.make("ses-unit")
    const parentID = MessageID.ascending()
    const base = assistant(sessionID, parentID, "")
    expect(LifecycleReconciler.assistantResult(base.info, [])).toEqual({
      state: "completed",
      messageID: base.info.id,
      text: "",
      valid: false,
    })
  })

  test("assistantResult reports an assistant error as an error result with the error text", () => {
    const sessionID = SessionID.make("ses-unit")
    const parentID = MessageID.ascending()
    const base = assistant(sessionID, parentID, "")
    const errored = {
      ...base.info,
      error: new SessionV1.StructuredOutputError({ message: "boom", retries: 0 }).toObject(),
    }
    expect(LifecycleReconciler.assistantResult(errored, [])).toEqual({
      state: "error",
      messageID: base.info.id,
      text: "boom",
    })
  })

  it.live("a tool-calls or unknown finish does not settle the teammate", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          for (const finish of ["tool-calls", "unknown"] as const) {
            const team = yield* Team.Service
            const lifecycle = yield* LifecycleReconciler.Service
            const { info, member } = yield* seedTeam()
            const spy = yield* spyOps({
              result: (sessionID, parentID) => {
                const base = assistant(sessionID, parentID, "intermediate")
                return { info: { ...base.info, finish }, parts: base.parts }
              },
            })
            const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
            expect(outcome).toContain("did not finish")
            const unsettled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
            expect(unsettled?.status).toBe("active")
            expect(unsettled?.result).toBeNull()
            const messages = yield* team.getMessages(info.id)
            expect(messages.filter((message) => memberMessage("completed")(message))).toHaveLength(0)
            expect(messages.filter((message) => memberMessage("cancelled")(message))).toHaveLength(0)
          }
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live(
    "a blank generation-1 result admits one completion-only retry, then settles cancelled as empty_result when still blank",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const team = yield* Team.Service
            const lifecycle = yield* LifecycleReconciler.Service
            const { info, member } = yield* seedTeam()
            const prompts: SessionPrompt.PromptInput[] = []
            const spy = yield* spyOps({
              result: (sessionID, parentID) => {
                const base = assistant(sessionID, parentID, "")
                return { info: { ...base.info, finish: "stop" }, parts: [] }
              },
              onPrompt: (promptInput) => Effect.sync(() => prompts.push(promptInput)),
            })
            const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
            const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
            expect(outcome).toBe("(no text result)")
            expect(settled?.status).toBe("cancelled")
            expect(settled?.failure_code).toBe("empty_result")
            expect(yield* Ref.get(spy.prompts)).toBe(2)
            // The retry prompt is completion-only at the request boundary.
            expectRetryPromptToolAllowList(prompts[1]?.tools)
            expect(prompts[1]?.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
              "no final text result",
            )
            const cancelledMessage = (yield* team.getMessages(info.id)).find((message) =>
              memberMessage("cancelled")(message),
            )
            expect(cancelledMessage?.body).toContain("empty_result")
            expect(cancelledMessage?.id).toBe(`lifecycle:member:${member.id}:cancelled:2`)
          }),
        { config: { experimental: { agent_teams: true } } },
      ),
  )

  it.live("live settlement and restart reconciliation extract the same result", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          let promptMessageID: MessageID | undefined
          const spy = yield* spyOps({
            onPrompt: (promptInput) =>
              Effect.sync(() => {
                promptMessageID = promptInput.messageID
              }),
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              const id = base.info.id
              return {
                info: base.info,
                parts: [
                  textPart(sessionID, id, "  alpha  "),
                  textPart(sessionID, id, "hidden", { synthetic: true }),
                  textPart(sessionID, id, "beta", { ignored: true }),
                  textPart(sessionID, id, "gamma"),
                ],
              }
            },
          })

          yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
          const live = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(live?.status).toBe("completed")
          expect(live?.result).toBe("alpha  \ngamma")
          expect(promptMessageID).toBeDefined()

          // Simulate a restart with the same persisted parts: put the member back into a runnable
          // state so restart reconciliation must re-extract from the stored parts.
          yield* team.updateMemberStatus(member.id, "active")
          yield* seedMemberMetadata({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID: promptMessageID!,
          })

          yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile))

          const restarted = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(restarted?.status).toBe("completed")
          expect(restarted?.result).toBe("alpha  \ngamma")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("an assistant error settles a finite teammate as cancelled with provider_error", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member } = yield* seedTeam()
          const spy = yield* spyOps({
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              return {
                info: {
                  ...base.info,
                  error: new SessionV1.StructuredOutputError({ message: "boom", retries: 0 }).toObject(),
                },
                parts: base.parts,
              }
            },
          })
          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
          expect(outcome).toBe("boom")
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("cancelled")
          expect(settled?.failure_code).toBe("provider_error")
          const cancelledMessage = (yield* team.getMessages(info.id)).find((message) =>
            memberMessage("cancelled")(message),
          )
          expect(cancelledMessage?.body).toContain("boom")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("restart reconciliation settles a member from an errored assistant as cancelled", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { info, member, memberSession } = yield* seedTeam()
          const promptMessageID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: promptMessageID,
            role: "user",
            sessionID: memberSession.id,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          const base = assistant(memberSession.id, promptMessageID, "")
          yield* sessions.updateMessage({
            ...base.info,
            error: new SessionV1.StructuredOutputError({ message: "boom", retries: 0 }).toObject(),
          })
          yield* seedMemberMetadata({ sessionID: memberSession.id, memberID: member.id, promptMessageID })
          yield* team.updateMemberStatus(member.id, "active")

          yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile))

          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("cancelled")
          expect(settled?.failure_code).toBe("provider_error")
          const cancelledMessage = (yield* team.getMessages(info.id)).find((message) =>
            memberMessage("cancelled")(message),
          )
          expect(cancelledMessage?.body).toContain("boom")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a new finite member is admitted at generation 1 with a persisted prompt ID", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          let admitted: SessionPrompt.PromptInput | undefined
          const spy = yield* spyOps({
            text: "work complete",
            onPrompt: (promptInput) => Effect.sync(() => (admitted = promptInput)),
          })

          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })

          expect(outcome).toBe("work complete")
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("completed")
          expect(settled?.result).toBe("work complete")
          expect(settled?.run_generation).toBe(1)
          expect((yield* memberState(memberSession.id))?.generation).toBe(1)
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
          // The initial prompt ID is persisted and reused, and the started notification is gen-scoped.
          expect(admitted?.messageID).toBeDefined()
          const messages = yield* team.getMessages(info.id)
          expect(messages.some((message) => message.id === `lifecycle:member:${member.id}:started:1`)).toBe(true)
          expect(messages.some((message) => message.id === `lifecycle:member:${member.id}:completed:1`)).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("terminal settlement wakes the lead before blocked publication that later fails", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const events = yield* EventV2Bridge.Service
          const { info, member } = yield* seedTeam()
          const spy = yield* spyOps({ text: "committed before publication" })
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const mutableEvents = events as Mutable<EventV2Bridge.Interface>
          const originalPublish = events.publish
          mutableEvents.publish = ((definition, data, options) =>
            definition.type === "team.member.updated"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.die(new Error("simulated lifecycle publication failure"))),
                )
              : originalPublish(definition, data, options)) as EventV2Bridge.Interface["publish"]
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              mutableEvents.publish = originalPublish
            }).pipe(Effect.andThen(Deferred.succeed(release, undefined)), Effect.asVoid),
          )

          const settlement = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops }).pipe(Effect.forkChild)
          yield* Deferred.await(entered)

          // The transaction and direct wake complete before the first publication can make progress.
          expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)?.status).toBe(
            "completed",
          )
          expect((yield* team.getMessages(info.id)).some(memberMessage("completed"))).toBe(true)
          expect(yield* Ref.get(spy.wakes)).toBe(1)
          expect(settlement.pollUnsafe()).toBeUndefined()

          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(settlement)).toBe("committed before publication")
          expect(yield* Ref.get(spy.wakes)).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a valid generation-1 result completes the member, unblocks dependents, and wakes the lead", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { lead, info, member, memberSession } = yield* seedTeam()
          const dependentSession = yield* sessions.create({ parentID: lead.id, title: "Dependent" })
          const dependent = yield* team.addMember({
            teamID: info.id,
            sessionID: dependentSession.id,
            name: "dependent",
            agentType: "general",
            model: ref,
            rolePrompt: "Wait for worker",
            dependencyIDs: [memberSession.id],
          })
          yield* team.updateMemberStatus(dependent.id, "blocked")
          const spy = yield* spyOps({ text: "worker done" })

          yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const members = yield* team.getMembers(info.id)
              return members.some((candidate) => candidate.id === dependent.id && candidate.status === "completed")
                ? members
                : undefined
            }),
            "Timed out waiting for the dependent to run",
          )
          const members = yield* team.getMembers(info.id)
          expect(members.find((candidate) => candidate.id === member.id)?.status).toBe("completed")
          expect(members.find((candidate) => candidate.id === dependent.id)?.status).toBe("completed")
          expect(yield* Ref.get(spy.prompts)).toBe(2)
          expect(yield* Ref.get(spy.wakes)).toBeGreaterThan(0)
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a blank generation-1 result admits a different retry prompt ID and a tools-restricted prompt", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          const prompts: SessionPrompt.PromptInput[] = []
          let calls = 0
          const spy = yield* spyOps({
            onPrompt: (promptInput) => Effect.sync(() => prompts.push(promptInput)),
            result: (sessionID, parentID) => {
              calls++
              return assistant(sessionID, parentID, calls === 1 ? "" : "retry success")
            },
          })

          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })

          expect(outcome).toBe("retry success")
          expect(prompts).toHaveLength(2)
          expect(prompts[0]?.messageID).toBeDefined()
          expect(prompts[1]?.messageID).not.toBe(prompts[0]?.messageID)
          // The request boundary applies this allow-list after dynamic tools are registered.
          expectRetryPromptToolAllowList(prompts[1]?.tools)
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("completed")
          expect(settled?.result).toBe("retry success")
          expect(settled?.run_generation).toBe(2)
          expect((yield* memberState(memberSession.id))?.generation).toBe(2)
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
          expect(
            (yield* team.getMessages(info.id)).some(
              (message) => message.id === `lifecycle:member:${member.id}:completed:2`,
            ),
          ).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a blank generation-2 result settles cancelled with empty_result and cancels blocked descendants", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          const dependentSession = yield* sessions.create({ parentID: memberSession.id, title: "Dependent" })
          const dependent = yield* team.addMember({
            teamID: info.id,
            sessionID: dependentSession.id,
            name: "dependent",
            agentType: "general",
            model: ref,
            rolePrompt: "Wait for worker",
            dependencyIDs: [memberSession.id],
          })
          yield* team.updateMemberStatus(dependent.id, "blocked")
          const spy = yield* spyOps({
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              return { info: { ...base.info, finish: "stop" }, parts: [] }
            },
          })

          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })

          expect(outcome).toBe("(no text result)")
          const members = yield* team.getMembers(info.id)
          const failedMember = members.find((candidate) => candidate.id === member.id)
          expect(failedMember?.status).toBe("cancelled")
          expect(failedMember?.failure_code).toBe("empty_result")
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
          const dependentNow = members.find((candidate) => candidate.id === dependent.id)
          expect(dependentNow?.status).toBe("cancelled")
          expect(dependentNow?.failure_code).toBe("dependency_failed")
          const messages = yield* team.getMessages(info.id)
          expect(messages.some((message) => message.id === `lifecycle:member:${dependent.id}:cancelled:0`)).toBe(true)
          expect(messages.some((message) => message.id === `lifecycle:member:${member.id}:cancelled:2`)).toBe(true)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live(
    "a member that owns an unfinished task retries with a completion-only prompt and settles cancelled as missing_task_handoff on the second valid result",
    () =>
      provideTmpdirInstance(
        (directory) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const team = yield* Team.Service
            const lifecycle = yield* LifecycleReconciler.Service
            const futil = yield* FSUtil.Service
            const { info, member, memberSession } = yield* seedTeam()
            // Create and claim an owned task bound to the member session.
            const owned = path.join(directory, "handoff.txt")
            yield* Effect.promise(() => fs.writeFile(owned, "x"))
            const ownedPath = yield* canonicalize(sessions, toolContext(memberSession.id), owned).pipe(
              Effect.provideService(FSUtil.Service, futil),
            )
            const task = yield* team.createTask({ teamID: info.id, description: "Owned work", owned: [ownedPath] })
            yield* team.claimTask(info.id, task.id, memberSession.id)

            const prompts: SessionPrompt.PromptInput[] = []
            const spy = yield* spyOps({
              onPrompt: (promptInput) => Effect.sync(() => prompts.push(promptInput)),
              result: (sessionID, parentID) => assistant(sessionID, parentID, "valid work result"),
            })

            const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })

            expect(outcome).toBe("valid work result")
            expect(prompts).toHaveLength(2)
            // The retry prompt is completion-only with team_task_update as the only enabled tool.
            expectRetryPromptToolAllowList(prompts[1]?.tools)
            const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
            expect(settled?.status).toBe("cancelled")
            expect(settled?.failure_code).toBe("missing_task_handoff")
            expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
            // The owned in-progress task was cancelled and its reservations released.
            const taskNow = yield* team.getTask(info.id, task.id)
            expect(Option.isSome(taskNow)).toBe(true)
            if (Option.isSome(taskNow)) expect(taskNow.value.status).toBe("cancelled")
            const { db } = yield* Database.Service
            const rows = yield* db
              .select()
              .from(TeamFileOwnershipTable)
              .where(eq(TeamFileOwnershipTable.task_id, task.id))
              .all()
              .pipe(Effect.orDie)
            expect(rows).toHaveLength(1)
            expect(rows[0]?.owner_session_id).toBe(memberSession.id)
            expect(rows[0]?.time_released).not.toBeNull()
          }),
        { config: { experimental: { agent_teams: true } } },
      ),
  )

  it.live("a member with no owned tasks settles a valid result without retry", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          const prompts: SessionPrompt.PromptInput[] = []
          const spy = yield* spyOps({
            onPrompt: (promptInput) => Effect.sync(() => prompts.push(promptInput)),
            result: (sessionID, parentID) => assistant(sessionID, parentID, "plain result"),
          })

          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })

          expect(outcome).toBe("plain result")
          expect(prompts).toHaveLength(1)
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("completed")
          expect(settled?.result).toBe("plain result")
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("crash window W1 admits a persisted retry prompt exactly once", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const { info, member, memberSession } = yield* seedTeam()
          // A previous process admitted the retry (generation 2, retry_admitted) but crashed before
          // the prompt message was written.
          const retryPromptID = MessageID.ascending()
          yield* seedMemberMetadata({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID: retryPromptID,
            generation: 2,
            phase: "retry_admitted",
          })
          yield* team.updateMemberStatus(member.id, "active")
          yield* setMemberRunGeneration(member.id, 2)
          const prompts: SessionPrompt.PromptInput[] = []
          const spy = yield* spyOps({
            onPrompt: (promptInput) => Effect.sync(() => prompts.push(promptInput)),
            // A nonterminal retry turn keeps the member on retry_running instead of settling.
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "retry work")
              return { info: { ...base.info, finish: "tool-calls" }, parts: base.parts }
            },
          })

          yield* afterRestart(
            Effect.gen(function* () {
              const lifecycle = yield* LifecycleReconciler.Service
              yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
            }),
          )

          expect(prompts).toHaveLength(1)
          expect(prompts[0]?.messageID).toBe(retryPromptID)
          // The persisted retry prompt keeps the completion-only allow-list.
          expectRetryPromptToolAllowList(prompts[0]?.tools)
          expect(yield* Ref.get(spy.runs)).toBe(0)
          expect((yield* memberState(memberSession.id))?.generation).toBe(2)
          expect((yield* memberState(memberSession.id))?.phase).toBe("retry_running")
          const active = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(active?.status).toBe("active")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("crash window W2 resumes a retry_running member without adding a user prompt", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { info, member, memberSession } = yield* seedTeam()
          // The previous process admitted the retry prompt and set retry_running before dying.
          const retryPromptID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: retryPromptID,
            role: "user",
            sessionID: memberSession.id,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          yield* seedMemberMetadata({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID: retryPromptID,
            generation: 2,
            phase: "retry_running",
          })
          yield* team.updateMemberStatus(member.id, "active")
          yield* setMemberRunGeneration(member.id, 2)
          const spy = yield* spyOps({ text: "retry result" })

          yield* afterRestart(
            Effect.gen(function* () {
              const lifecycle = yield* LifecycleReconciler.Service
              yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
            }),
          )

          expect(yield* Ref.get(spy.prompts)).toBe(0)
          expect(yield* Ref.get(spy.runs)).toBe(1)
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("completed")
          expect(settled?.result).toBe("retry result")
          expect(settled?.run_generation).toBe(2)
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("crash window W3 settles an existing terminal assistant exactly once", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { info, member, memberSession } = yield* seedTeam()
          const promptMessageID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: promptMessageID,
            role: "user",
            sessionID: memberSession.id,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          // The terminal assistant exists but settlement never committed.
          const terminalResult = assistant(memberSession.id, promptMessageID, "finished once")
          yield* sessions.updateMessage(terminalResult.info)
          for (const part of terminalResult.parts) yield* sessions.updatePart(part)
          yield* seedMemberMetadata({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID,
            generation: 1,
            phase: "running",
          })
          yield* team.updateMemberStatus(member.id, "active")
          yield* setMemberRunGeneration(member.id, 1)

          yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile))
          yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile))

          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("completed")
          expect(settled?.result).toBe("finished once")
          expect(settled?.run_generation).toBe(1)
          const completions = (yield* team.getMessages(info.id)).filter((message) =>
            memberMessage("completed")(message),
          )
          expect(completions).toHaveLength(1)
          expect(completions[0]?.id).toBe(`lifecycle:member:${member.id}:completed:1`)
          expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live(
    "adopts a generation-0 nonterminal member without a new prompt and never adopts terminal legacy members",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const team = yield* Team.Service
            const { info, member, memberSession } = yield* seedTeam()
            // Legacy facts: generation 0 member with a persisted prompt and running metadata.
            const promptMessageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: promptMessageID,
              role: "user",
              sessionID: memberSession.id,
              agent: "general",
              model: ref,
              time: { created: Date.now() },
            })
            yield* seedMemberMetadata({ sessionID: memberSession.id, memberID: member.id, promptMessageID })
            yield* team.updateMemberStatus(member.id, "active")
            const spy = yield* spyOps({ text: "adopted result" })

            yield* afterRestart(
              Effect.gen(function* () {
                const lifecycle = yield* LifecycleReconciler.Service
                yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
              }),
            )

            expect(yield* Ref.get(spy.prompts)).toBe(0)
            expect(yield* Ref.get(spy.runs)).toBe(1)
            const adopted = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
            expect(adopted?.status).toBe("completed")
            expect(adopted?.result).toBe("adopted result")
            expect(adopted?.run_generation).toBe(1)
            expect((yield* memberState(memberSession.id))?.generation).toBe(1)
            expect((yield* memberState(memberSession.id))?.phase).toBe("terminal")

            // A terminal legacy member (completed at generation 0) is never adopted or retried.
            const terminalSession = yield* sessions.create({ parentID: memberSession.id, title: "Terminal legacy" })
            const terminalMember = yield* team.addMember({
              teamID: info.id,
              sessionID: terminalSession.id,
              name: "terminal",
              agentType: "general",
              rolePrompt: "Already done",
            })
            yield* team.updateMemberStatus(terminalMember.id, "completed")
            yield* seedMemberMetadata({
              sessionID: terminalSession.id,
              memberID: terminalMember.id,
              promptMessageID: promptMessageID,
              state: "completed",
            })
            yield* setMemberRunGeneration(terminalMember.id, 0)

            yield* afterRestart(Effect.flatMap(LifecycleReconciler.Service, (lifecycle) => lifecycle.reconcile))

            const terminalNow = (yield* team.getMembers(info.id)).find(
              (candidate) => candidate.id === terminalMember.id,
            )
            expect(terminalNow?.status).toBe("completed")
            expect(terminalNow?.run_generation).toBe(0)
            expect(yield* Ref.get(spy.runs)).toBe(1)
          }),
        { config: { experimental: { agent_teams: true } } },
      ),
  )

  it.live("a stale settlement from an old generation changes nothing", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const { info, member, memberSession } = yield* seedTeam()
          // The member is really on generation 2, but a stale attempt carries generation-1 facts
          // together with a terminal assistant for the generation-1 prompt.
          const gen1PromptID = MessageID.ascending()
          yield* sessions.updateMessage({
            id: gen1PromptID,
            role: "user",
            sessionID: memberSession.id,
            agent: "general",
            model: ref,
            time: { created: Date.now() },
          })
          const staleResult = assistant(memberSession.id, gen1PromptID, "stale result")
          yield* sessions.updateMessage(staleResult.info)
          for (const part of staleResult.parts) yield* sessions.updatePart(part)
          yield* seedMemberMetadata({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID: gen1PromptID,
            generation: 1,
            phase: "running",
          })
          yield* team.updateMemberStatus(member.id, "active")
          yield* setMemberRunGeneration(member.id, 2)
          const before = yield* team.getMessages(info.id)
          const spy = yield* spyOps()

          yield* afterRestart(
            Effect.gen(function* () {
              const lifecycle = yield* LifecycleReconciler.Service
              yield* lifecycle.attach(spy.ops)
              yield* lifecycle.reconcile
            }),
          )

          const after = yield* team.getMessages(info.id)
          expect(after).toHaveLength(before.length)
          const unchanged = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(unchanged?.status).toBe("active")
          expect(unchanged?.run_generation).toBe(2)
          expect(yield* Ref.get(spy.wakes)).toBe(0)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("pause during the retry prompt keeps the member active and never adds another prompt", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const control = yield* SessionControl.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { lead, info, member, memberSession } = yield* seedTeam()
          let promptIndex = 0
          const spy = yield* spyOps({
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              return { info: { ...base.info, finish: "stop" }, parts: [] }
            },
            onPrompt: () => {
              promptIndex++
              if (promptIndex === 2) {
                // The retry admission prompt loses the pause race and suspends.
                return Effect.gen(function* () {
                  yield* control.pause({ rootSessionID: lead.id }).pipe(Effect.orDie)
                  return yield* new Runner.Suspended()
                })
              }
              return Effect.void
            },
          })

          const outcome = yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })
          expect(outcome).toContain("suspended")
          expect(yield* Ref.get(spy.prompts)).toBe(2)
          const pausedMember = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(pausedMember?.status).toBe("active")
          expect(pausedMember?.run_generation).toBe(2)
          expect((yield* memberState(memberSession.id))?.phase).toBe("retry_admitted")
          expect(
            (yield* team.getMessages(info.id)).filter((message) => memberMessage("cancelled")(message)),
          ).toHaveLength(0)

          // Releasing the pause resumes the same prompt; no second user prompt is ever added.
          yield* control.release(lead.id)
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile

          yield* pollWithTimeout(
            Effect.gen(function* () {
              const members = yield* team.getMembers(info.id)
              return members.some((candidate) => candidate.id === member.id && candidate.status === "cancelled")
                ? members
                : undefined
            }),
            "Timed out waiting for the resumed retry to settle",
          )
          expect(yield* Ref.get(spy.prompts)).toBe(2)
          expect(yield* Ref.get(spy.runs)).toBe(1)
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)
          expect(settled?.status).toBe("cancelled")
          expect(settled?.failure_code).toBe("empty_result")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a blank daemon initialization result settles idle without retry", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "daemon-team", goal: "Watch", leadSessionID: lead.id })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "sentinel",
            agentType: "general",
            model: ref,
            rolePrompt: "Watch forever",
            lifecycle: "daemon",
          })
          const prompts: SessionPrompt.PromptInput[] = []
          const spy = yield* spyOps({
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              return { info: { ...base.info, finish: "stop" }, parts: [] }
            },
            onPrompt: (promptInput) => Effect.sync(() => prompts.push(promptInput)),
          })

          const outcome = yield* lifecycle.startMember({ memberID: daemon.id, ops: spy.ops })

          expect(outcome).toBe("Daemon teammate initialized.")
          expect(prompts).toHaveLength(1)
          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === daemon.id)
          expect(settled?.status).toBe("idle")
          expect(settled?.run_generation).toBe(1)
          expect((yield* memberState(daemonSession.id))?.phase).toBe("terminal")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("a settled idle daemon keeps the team revision constant across reconcile polls", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "daemon-team", goal: "Watch", leadSessionID: lead.id })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "sentinel",
            agentType: "general",
            model: ref,
            rolePrompt: "Watch forever",
            lifecycle: "daemon",
          })
          const spy = yield* spyOps({
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              return { info: { ...base.info, finish: "stop" }, parts: [] }
            },
          })

          // Member creation already bumped once, so capture the baseline before the admission.
          const baseline = yield* teamRevision(info.id)
          yield* lifecycle.startMember({ memberID: daemon.id, ops: spy.ops })

          const settled = (yield* team.getMembers(info.id)).find((candidate) => candidate.id === daemon.id)
          expect(settled?.status).toBe("idle")
          // The admission (0 -> 1) and the first active -> idle settlement each bump exactly once.
          const revision = yield* teamRevision(info.id)
          expect(revision).toBe(baseline + 2)
          expect((yield* team.getMessages(info.id)).filter((message) => memberMessage("idle")(message))).toHaveLength(1)

          // Reconcile polls keep re-settling the idle daemon; each poll must be a durable no-op
          // that neither rewrites the row nor bumps the revision.
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile
          yield* lifecycle.reconcile

          expect(yield* teamRevision(info.id)).toBe(revision)
          expect((yield* team.getMessages(info.id)).filter((message) => memberMessage("idle")(message))).toHaveLength(1)
          expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === daemon.id)?.status).toBe("idle")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("re-activating an already active member does not bump the team revision", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service
          const { info, member, memberSession } = yield* seedTeam()
          // The run returns a nonterminal turn, so the first admission leaves the member active
          // with running metadata instead of settling it.
          const spy = yield* spyOps({
            result: (sessionID, parentID) => {
              const base = assistant(sessionID, parentID, "")
              return { info: { ...base.info, finish: "tool-calls" }, parts: [] }
            },
          })
          // seedTeam's member creation already bumped once; the admission bumps exactly once more.
          const baseline = yield* teamRevision(info.id)

          expect(yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })).toBe("Teammate did not finish.")
          expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)?.status).toBe(
            "active",
          )
          expect((yield* memberState(memberSession.id))?.state).toBe("running")
          // The one admission (status -> active, generation 0 -> 1, started message) bumped once.
          const revision = yield* teamRevision(info.id)
          expect(revision).toBe(baseline + 1)

          // The second start resumes the already-active member: no status change, no new started
          // message, so it must neither rewrite the row nor bump the revision.
          expect(yield* lifecycle.startMember({ memberID: member.id, ops: spy.ops })).toBe("Teammate did not finish.")
          expect(yield* teamRevision(info.id)).toBe(revision)
          expect(yield* Ref.get(spy.prompts)).toBe(1)
          expect(yield* Ref.get(spy.runs)).toBe(1)
          expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)?.status).toBe(
            "active",
          )
          expect((yield* memberState(memberSession.id))?.state).toBe("running")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
