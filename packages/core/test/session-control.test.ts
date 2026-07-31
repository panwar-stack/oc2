import { describe, expect } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { Location } from "@oc2-ai/core/location"
import { ProjectV2 } from "@oc2-ai/core/project"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SessionV2 } from "@oc2-ai/core/session"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { SessionExecution } from "@oc2-ai/core/session/execution"
import { SessionProjector } from "@oc2-ai/core/session/projector"
import { SessionStore } from "@oc2-ai/core/session/store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

function services(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projects = Layer.succeed(
    ProjectV2.Service,
    ProjectV2.Service.of({
      resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const control = SessionControl.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projects, projector, store, control, SessionExecution.noopLayer, sessions)
}

const it = testEffect(services(":memory:"))

function runTogether<A, E, R, B, E2, R2>(left: Effect.Effect<A, E, R>, right: Effect.Effect<B, E2, R2>) {
  return Effect.gen(function* () {
    const leftReady = yield* Deferred.make<void>()
    const rightReady = yield* Deferred.make<void>()
    const start = yield* Deferred.make<void>()
    const leftFiber = yield* Deferred.succeed(leftReady, undefined).pipe(
      Effect.andThen(Deferred.await(start)),
      Effect.andThen(left),
      Effect.forkChild,
    )
    const rightFiber = yield* Deferred.succeed(rightReady, undefined).pipe(
      Effect.andThen(Deferred.await(start)),
      Effect.andThen(right),
      Effect.forkChild,
    )
    yield* Deferred.await(leftReady)
    yield* Deferred.await(rightReady)
    yield* Deferred.succeed(start, undefined)
    return yield* Effect.all([Fiber.join(leftFiber), Fiber.join(rightFiber)], { concurrency: "unbounded" })
  })
}

describe("SessionControl", () => {
  it.effect("persists recursive blockers and exposes effective paused state", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const grandchild = yield* sessions.create({ location, parentID: child.id })
      const unrelated = yield* sessions.create({ location })

      const paused = yield* control.pause({
        rootSessionID: root.id,
        resumeIntents: [{ sessionID: child.id, reason: "running" }],
      })

      expect(new Set(paused.affectedSessionIDs)).toEqual(new Set([root.id, child.id, grandchild.id]))
      expect(paused.unchanged).toBeFalse()
      expect(yield* sessions.get(root.id)).toMatchObject({ paused: true })
      expect(yield* sessions.get(child.id)).toMatchObject({ paused: true })
      expect(yield* sessions.get(grandchild.id)).toMatchObject({ paused: true })
      expect(yield* sessions.get(unrelated.id)).toMatchObject({ paused: false })
      expect(new Map((yield* sessions.list()).map((session) => [session.id, session.paused]))).toEqual(
        new Map([
          [root.id, true],
          [child.id, true],
          [grandchild.id, true],
          [unrelated.id, false],
        ]),
      )

      const repeated = yield* control.pause({ rootSessionID: root.id })
      expect(repeated).toMatchObject({ cascadeID: paused.cascadeID, generation: paused.generation, unchanged: true })

      const released = yield* control.release(root.id)
      expect(released).toMatchObject({ unchanged: false, resumableSessionIDs: [child.id] })
      expect(yield* sessions.get(child.id)).toMatchObject({ paused: false })
      expect(yield* control.release(root.id)).toMatchObject({ unchanged: true })
    }),
  )

  it.effect("keeps overlapping child and ancestor cascades independent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const grandchild = yield* sessions.create({ location, parentID: child.id })

      const childPause = yield* control.pause({ rootSessionID: child.id })
      const rootPause = yield* control.pause({ rootSessionID: root.id })
      expect(new Set((yield* control.state(child.id)).blockerCascadeIDs)).toEqual(
        new Set([childPause.cascadeID, rootPause.cascadeID]),
      )
      expect(yield* control.release(child.id)).toMatchObject({
        stillBlockedSessionIDs: expect.arrayContaining([child.id, grandchild.id]),
      })
      expect(yield* control.state(child.id)).toMatchObject({ paused: true, owned: false })
      expect(yield* control.state(root.id)).toMatchObject({ paused: true, owned: true })

      yield* control.release(root.id)
      expect(yield* control.state(child.id)).toMatchObject({ paused: false, owned: false })

      const rootFirst = yield* sessions.create({ location })
      const childSecond = yield* sessions.create({ location, parentID: rootFirst.id })
      const rootFirstPause = yield* control.pause({ rootSessionID: rootFirst.id })
      const childSecondPause = yield* control.pause({ rootSessionID: childSecond.id })
      expect(new Set((yield* control.state(childSecond.id)).blockerCascadeIDs)).toEqual(
        new Set([rootFirstPause.cascadeID, childSecondPause.cascadeID]),
      )

      yield* control.release(rootFirst.id)
      expect(yield* control.state(rootFirst.id)).toMatchObject({ paused: false, owned: false })
      expect(yield* control.state(childSecond.id)).toMatchObject({ paused: true, owned: true })
      yield* control.release(childSecond.id)
      expect(yield* control.state(childSecond.id)).toMatchObject({ paused: false, owned: false })
    }),
  )

  it.effect("inherits active ancestor blockers during child projection", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const paused = yield* control.pause({ rootSessionID: root.id })

      const child = yield* sessions.create({ location, parentID: root.id })
      const grandchild = yield* sessions.create({ location, parentID: child.id })

      expect(yield* control.state(child.id)).toMatchObject({
        paused: true,
        blockerCascadeIDs: [paused.cascadeID],
      })
      expect(yield* control.state(grandchild.id)).toMatchObject({
        paused: true,
        blockerCascadeIDs: [paused.cascadeID],
      })
    }),
  )

  it.effect("serializes a pause racing with child creation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const childID = SessionV2.ID.make("ses_concurrent_pause_child")

      const [, child] = yield* runTogether(
        control.pause({ rootSessionID: root.id }),
        sessions.create({ id: childID, location, parentID: root.id }),
      )

      expect(child.id).toBe(childID)
      expect(yield* control.state(child.id)).toMatchObject({ paused: true })
    }),
  )

  it.effect("serializes concurrent pause and release calls for one root", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })

      const pauses = yield* runTogether(
        control.pause({
          rootSessionID: root.id,
          resumeIntents: [{ sessionID: root.id, reason: "running" }],
        }),
        control.pause({
          rootSessionID: root.id,
          resumeIntents: [{ sessionID: child.id, reason: "team-wake" }],
        }),
      )
      expect(new Set(pauses.map((result) => result.cascadeID)).size).toBe(1)
      expect(pauses.filter((result) => result.unchanged)).toHaveLength(1)

      const releases = yield* runTogether(control.release(root.id), control.release(root.id))
      expect(releases.filter((result) => result.unchanged)).toHaveLength(1)
      expect(new Set(releases.flatMap((result) => result.resumableSessionIDs))).toEqual(new Set([root.id, child.id]))
      expect(yield* control.state(root.id)).toMatchObject({ paused: false, owned: false })
    }),
  )

  it.effect("unions active members only when the selected subtree contains their lead", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const { db } = yield* Database.Service
      const lead = yield* sessions.create({ location })
      const member = yield* sessions.create({ location })
      const sibling = yield* sessions.create({ location })
      const completed = yield* sessions.create({ location })
      const cancelled = yield* sessions.create({ location })
      const now = Date.now()
      yield* db.run(sql`
        INSERT INTO team (id, name, goal, lead_session_id, status, time_created, time_updated)
        VALUES ('team_pause_test', 'pause test', 'test closure', ${lead.id}, 'active', ${now}, ${now})
      `)
      for (const [id, sessionID, name, status] of [
        ["member_pause_test", member.id, "member", "active"],
        ["sibling_pause_test", sibling.id, "idle-member", "idle"],
        ["completed_pause_test", completed.id, "completed-member", "completed"],
        ["cancelled_pause_test", cancelled.id, "cancelled-member", "cancelled"],
      ] as const) {
        yield* db.run(sql`
          INSERT INTO team_member (
            id, team_id, session_id, name, agent_type, role_prompt, status, plan_mode, work_mode,
            time_created, time_updated
          ) VALUES (
            ${id}, 'team_pause_test', ${sessionID}, ${name}, 'general', 'test', ${status}, false, 'implement',
            ${now}, ${now}
          )
        `)
      }

      const leadPause = yield* control.pause({ rootSessionID: lead.id })
      expect(new Set(leadPause.affectedSessionIDs)).toEqual(new Set([lead.id, member.id, sibling.id]))
      expect(yield* control.state(completed.id)).toMatchObject({ paused: false })
      expect(yield* control.state(cancelled.id)).toMatchObject({ paused: false })
      yield* control.release(lead.id)

      const memberPause = yield* control.pause({ rootSessionID: member.id })
      expect(memberPause.affectedSessionIDs).toEqual([member.id])
      expect(yield* control.state(sibling.id)).toMatchObject({ paused: false })
    }),
  )

  it.effect("publishes session updates after pause and release commit", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const events = yield* EventV2.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const updates: Array<{ sessionID: SessionV2.ID; paused: boolean; seq: number | undefined }> = []
      const isUpdated = Schema.is(SessionEvent.ControlChanged)
      const unsubscribe = yield* events.listen((event) =>
        isUpdated(event)
          ? Effect.gen(function* () {
              updates.push({
                sessionID: event.data.sessionID,
                paused: (yield* sessions.get(event.data.sessionID).pipe(Effect.orDie)).paused,
                seq: event.seq,
              })
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* control.pause({ rootSessionID: root.id })
      yield* control.pause({ rootSessionID: root.id })
      yield* control.release(root.id)
      yield* control.release(root.id)

      expect(updates).toEqual([
        { sessionID: child.id, paused: true, seq: expect.any(Number) },
        { sessionID: root.id, paused: true, seq: expect.any(Number) },
        { sessionID: child.id, paused: true, seq: expect.any(Number) },
        { sessionID: root.id, paused: true, seq: expect.any(Number) },
        { sessionID: child.id, paused: false, seq: expect.any(Number) },
        { sessionID: root.id, paused: false, seq: expect.any(Number) },
        { sessionID: child.id, paused: false, seq: expect.any(Number) },
        { sessionID: root.id, paused: false, seq: expect.any(Number) },
      ])
      for (const sessionID of [root.id, child.id]) {
        const seqs = updates.filter((update) => update.sessionID === sessionID).map((update) => update.seq ?? -1)
        expect(seqs).toEqual(seqs.toSorted((left, right) => left - right))
      }
      expect(yield* sessions.get(root.id)).toMatchObject({ paused: false })
    }),
  )

  it.effect("keeps committed control state when notification fails and retries invalidation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const events = yield* EventV2.Service
      const root = yield* sessions.create({ location })
      let failNotification = true
      let updates = 0
      yield* events.project(SessionEvent.ControlChanged, () =>
        failNotification ? Effect.die("control notification failed") : Effect.void,
      )
      const unsubscribe = yield* events.listen((event) =>
        Schema.is(SessionEvent.ControlChanged)(event)
          ? Effect.sync(() => {
              updates++
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(yield* control.pause({ rootSessionID: root.id })).toMatchObject({ unchanged: false })
      expect(yield* control.state(root.id)).toMatchObject({ paused: true, owned: true })
      expect(updates).toBe(0)

      failNotification = false
      expect(yield* control.pause({ rootSessionID: root.id })).toMatchObject({ unchanged: true })
      expect(updates).toBe(1)

      failNotification = true
      expect(yield* control.release(root.id)).toMatchObject({ unchanged: false })
      expect(yield* control.state(root.id)).toMatchObject({ paused: false, owned: false })
      expect(updates).toBe(1)

      failNotification = false
      expect(yield* control.release(root.id)).toMatchObject({ unchanged: true })
      expect(updates).toBe(2)
    }),
  )

  it.effect("uses monotonic generations for cascade and resume-intent CAS checks", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const first = yield* control.pause({ rootSessionID: root.id })
      expect(yield* control.isCascadeActive({ cascadeID: first.cascadeID, generation: first.generation })).toBeTrue()
      yield* control.release(root.id)
      expect(yield* control.isCascadeActive({ cascadeID: first.cascadeID, generation: first.generation })).toBeFalse()
      const second = yield* control.pause({ rootSessionID: root.id })
      expect(second.generation).toBe(first.generation + 1)

      const intent1 = yield* control.setResumeIntent({ sessionID: root.id, reason: "running" })
      const intent2 = yield* control.setResumeIntent({ sessionID: root.id, reason: "team-wake" })
      expect(intent2).toBe(intent1 + 1)
      expect(yield* control.isResumeIntentCurrent({ sessionID: root.id, generation: intent1 })).toBeFalse()
      expect(yield* control.clearResumeIntent({ sessionID: root.id, generation: intent1 })).toBeFalse()
      expect(yield* control.clearResumeIntent({ sessionID: root.id, generation: intent2 })).toBeFalse()
      yield* control.release(root.id)
      expect(yield* control.clearResumeIntent({ sessionID: root.id, generation: intent2 })).toBeTrue()
    }),
  )

  it.effect("issues blocker-aware resume tickets with running reason dominance", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      yield* control.pause({ rootSessionID: root.id })

      const queued = yield* control.requestResume({ sessionID: root.id, reason: "queued-input" })
      expect(queued).toMatchObject({ paused: true, ticket: { sessionID: root.id, reason: "queued-input" } })
      expect(yield* control.runnableResumeTickets([root.id])).toEqual([])
      expect(yield* control.finishResume(queued.ticket)).toBeFalse()

      const running = yield* control.requestResume({ sessionID: root.id, reason: "running" })
      const advisory = yield* control.requestResume({ sessionID: root.id, reason: "background-result" })
      expect(running.ticket.generation).toBe(queued.ticket.generation + 1)
      expect(advisory.ticket).toMatchObject({
        sessionID: root.id,
        generation: running.ticket.generation + 1,
        reason: "running",
      })

      const released = yield* control.release(root.id)
      expect(released.resumeTickets).toEqual([advisory.ticket])
      expect(released.resumableSessionIDs).toEqual([root.id])
      expect(yield* control.isResumeTicketRunnable(running.ticket)).toBeFalse()
      expect(yield* control.isResumeTicketRunnable(advisory.ticket)).toBeTrue()
      expect(yield* control.finishResume(running.ticket)).toBeFalse()
      expect(yield* control.finishResume(advisory.ticket)).toBeTrue()
      expect(yield* control.runnableResumeTickets([root.id])).toEqual([])
    }),
  )

  it.live("pause signals the registered interrupter directly and reports the signalled sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const control = yield* SessionControl.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const grandchild = yield* sessions.create({ location, parentID: child.id })
      const observed: (readonly SessionV2.ID[])[] = []
      const barrierCommitted: boolean[] = []

      const unregister = yield* control.registerInterrupter((sessionIDs) =>
        Effect.gen(function* () {
          observed.push(sessionIDs)
          // The durable barrier must already be visible when interruption is signalled.
          barrierCommitted.push((yield* control.state(root.id).pipe(Effect.orDie)).paused)
          return sessionIDs.filter((sessionID) => sessionID !== grandchild.id)
        }),
      )

      const paused = yield* control.pause({ rootSessionID: root.id })

      expect(observed).toHaveLength(1)
      expect(barrierCommitted).toEqual([true])
      // Descendants are signalled before their root.
      expect(observed[0]?.indexOf(grandchild.id)).toBeLessThan(observed[0]!.indexOf(root.id))
      expect(observed[0]?.indexOf(child.id)).toBeLessThan(observed[0]!.indexOf(root.id))
      expect([...paused.interruptionSignalledSessionIDs].sort()).toEqual([child.id, root.id].sort())

      yield* unregister
      yield* control.release(root.id)
      yield* control.pause({ rootSessionID: root.id })
      expect(observed).toHaveLength(1)
    }),
  )

  it.live("retains blockers and resume intent across service restart", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "pause.sqlite")
      const ids = yield* Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const control = yield* SessionControl.Service
        const root = yield* sessions.create({ location })
        const child = yield* sessions.create({ location, parentID: root.id })
        const paused = yield* control.pause({
          rootSessionID: root.id,
          resumeIntents: [{ sessionID: child.id, reason: "background-result" }],
        })
        return { rootID: root.id, childID: child.id, cascadeID: paused.cascadeID, generation: paused.generation }
      }).pipe(Effect.provide(Layer.fresh(services(filename))), Effect.scoped)

      yield* Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const control = yield* SessionControl.Service
        expect(yield* sessions.get(ids.childID)).toMatchObject({ paused: true })
        expect(yield* control.isCascadeActive({ cascadeID: ids.cascadeID, generation: ids.generation })).toBeTrue()
        expect(yield* control.release(ids.rootID)).toMatchObject({ resumableSessionIDs: [ids.childID] })
      }).pipe(Effect.provide(Layer.fresh(services(filename))), Effect.scoped)
    }),
  )
})
