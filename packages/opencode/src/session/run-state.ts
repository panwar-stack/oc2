import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Deferred, Effect, Latch, Layer, Scope, Context, Schema } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { Database } from "@oc2-ai/core/database/database"
import { SessionControl } from "@oc2-ai/core/session/control"
import { EventV2 } from "@oc2-ai/core/event"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { PendingMailbox } from "@/team/pending-mailbox"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { eq } from "drizzle-orm"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly assertNotSuspended: (sessionID: SessionID) => Effect.Effect<void, Runner.Suspended>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** Signals pause-specific suspension. Resolves to true when live work was actually signalled. */
  readonly suspend: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Registers the current same-process finalization park and returns identity-safe cleanup. */
  readonly registerPark: (
    sessionID: SessionID,
    signal: Deferred.Deferred<void>,
    continuation: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
  ) => Effect.Effect<ParkHandle>
  /**
   * Atomically retires an unnotified park at successful finalization so a signal before Runner
   * settlement can queue one continuation. A notified matching park is replaced instead and
   * returns false so the barrier must recheck durable state.
   */
  readonly handoffPark: (
    sessionID: SessionID,
    signal: Deferred.Deferred<void>,
    replacement: Deferred.Deferred<void>,
  ) => Effect.Effect<boolean>
  /** Signals an active park, or records one continuation signal on a retiring park. */
  readonly signalPark: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Registers the Prompt continuation used when a direct durable wake has no live park. */
  readonly registerWakeTarget: (make: (sessionID: SessionID) => WakeTarget) => Effect.Effect<Effect.Effect<void>>
  /**
   * Signals an active or retiring park and otherwise schedules the registered Prompt continuation.
   * This is the direct durable-producer entry point; it never fails when the session is paused.
   */
  readonly wakeRegistered: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
    attached?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Runner.Suspended>
  readonly wake: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
  ) => Effect.Effect<boolean, Runner.Suspended>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError | Runner.Suspended>
  readonly startSubstitution: (
    sessionID: SessionID,
    work: Effect.Effect<string[]>,
  ) => Effect.Effect<string[], Session.BusyError | Runner.Suspended>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export interface ParkHandle {
  /** Atomically notifies this exact registration in either its active or retiring phase. */
  readonly notify: () => boolean
  readonly unregister: Effect.Effect<void>
}

export interface WakeTarget {
  readonly onInterrupt: Effect.Effect<SessionV1.WithParts>
  readonly work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>
}

type WakeTargetRegistration = {
  readonly make: (sessionID: SessionID) => WakeTarget
}

type Park = {
  phase: "active" | "retiring"
  signal: Deferred.Deferred<void>
  readonly continuation: Effect.Effect<SessionV1.WithParts, Runner.Suspended>
  retirement?: Runner.Retirement
  notified: boolean
  readonly notify: () => boolean
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const control = yield* SessionControl.Service
    let wakeTarget: WakeTargetRegistration | undefined

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts, Runner.Suspended>>()
        const substitutions = new Map<SessionID, Runner.Runner<string[]>>()
        const parks = new Map<SessionID, Park>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            yield* Effect.forEach(substitutions.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            substitutions.clear()
            parks.clear()
          }),
        )
        return { runners, substitutions, parks, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      let next!: Runner.Runner<SessionV1.WithParts, Runner.Suspended>
      next = Runner.make<SessionV1.WithParts, Runner.Suspended>(data.scope, {
        onIdle: Effect.gen(function* () {
          const removed = yield* Effect.sync(() => {
            // A stale retirement wake can reuse this Runner after finishRun enters Idle but before
            // this cleanup runs. Do not remove the Runner when that wake made it busy again.
            if (data.runners.get(sessionID) !== next || next.busy) return false
            data.runners.delete(sessionID)
            const park = data.parks.get(sessionID)
            if (park?.phase === "retiring") data.parks.delete(sessionID)
            return true
          })
          if (removed) yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy || data.substitutions.get(sessionID)?.busy) yield* busyError(sessionID)
    })

    const assertActive = Effect.fn("SessionRunState.assertNotSuspended")((sessionID: SessionID) =>
      assertNotSuspended(db, sessionID),
    )

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const descendants = yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      yield* Effect.forEach(
        [sessionID, ...descendants],
        (id) => {
          const existing = data.runners.get(id)
          const substitution = data.substitutions.get(id)
          data.parks.delete(id)
          return Effect.all([existing?.cancel ?? Effect.void, substitution?.cancel ?? Effect.void], {
            discard: true,
          }).pipe(Effect.andThen(status.set(id, { type: "idle" })))
        },
        { concurrency: "unbounded", discard: true },
      )
    })

    const suspendWith = Effect.fn("SessionRunState.suspendWith")(function* (
      sessionID: SessionID,
      provenance?: SessionControl.PauseProvenance,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      const substitution = data.substitutions.get(sessionID)
      const signalled = (existing?.busy ?? false) || (substitution?.busy ?? false)
      // Invalidate the exact active or retiring park before Runner begins asynchronous fiber
      // interruption. A release wake can now only attach to or queue replacement work; it cannot
      // complete a stale park and consume a resume ticket without starting that replacement.
      data.parks.delete(sessionID)
      const signal = (target: Pick<Runner.Runner<never, never>, "suspend" | "suspendWith">) =>
        provenance === undefined ? target.suspend : target.suspendWith(provenance)
      if (!existing) {
        if (substitution) yield* signal(substitution)
        else yield* status.set(sessionID, { type: "idle" })
        return signalled
      }
      yield* signal(existing)
      if (substitution) yield* signal(substitution)
      return signalled
    })

    const suspend = Effect.fn("SessionRunState.suspend")((sessionID: SessionID) => suspendWith(sessionID))

    const registerPark = Effect.fn("SessionRunState.registerPark")(function* (
      sessionID: SessionID,
      signal: Deferred.Deferred<void>,
      continuation: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
    ) {
      const data = yield* InstanceState.get(state)
      let park!: Park
      const notify = () => {
        if (data.parks.get(sessionID) !== park) return false
        if (park.phase === "active") {
          Deferred.doneUnsafe(park.signal, Effect.void)
          return true
        }
        park.notified = true
        if (!park.retirement) return true
        if (Effect.runSync(park.retirement.signal)) return true
        if (data.parks.get(sessionID) === park) data.parks.delete(sessionID)
        return false
      }
      park = { phase: "active", signal, continuation, notified: false, notify }
      data.parks.set(sessionID, park)
      return {
        notify,
        unregister: Effect.sync(() => {
          // A successful handoff owns cleanup until Runner settlement. Ordinary interruption still
          // removes the active registration here, while cleanup from an older park cannot remove a
          // replacement registration.
          if (data.parks.get(sessionID) === park && park.phase === "active") data.parks.delete(sessionID)
        }),
      }
    })

    const handoffPark = Effect.fn("SessionRunState.handoffPark")(function* (
      sessionID: SessionID,
      signal: Deferred.Deferred<void>,
      replacement: Deferred.Deferred<void>,
    ) {
      const data = yield* InstanceState.get(state)
      const prepared = yield* Effect.sync(() => {
        const park = data.parks.get(sessionID)
        if (park?.phase !== "active" || park.signal !== signal) {
          return { kind: "done" as const, value: true }
        }
        if (Deferred.isDoneUnsafe(signal)) {
          // Keep the exact handle identity while rearming. A fallback callback that runs before the
          // barrier observes this return value will notify the replacement instead of the old signal.
          park.signal = replacement
          return { kind: "done" as const, value: false }
        }
        park.phase = "retiring"
        park.notified = false
        return { kind: "retire" as const, park, runner: data.runners.get(sessionID) }
      })
      if (prepared.kind === "done") return prepared.value

      // This is the only Running -> queued-continuation path. The Runner retirement is installed
      // while the current run is still executing handoffPark, so a later matching signal can only
      // start the continuation after that current run exits.
      const continuation = Effect.sync(() => {
        if (data.parks.get(sessionID) === prepared.park) data.parks.delete(sessionID)
      }).pipe(Effect.andThen(prepared.park.continuation))
      const retirement = prepared.runner ? yield* prepared.runner.retire(continuation) : undefined
      if (!retirement) {
        yield* Effect.sync(() => {
          if (data.parks.get(sessionID) === prepared.park) data.parks.delete(sessionID)
        })
        return true
      }
      const notified = yield* Effect.sync(() => {
        if (data.parks.get(sessionID) !== prepared.park) return false
        prepared.park.retirement = retirement
        return prepared.park.notified
      })
      if (notified) prepared.park.notify()
      return true
    })

    const signalPark = Effect.fn("SessionRunState.signalPark")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      while (true) {
        const park = data.parks.get(sessionID)
        if (!park) return false
        if (park.notify()) return true
        if (data.parks.get(sessionID) === park) return false

        // A new registration replaced the settled retirement while its signal was checked. Retry
        // against that exact registration instead of reporting a wake that it did not receive.
      }
    })

    const registerWakeTarget = Effect.fn("SessionRunState.registerWakeTarget")(function* (
      make: (sessionID: SessionID) => WakeTarget,
    ) {
      const registration = { make } satisfies WakeTargetRegistration
      wakeTarget = registration
      return Effect.sync(() => {
        if (wakeTarget === registration) wakeTarget = undefined
      })
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
      attached?: Latch.Latch,
    ) {
      yield* assertNotSuspended(db, sessionID)
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work, attached)
    })

    const wake = Effect.fn("SessionRunState.wake")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
    ) {
      yield* assertNotSuspended(db, sessionID)
      if (yield* signalPark(sessionID)) return false
      return yield* (yield* runner(sessionID, onInterrupt)).wake(work)
    })

    const wakeRegistered = Effect.fn("SessionRunState.wakeRegistered")(function* (sessionID: SessionID) {
      const target = wakeTarget?.make(sessionID)
      if (!target) return yield* signalPark(sessionID)
      const data = yield* InstanceState.get(state)
      if (!data.runners.has(sessionID) && !data.parks.has(sessionID)) {
        const owner = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (owner?.directory !== (yield* InstanceState.directory)) return false
      }
      return yield* wake(sessionID, target.onInterrupt, target.work).pipe(
        // A durable producer must not fail after commit when the target is paused. The existing
        // resume-intent path remains authoritative and will schedule the same registered work.
        Effect.catchTag("RunnerSuspended", () => Effect.succeed(false)),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      yield* assertNotSuspended(db, sessionID)
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const startSubstitution = Effect.fn("SessionRunState.startSubstitution")(function* (
      sessionID: SessionID,
      work: Effect.Effect<string[]>,
    ) {
      yield* assertNotSuspended(db, sessionID)
      const data = yield* InstanceState.get(state)
      if (data.runners.get(sessionID)?.busy) return yield* busyError(sessionID)
      let runner = data.substitutions.get(sessionID)
      if (!runner) {
        runner = Runner.make<string[]>(data.scope, {
          onBusy: status.set(sessionID, { type: "busy" }),
          onIdle: Effect.gen(function* () {
            data.substitutions.delete(sessionID)
            if (!data.runners.get(sessionID)?.busy) yield* status.set(sessionID, { type: "idle" })
          }),
        })
        data.substitutions.set(sessionID, runner)
      }
      return yield* runner.startShell(work).pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const isControlChanged = Schema.is(SessionEvent.ControlChanged)
    const unsubscribe = yield* events.listen((event) => {
      if (!isControlChanged(event)) return Effect.void
      return isSuspended(db, event.data.sessionID).pipe(
        Effect.flatMap((paused) => (paused ? suspend(event.data.sessionID) : Effect.void)),
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    // Direct pause -> interruption path. SessionControl.pause calls this immediately after the
    // durable barrier commits, so interruption never depends on an observer of ControlChanged.
    // Sessions with live work get a durable "running" resume intent so a later start wakes the
    // interrupted turn. Idle sessions that are still owed team mailbox work get a durable
    // "team-wake" intent so /unpause actually wakes them; the mailbox probe is non-destructive
    // and never claims the rows.
    const unregisterInterrupter = yield* control.registerInterrupter((sessionIDs, provenance) =>
      Effect.forEach(
        sessionIDs,
        (sessionID) =>
          suspendWith(sessionID, provenance).pipe(
            Effect.flatMap((hit) =>
              hit
                ? control.setResumeIntent({ sessionID, reason: "running" }).pipe(
                    // The interrupter must stay infallible so a best-effort intent write can never
                    // hide which sessions were signalled.
                    Effect.catchCause(() => Effect.succeed(0)),
                    Effect.as([sessionID]),
                  )
                : PendingMailbox.hasPendingMailboxMessages(db, sessionID).pipe(
                    Effect.flatMap((hasPending) =>
                      hasPending
                        ? control.setResumeIntent({ sessionID, reason: "team-wake" }).pipe(
                            // A best-effort intent write can never fail the pause path.
                            Effect.catchCause(() => Effect.succeed(0)),
                            // An idle session is not interruption-signalled; only its durable
                            // intent matters so a later release() includes it in resumeTickets.
                            Effect.as([]),
                          )
                        : Effect.succeed([]),
                    ),
                    // The interrupter must stay infallible so a failed mailbox probe can never
                    // hide which sessions were signalled.
                    Effect.catchCause(() => Effect.succeed([])),
                  ),
            ),
          ),
        {
          concurrency: 1,
        },
      ).pipe(Effect.map((matches) => matches.flat())),
    )
    yield* Effect.addFinalizer(() => unregisterInterrupter)

    return Service.of({
      assertNotBusy,
      assertNotSuspended: assertActive,
      cancel,
      suspend,
      registerPark,
      handoffPark,
      signalPark,
      registerWakeTarget,
      wakeRegistered,
      ensureRunning,
      wake,
      startShell,
      startSubstitution,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(SessionControl.defaultLayer),
)

export const isSuspended = (db: Database.Interface["db"], sessionID: SessionID) =>
  SessionControl.isPaused(db, sessionID)

export const assertNotSuspended = (db: Database.Interface["db"], sessionID: SessionID) =>
  isSuspended(db, sessionID).pipe(
    Effect.flatMap((paused) => (paused ? Effect.fail(new Runner.Suspended()) : Effect.void)),
  )

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const sessions = new Set<SessionID>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (job.id.startsWith("ses")) sessions.add(SessionID.make(job.id))
              if (typeof job.metadata?.sessionId === "string") {
                pending.add(job.metadata.sessionId)
                sessions.add(SessionID.make(job.metadata.sessionId))
              }
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
  return [...sessions]
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
