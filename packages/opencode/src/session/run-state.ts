import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context, Schema } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { Database } from "@oc2-ai/core/database/database"
import { SessionControl } from "@oc2-ai/core/session/control"
import { EventV2 } from "@oc2-ai/core/event"
import { SessionEvent } from "@oc2-ai/core/session/event"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly assertNotSuspended: (sessionID: SessionID) => Effect.Effect<void, Runner.Suspended>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** Signals pause-specific suspension. Resolves to true when live work was actually signalled. */
  readonly suspend: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
  ) => Effect.Effect<SessionV1.WithParts, Runner.Suspended>
  readonly wake: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
  ) => Effect.Effect<void, Runner.Suspended>
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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const control = yield* SessionControl.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts, Runner.Suspended>>()
        const substitutions = new Map<SessionID, Runner.Runner<string[]>>()
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
          }),
        )
        return { runners, substitutions, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts, Runner.Suspended>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
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
          return Effect.all([existing?.cancel ?? Effect.void, substitution?.cancel ?? Effect.void], {
            discard: true,
          }).pipe(Effect.andThen(status.set(id, { type: "idle" })))
        },
        { concurrency: "unbounded", discard: true },
      )
    })

    const suspend = Effect.fn("SessionRunState.suspend")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      const substitution = data.substitutions.get(sessionID)
      const signalled = (existing?.busy ?? false) || (substitution?.busy ?? false)
      if (!existing) {
        if (substitution) yield* substitution.suspend
        else yield* status.set(sessionID, { type: "idle" })
        return signalled
      }
      yield* existing.suspend
      if (substitution) yield* substitution.suspend
      return signalled
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
    ) {
      yield* assertNotSuspended(db, sessionID)
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const wake = Effect.fn("SessionRunState.wake")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts, Runner.Suspended>,
    ) {
      yield* assertNotSuspended(db, sessionID)
      yield* (yield* runner(sessionID, onInterrupt)).wake(work)
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
    // interrupted turn; idle sessions get none.
    const unregisterInterrupter = yield* control.registerInterrupter((sessionIDs) =>
      Effect.forEach(
        sessionIDs,
        (sessionID) =>
          suspend(sessionID).pipe(
            Effect.flatMap((hit) =>
              hit
                ? control.setResumeIntent({ sessionID, reason: "running" }).pipe(
                    // The interrupter must stay infallible so a best-effort intent write can never
                    // hide which sessions were signalled.
                    Effect.catchCause(() => Effect.succeed(0)),
                    Effect.as([sessionID]),
                  )
                : Effect.succeed([]),
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
