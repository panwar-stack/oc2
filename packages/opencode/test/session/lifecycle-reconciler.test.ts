import { afterEach, describe, expect } from "bun:test"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Runner } from "@/effect/runner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Team } from "@/team/team"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { eq } from "drizzle-orm"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

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

type OpsSpy = {
  readonly ops: TaskPromptOps
  readonly prompts: Ref.Ref<number>
  readonly wakes: Ref.Ref<number>
  readonly runs: Ref.Ref<number>
}

/**
 * Builds prompt ops that count every entry point separately, so a test can prove which contract the
 * reconciler used. `wake` is deliberately non-blocking and answers no result.
 */
const spyOps = Effect.fn("LifecycleReconcilerTest.spyOps")(function* (input?: {
  readonly text?: string
  readonly onPrompt?: (promptInput: SessionPrompt.PromptInput) => Effect.Effect<void, Runner.Suspended>
  readonly onRun?: (sessionID: SessionID) => Effect.Effect<void, Runner.Suspended>
  readonly wakeFails?: boolean
}) {
  const sessions = yield* Session.Service
  const prompts = yield* Ref.make(0)
  const wakes = yield* Ref.make(0)
  const runs = yield* Ref.make(0)
  const text = input?.text ?? "done"
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
        return yield* persist(assistant(promptInput.sessionID, messageID, text))
      }),
    wake: () =>
      Ref.update(wakes, (count) => count + 1).pipe(
        Effect.andThen(input?.wakeFails ? Effect.fail(new Runner.Suspended()) : Effect.void),
      ),
    run: (sessionID) =>
      Effect.gen(function* () {
        yield* Ref.update(runs, (count) => count + 1)
        if (input?.onRun) yield* input.onRun(sessionID)
        return yield* persist(assistant(sessionID, MessageID.ascending(), text))
      }),
  }
  return { ops, prompts, wakes, runs } satisfies OpsSpy
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
          state: "running",
        },
      },
      time_updated: Date.now(),
    })
    .where(eq(SessionTable.id, input.sessionID))
    .run()
    .pipe(Effect.orDie)
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
          expect((yield* team.getMessages(info.id))[0]?.id).toBe(`lifecycle:member:${member.id}:started`)
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
            (yield* team.getMessages(info.id)).filter((message) => message.id.endsWith(":completed")),
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
            (yield* team.getMessages(info.id)).filter((message) => message.id.endsWith(":completed")),
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
})
