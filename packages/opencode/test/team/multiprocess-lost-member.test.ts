import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Team } from "@/team/team"
import { TeamMemberTable, TeamTable } from "@/team/team.sql"
import { TeamControlPlane } from "@/team/control-plane"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// PR 5 independent-review M1/M2 regression: durable lost-member detection must
// reach a parked daemon whose metadata state is "idle" (not "running"), and must
// never fire for a healthy parked daemon whose heartbeat refreshed its liveness
// clock. The checks are deterministic: they seed the durable clock directly and
// run a single reconcile tick. No fixed sleep is used as a sync point.

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
    LifecycleReconciler.defaultLayer,
    Session.defaultLayer,
    SessionControl.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
  ),
)

const TIMEOUT_ENV = "OC2_TEAM_LOST_MEMBER_TIMEOUT_MS"
const CONFIG_CONTENT_ENV = "OC2_CONFIG_CONTENT"
const originalTimeout = process.env[TIMEOUT_ENV]

afterEach(async () => {
  if (originalTimeout === undefined) delete process.env[TIMEOUT_ENV]
  else process.env[TIMEOUT_ENV] = originalTimeout
  await disposeAllInstances()
})

/** Reads the durable team revision, the anchor for the settlement-bump check. */
const teamRevision = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ revision: TeamTable.revision })
    .from(TeamTable)
    .where(eq(TeamTable.id, teamID))
    .get()
    .pipe(Effect.orDie)
  return row?.revision ?? 0
})

/** Seeds the durable remote-member metadata a spawned process would leave behind. */
const seedRemoteMember = Effect.fnUntraced(function* (input: {
  sessionID: SessionID
  memberID: string
  promptMessageID: string
  generation: number
  state: "running" | "idle"
  remoteSpawnedAt: number
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
          state: input.state,
          generation: input.generation,
          phase: "terminal",
          remoteSpawnedAt: input.remoteSpawnedAt,
        },
      },
      time_updated: Date.now(),
    })
    .where(eq(SessionTable.id, input.sessionID))
    .run()
    .pipe(Effect.orDie)
})

/** Sets the durable member row this member's metadata generation must match. */
const seedMemberRow = Effect.fnUntraced(function* (input: {
  memberID: string
  status: "active" | "idle"
  generation: number
  daemonLastActive: number | null
  daemonState?: "initializing" | "running" | "idle" | null
}) {
  const { db } = yield* Database.Service
  yield* db
    .update(TeamMemberTable)
    .set({
      status: input.status,
      run_generation: input.generation,
      daemon_last_active: input.daemonLastActive,
      ...(input.daemonState !== undefined ? { daemon_state: input.daemonState } : {}),
      time_updated: Date.now(),
    })
    .where(eq(TeamMemberTable.id, input.memberID))
    .run()
    .pipe(Effect.orDie)
})

const memberRow = Effect.fnUntraced(function* (teamID: string, memberID: string) {
  const team = yield* Team.Service
  return (yield* team.getMembers(teamID)).find((candidate) => candidate.id === memberID)
})

/** Persists one terminal assistant turn parented to the admitted prompt, matching
 * what a remote member's transcript sync projects before POST /result. */
const writeAssistantResult = Effect.fnUntraced(function* (input: {
  sessionID: SessionID
  parentID: string
  text: string
}) {
  const sessions = yield* Session.Service
  const id = MessageID.ascending()
  yield* sessions.updateMessage({
    id,
    role: "assistant",
    parentID: MessageID.make(input.parentID),
    sessionID: input.sessionID,
    mode: "general",
    agent: "general",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
  })
})

/** Reads the raw durable member metadata of a session. */
const rawMemberMetadata = Effect.fnUntraced(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row?.metadata?.lifecycleTeamMember as
    | { state?: string; generation?: number; remoteSpawnedAt?: number }
    | undefined
})

describe("multiprocess durable lost-member detection", () => {
  it.live("settles a parked daemon cancelled with provider_error when its liveness clock is stale", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env[TIMEOUT_ENV] = "1000"
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service

          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "lost-daemon-team", goal: "Watch", leadSessionID: lead.id })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "sentinel",
            agentType: "general",
            model: ref,
            rolePrompt: "Watch forever",
            lifecycle: "daemon",
            daemonState: "idle",
            daemonLastActive: Date.now() - 60_000,
          })
          const promptMessageID = `prompt-${daemon.id}`
          yield* seedRemoteMember({
            sessionID: daemonSession.id,
            memberID: daemon.id,
            promptMessageID,
            generation: 1,
            state: "idle",
            remoteSpawnedAt: Date.now() - 60_000,
          })
          yield* seedMemberRow({
            memberID: daemon.id,
            status: "idle",
            generation: 1,
            daemonLastActive: Date.now() - 60_000,
            daemonState: "idle",
          })

          const before = yield* teamRevision(info.id)
          yield* lifecycle.reconcile

          const settled = yield* memberRow(info.id, daemon.id)
          expect(settled?.status).toBe("cancelled")
          expect(settled?.failure_code).toBe("provider_error")

          const messages = yield* team.getMessages(info.id)
          const cancellation = messages.filter((message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`)
          expect(cancellation).toHaveLength(1)
          expect(cancellation[0]?.body).toContain("was lost")

          const after = yield* teamRevision(info.id)
          expect(after).toBe(before + 1)

          // A second tick changes nothing: the member is terminal and the generation
          // guard prevents a duplicate settlement and a second revision bump.
          yield* lifecycle.reconcile
          expect(yield* teamRevision(info.id)).toBe(after)
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`,
            ),
          ).toHaveLength(1)
          expect((yield* memberRow(info.id, daemon.id))?.status).toBe("cancelled")
        }),
      {
        config: { experimental: { agent_teams: true, team_multiprocess: true } },
      },
    ),
  )

  it.live("settles a remote finite member cancelled with provider_error when its liveness clock is stale", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env[TIMEOUT_ENV] = "1000"
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service

          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "lost-task-team", goal: "Run one task", leadSessionID: lead.id })
          const memberSession = yield* sessions.create({ parentID: lead.id, title: "Worker" })
          const member = yield* team.addMember({
            teamID: info.id,
            sessionID: memberSession.id,
            name: "worker",
            agentType: "general",
            model: ref,
            rolePrompt: "Do durable work",
          })
          const promptMessageID = `prompt-${member.id}`
          yield* seedRemoteMember({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID,
            generation: 1,
            state: "running",
            remoteSpawnedAt: Date.now() - 60_000,
          })
          yield* seedMemberRow({
            memberID: member.id,
            status: "active",
            generation: 1,
            daemonLastActive: Date.now() - 60_000,
          })

          const before = yield* teamRevision(info.id)
          yield* lifecycle.reconcile

          const settled = yield* memberRow(info.id, member.id)
          expect(settled?.status).toBe("cancelled")
          expect(settled?.failure_code).toBe("provider_error")
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `lifecycle:member:${member.id}:cancelled:1`,
            ),
          ).toHaveLength(1)
          expect(yield* teamRevision(info.id)).toBe(before + 1)
        }),
      {
        config: { experimental: { agent_teams: true, team_multiprocess: true } },
      },
    ),
  )

  it.live("never settles a healthy parked daemon whose heartbeat refreshed its liveness clock", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env[TIMEOUT_ENV] = "1000"
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service

          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "healthy-daemon-team", goal: "Watch", leadSessionID: lead.id })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "sentinel",
            agentType: "general",
            model: ref,
            rolePrompt: "Watch forever",
            lifecycle: "daemon",
            daemonState: "idle",
            daemonLastActive: Date.now(),
          })
          // remoteSpawnedAt is intentionally ancient while daemon_last_active is
          // fresh: the heartbeat must win, so the member is not lost.
          yield* seedRemoteMember({
            sessionID: daemonSession.id,
            memberID: daemon.id,
            promptMessageID: `prompt-${daemon.id}`,
            generation: 1,
            state: "idle",
            remoteSpawnedAt: Date.now() - 60_000,
          })
          yield* seedMemberRow({
            memberID: daemon.id,
            status: "idle",
            generation: 1,
            daemonLastActive: Date.now(),
            daemonState: "idle",
          })

          yield* lifecycle.reconcile

          const current = yield* memberRow(info.id, daemon.id)
          expect(current?.status).toBe("idle")
          expect(current?.failure_code ?? null).toBeNull()
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`,
            ),
          ).toHaveLength(0)
        }),
      {
        config: { experimental: { agent_teams: true, team_multiprocess: true } },
      },
    ),
  )

  it.live("does not settle a member whose heartbeat refreshes after the stale scan", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env[TIMEOUT_ENV] = "1000"
          const config = yield* Config.Service
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service

          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "heartbeat-race-team", goal: "Watch", leadSessionID: lead.id })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "sentinel",
            agentType: "general",
            model: ref,
            rolePrompt: "Watch forever",
            lifecycle: "daemon",
            daemonState: "idle",
            daemonLastActive: Date.now() - 60_000,
          })
          const promptMessageID = `prompt-${daemon.id}`
          const staleAt = Date.now() - 60_000
          yield* seedRemoteMember({
            sessionID: daemonSession.id,
            memberID: daemon.id,
            promptMessageID,
            generation: 1,
            state: "idle",
            remoteSpawnedAt: staleAt,
          })
          yield* seedMemberRow({
            memberID: daemon.id,
            status: "idle",
            generation: 1,
            daemonLastActive: staleAt,
            daemonState: "idle",
          })
          const before = yield* teamRevision(info.id)

          // reconcile reads the member snapshot before it reads config. Hold that
          // config read to refresh the heartbeat after the stale scan but before
          // settleMember opens its transaction. No wall-clock sleep is needed.
          const staleScanFinished = yield* Deferred.make<void>()
          const releaseReconcile = yield* Deferred.make<void>()
          const controlledConfig = Config.Service.of({
            ...config,
            get: () =>
              Deferred.succeed(staleScanFinished, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReconcile)),
                Effect.andThen(config.get()),
              ),
          })
          const reconcileFiber = yield* lifecycle.reconcile.pipe(
            Effect.provideService(Config.Service, controlledConfig),
            Effect.forkScoped,
          )
          yield* Deferred.await(staleScanFinished)
          yield* seedMemberRow({
            memberID: daemon.id,
            status: "idle",
            generation: 1,
            daemonLastActive: Date.now(),
            daemonState: "idle",
          })
          yield* Deferred.succeed(releaseReconcile, undefined)
          yield* Fiber.join(reconcileFiber)

          const current = yield* memberRow(info.id, daemon.id)
          expect(current?.status).toBe("idle")
          expect(current?.failure_code ?? null).toBeNull()
          expect(yield* teamRevision(info.id)).toBe(before)
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`,
            ),
          ).toHaveLength(0)
        }),
      {
        config: { experimental: { agent_teams: true, team_multiprocess: true } },
      },
    ),
  )

  it.live("uses a newer remoteSpawnedAt when daemon_last_active is older", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env[TIMEOUT_ENV] = "1000"
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service

          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "fresh-spawn-team", goal: "Run one task", leadSessionID: lead.id })
          const memberSession = yield* sessions.create({ parentID: lead.id, title: "Worker" })
          const member = yield* team.addMember({
            teamID: info.id,
            sessionID: memberSession.id,
            name: "worker",
            agentType: "general",
            model: ref,
            rolePrompt: "Do durable work",
          })
          const promptMessageID = `prompt-${member.id}`
          yield* seedRemoteMember({
            sessionID: memberSession.id,
            memberID: member.id,
            promptMessageID,
            generation: 1,
            state: "running",
            remoteSpawnedAt: Date.now(),
          })
          yield* seedMemberRow({
            memberID: member.id,
            status: "active",
            generation: 1,
            daemonLastActive: Date.now() - 60_000,
          })

          yield* lifecycle.reconcile

          const current = yield* memberRow(info.id, member.id)
          expect(current?.status).toBe("active")
          expect(current?.failure_code ?? null).toBeNull()
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `lifecycle:member:${member.id}:cancelled:1`,
            ),
          ).toHaveLength(0)
        }),
      {
        config: { experimental: { agent_teams: true, team_multiprocess: true } },
      },
    ),
  )

  it.live(
    "settleRemoteMember keeps the remoteSpawnedAt marker on the idle metadata, so a later stale heartbeat is caught",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            process.env[TIMEOUT_ENV] = "1000"
            const sessions = yield* Session.Service
            const team = yield* Team.Service
            const lifecycle = yield* LifecycleReconciler.Service

            const lead = yield* sessions.create({ title: "Lead" })
            const info = yield* team.create({ name: "remote-idle-team", goal: "Watch", leadSessionID: lead.id })
            const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
            const daemon = yield* team.addMember({
              teamID: info.id,
              sessionID: daemonSession.id,
              name: "sentinel",
              agentType: "general",
              model: ref,
              rolePrompt: "Watch forever",
              lifecycle: "daemon",
              daemonState: "initializing",
              daemonLastActive: Date.now(),
            })
            // The spawn path would have left this durable admission, clock, and
            // remoteSpawnedAt marker behind for generation 1. The prompt ID must
            // be a real ascending message ID because settleRemoteMember validates it.
            const promptMessageID = String(MessageID.ascending())
            const spawnedAt = Date.now() - 60_000
            yield* seedRemoteMember({
              sessionID: daemonSession.id,
              memberID: daemon.id,
              promptMessageID,
              generation: 1,
              state: "running",
              remoteSpawnedAt: spawnedAt,
            })
            yield* seedMemberRow({
              memberID: daemon.id,
              status: "active",
              generation: 1,
              daemonLastActive: spawnedAt,
              daemonState: "running",
            })
            // The remote report settles the initial idle turn through the real
            // settleRemoteMember contract.
            yield* writeAssistantResult({ sessionID: daemonSession.id, parentID: promptMessageID, text: "idle" })
            const settled = yield* lifecycle.settleRemoteMember({ memberID: daemon.id })
            expect(settled.kind).toBe("settled")
            if (settled.kind === "settled") expect(settled.status).toBe("idle")
            expect((yield* memberRow(info.id, daemon.id))?.status).toBe("idle")

            // The idle metadata must keep the marker; otherwise the lost-member
            // check below can never see this member.
            const idleMetadata = yield* rawMemberMetadata(daemonSession.id)
            expect(idleMetadata?.state).toBe("idle")
            expect(idleMetadata?.remoteSpawnedAt).toBe(spawnedAt)

            // Now go stale without a heartbeat: the moved lost-member check must
            // settle the parked daemon cancelled with provider_error.
            const staleAt = Date.now() - 60_000
            yield* seedRemoteMember({
              sessionID: daemonSession.id,
              memberID: daemon.id,
              promptMessageID,
              generation: 1,
              state: "idle",
              remoteSpawnedAt: spawnedAt,
            })
            yield* seedMemberRow({
              memberID: daemon.id,
              status: "idle",
              generation: 1,
              daemonLastActive: staleAt,
              daemonState: "idle",
            })
            yield* lifecycle.reconcile

            const lost = yield* memberRow(info.id, daemon.id)
            expect(lost?.status).toBe("cancelled")
            expect(lost?.failure_code).toBe("provider_error")
            expect(
              (yield* team.getMessages(info.id)).filter(
                (message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`,
              ),
            ).toHaveLength(1)
          }),
        {
          config: { experimental: { agent_teams: true, team_multiprocess: true } },
        },
      ),
  )

  it.live("keeps the remoteSpawnedAt marker when a remote settlement is deferred by an active pause", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env[TIMEOUT_ENV] = "1000"
          const control = yield* SessionControl.Service
          const sessions = yield* Session.Service
          const team = yield* Team.Service
          const lifecycle = yield* LifecycleReconciler.Service

          const lead = yield* sessions.create({ title: "Lead" })
          const info = yield* team.create({ name: "paused-remote-team", goal: "Watch", leadSessionID: lead.id })
          const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
          const daemon = yield* team.addMember({
            teamID: info.id,
            sessionID: daemonSession.id,
            name: "sentinel",
            agentType: "general",
            model: ref,
            rolePrompt: "Watch forever",
            lifecycle: "daemon",
            daemonState: "running",
            daemonLastActive: Date.now(),
          })
          const promptMessageID = String(MessageID.ascending())
          const spawnedAt = Date.now() - 60_000
          yield* seedRemoteMember({
            sessionID: daemonSession.id,
            memberID: daemon.id,
            promptMessageID,
            generation: 1,
            state: "running",
            remoteSpawnedAt: spawnedAt,
          })
          yield* seedMemberRow({
            memberID: daemon.id,
            status: "active",
            generation: 1,
            daemonLastActive: Date.now(),
            daemonState: "running",
          })

          // The remote daemon reports its initial idle turn, but the lead is
          // paused, so the settlement is deferred and only the durable fact is
          // persisted. The spawn marker must survive that write: it is what the
          // parked-daemon lost-member check reads after resume.
          yield* writeAssistantResult({ sessionID: daemonSession.id, parentID: promptMessageID, text: "idle" })
          yield* control.pause({ rootSessionID: lead.id })
          const settled = yield* lifecycle.settleRemoteMember({ memberID: daemon.id })
          expect(settled.kind).toBe("stale")
          expect((yield* memberRow(info.id, daemon.id))?.status).toBe("active")

          const pausedMetadata = yield* rawMemberMetadata(daemonSession.id)
          expect(pausedMetadata?.state).toBe("idle")
          expect(pausedMetadata?.remoteSpawnedAt).toBe(spawnedAt)

          // After resume the daemon process is gone and its liveness clock is
          // stale. With the marker preserved the parked-daemon check fires and
          // settles it lost; without the marker the metadata state "idle" would
          // settle it healthy forever.
          yield* control.release(lead.id)
          yield* seedMemberRow({
            memberID: daemon.id,
            status: "idle",
            generation: 1,
            daemonLastActive: Date.now() - 60_000,
            daemonState: "idle",
          })
          yield* lifecycle.reconcile

          const lost = yield* memberRow(info.id, daemon.id)
          expect(lost?.status).toBe("cancelled")
          expect(lost?.failure_code).toBe("provider_error")
          expect(
            (yield* team.getMessages(info.id)).filter(
              (message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`,
            ),
          ).toHaveLength(1)
        }),
      {
        config: { experimental: { agent_teams: true, team_multiprocess: true } },
      },
    ),
  )

  it.live("keeps explicit opt-out behavior: a stale remote daemon is not settled when team_multiprocess is false", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env[CONFIG_CONTENT_ENV]
        delete process.env[CONFIG_CONTENT_ENV]
        return previous
      }),
      () =>
        provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              process.env[TIMEOUT_ENV] = "1000"
              const sessions = yield* Session.Service
              const team = yield* Team.Service
              const lifecycle = yield* LifecycleReconciler.Service

              const lead = yield* sessions.create({ title: "Lead" })
              const info = yield* team.create({ name: "flag-off-team", goal: "Watch", leadSessionID: lead.id })
              const daemonSession = yield* sessions.create({ parentID: lead.id, title: "Daemon" })
              const daemon = yield* team.addMember({
                teamID: info.id,
                sessionID: daemonSession.id,
                name: "sentinel",
                agentType: "general",
                model: ref,
                rolePrompt: "Watch forever",
                lifecycle: "daemon",
                daemonState: "idle",
                daemonLastActive: Date.now() - 60_000,
              })
              yield* seedRemoteMember({
                sessionID: daemonSession.id,
                memberID: daemon.id,
                promptMessageID: `prompt-${daemon.id}`,
                generation: 1,
                state: "idle",
                remoteSpawnedAt: Date.now() - 60_000,
              })
              yield* seedMemberRow({
                memberID: daemon.id,
                status: "idle",
                generation: 1,
                daemonLastActive: Date.now() - 60_000,
                daemonState: "idle",
              })

              yield* lifecycle.reconcile

              expect((yield* memberRow(info.id, daemon.id))?.status).toBe("idle")
              expect(
                (yield* team.getMessages(info.id)).filter(
                  (message) => message.id === `lifecycle:member:${daemon.id}:cancelled:1`,
                ),
              ).toHaveLength(0)
            }),
          {
            config: { experimental: { agent_teams: true, team_multiprocess: false } },
          },
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env[CONFIG_CONTENT_ENV]
          else process.env[CONFIG_CONTENT_ENV] = previous
        }),
    ),
  )
})

describe("resolveLostMemberTimeoutMs", () => {
  const withEnv = (value: string | undefined, assertion: () => void) => {
    if (value === undefined) delete process.env[TIMEOUT_ENV]
    else process.env[TIMEOUT_ENV] = value
    assertion()
  }

  test("uses the exported default when the override is absent", () => {
    withEnv(undefined, () => {
      expect(TeamControlPlane.LOST_MEMBER_TIMEOUT_MS).toBe(300_000)
      expect(TeamControlPlane.resolveLostMemberTimeoutMs()).toBe(TeamControlPlane.LOST_MEMBER_TIMEOUT_MS)
    })
  })

  test("reads a positive finite integer override", () => {
    withEnv("5000", () => {
      expect(TeamControlPlane.resolveLostMemberTimeoutMs()).toBe(5000)
    })
  })

  test("falls back to the default for a non-positive, non-integer, or garbage override", () => {
    for (const value of ["0", "-5", "1.5", "abc", "  "]) {
      withEnv(value, () => {
        expect(TeamControlPlane.resolveLostMemberTimeoutMs()).toBe(TeamControlPlane.LOST_MEMBER_TIMEOUT_MS)
      })
    }
  })
})
