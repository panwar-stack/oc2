import { Cause, Deferred, Effect, Exit, Fiber, Latch, Option, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  /** Joins current work, or its queued continuation when retirement was already signalled.
   * The optional latch opens while the runner state is locked after this caller has attached. */
  readonly ensureRunning: (work: Effect.Effect<A, E>, attached?: Latch.Latch) => Effect.Effect<A, E | Suspended>
  /**
   * Schedules `work` for execution and reports whether a run that will execute it is now in
   * flight: `true` when a new run is started or queued, `false` when the wake attached to an
   * already running loop and the passed `work` was dropped (the in-flight run covers the work).
   */
  readonly wake: (work: Effect.Effect<A, E>) => Effect.Effect<boolean, Suspended>
  /**
   * Installs one conditional continuation on the current run. Signals coalesce, and a signalled
   * continuation starts only after the current work exits successfully. Failure, cancellation, or
   * suspension suppresses the continuation. Returns undefined when there is no current run to retire.
   */
  readonly retire: (work: Effect.Effect<A, E>) => Effect.Effect<Retirement | undefined>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy | Suspended>
  readonly cancel: Effect.Effect<void>
  readonly suspend: Effect.Effect<void>
  readonly suspendWith: (provenance: unknown) => Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Suspended extends Schema.TaggedErrorClass<Suspended>()("RunnerSuspended", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

export interface Retirement {
  /** Records one post-handoff signal. Duplicate signals match but schedule no additional work. */
  readonly signal: Effect.Effect<boolean>
}

const suspendedFibers = new Map<number, Option.Option<unknown>>()

/**
 * Keeps pause-specific suspension in the typed error channel and turns every other failure into a
 * defect. Suspension must never be erased into a defect, because callers treat defects as terminal.
 */
export const keepSuspended = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Suspended, R> =>
  effect.pipe(
    Effect.catch(
      (error): Effect.Effect<never, Suspended> => (error instanceof Suspended ? Effect.fail(error) : Effect.die(error)),
    ),
  )

export const isSuspending = Effect.fiberId.pipe(Effect.map((id) => suspendedFibers.has(id)))

/** Provenance attached to the suspension of the current target fiber, if one was supplied. */
export const currentSuspension = Effect.fiberId.pipe(
  Effect.map((id) => suspendedFibers.get(id) ?? Option.none<unknown>()),
)

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled | Suspended>
  start: Latch.Latch
  fiber: Fiber.Fiber<A, E>
  retirement?: RetirementHandle<A, E>
}

interface RetirementHandle<A, E> {
  work: Effect.Effect<A, E>
  done: Deferred.Deferred<A, E | Cancelled | Suspended>
  registration: Retirement
  signalled: boolean
  settled: boolean
  cancelled: boolean
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  suspended: Deferred.Deferred<never, Suspended>
  start: Latch.Latch
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled | Suspended>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }
  | { readonly _tag: "SuspendingRun"; readonly run: RunHandle<A, E> }
  | {
      readonly _tag: "SuspendingRunThenRun"
      readonly current: RunHandle<A, E>
      readonly run: PendingHandle<A, E>
      /** A later suspension that must block the queued handoff after the current run unwinds. */
      readonly suspension?: Option.Option<unknown>
    }
  | { readonly _tag: "SuspendedRun"; readonly run: PendingHandle<A, E>; readonly suspension: Option.Option<unknown> }
  | { readonly _tag: "SuspendingShell"; readonly shell: ShellHandle<A, E> }
  | {
      readonly _tag: "SuspendingShellThenRun"
      readonly shell: ShellHandle<A, E>
      readonly run: PendingHandle<A, E>
      /** A later suspension that must block the queued handoff after the shell unwinds. */
      readonly suspension?: Option.Option<unknown>
    }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled | Suspended>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled | Suspended>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const failRetirement = (run: RunHandle<A, E>, error: Cancelled | Suspended = new Cancelled()) => {
    const retirement = run.retirement
    if (!retirement || retirement.cancelled || retirement.settled) return Effect.void
    retirement.cancelled = true
    return Deferred.fail(retirement.done, error).pipe(Effect.asVoid)
  }

  const completeFailedRetirement = (run: RunHandle<A, E>, exit: Exit.Exit<A, E>) => {
    const retirement = run.retirement
    if (!retirement || retirement.cancelled || retirement.settled) return Effect.void
    retirement.cancelled = true
    return complete(retirement.done, exit)
  }

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  let startRun: (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled | Suspended>,
  ) => Effect.Effect<RunHandle<A, E>>

  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled | Suspended>,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Running" && st.run.id === id) {
          const retirement = st.run.retirement
          if (
            retirement &&
            Exit.isSuccess(exit) &&
            retirement.signalled &&
            !retirement.cancelled &&
            !retirement.settled
          ) {
            retirement.settled = true
            const run = yield* startRun(retirement.work, retirement.done)
            return [complete(done, exit).pipe(Effect.andThen(run.start.open)), { _tag: "Running", run }] as const
          }
          const cancel = retirement && Exit.isFailure(exit) ? completeFailedRetirement(st.run, exit) : Effect.void
          if (retirement) retirement.settled = true
          return [cancel.pipe(Effect.andThen(idle), Effect.andThen(complete(done, exit))), { _tag: "Idle" }] as const
        }
        if (st._tag === "SuspendingRun" && st.run.id === id) {
          return [idle.pipe(Effect.andThen(complete(done, exit))), { _tag: "Idle" }] as const
        }
        if (st._tag === "SuspendingRunThenRun" && st.current.id === id) {
          if (st.suspension !== undefined) {
            return [complete(done, exit), { _tag: "SuspendedRun", run: st.run, suspension: st.suspension }] as const
          }
          const run = yield* startRun(st.run.work, st.run.done)
          return [complete(done, exit).pipe(Effect.andThen(run.start.open)), { _tag: "Running", run }] as const
        }
        return [complete(done, exit), st] as const
      }),
    ).pipe(Effect.flatten)

  startRun = (work: Effect.Effect<A, E>, done: Deferred.Deferred<A, E | Cancelled | Suspended>) =>
    Effect.gen(function* () {
      const id = next()
      const start = yield* Latch.make()
      const fiber = yield* start.await.pipe(
        Effect.andThen(work),
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return { id, done, start, fiber } satisfies RunHandle<A, E>
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [run.start.open, { _tag: "Running", run }] as const
        }
        if (st._tag === "SuspendingShell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "SuspendingShellThenRun" && st.shell.id === id) {
          if (st.suspension !== undefined) {
            return [Effect.void, { _tag: "SuspendedRun", run: st.run, suspension: st.suspension }] as const
          }
          const run = yield* startRun(st.run.work, st.run.done)
          return [run.start.open, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>, attached?: Latch.Latch) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        const acknowledge = attached ? attached.open : Effect.void
        switch (st._tag) {
          case "Running": {
            const done = st.run.retirement?.signalled ? st.run.retirement.done : st.run.done
            yield* acknowledge
            return [awaitDone(done), st] as const
          }
          case "ShellThenRun": {
            yield* acknowledge
            return [awaitDone(st.run.done), st] as const
          }
          case "SuspendingRunThenRun": {
            yield* acknowledge
            return [
              awaitDone(st.run.done),
              st.suspension === undefined ? st : { _tag: "SuspendingRunThenRun", current: st.current, run: st.run },
            ] as const
          }
          case "SuspendingShellThenRun": {
            yield* acknowledge
            return [
              awaitDone(st.run.done),
              st.suspension === undefined ? st : { _tag: "SuspendingShellThenRun", shell: st.shell, run: st.run },
            ] as const
          }
          case "SuspendedRun": {
            const run = yield* startRun(st.run.work, st.run.done)
            yield* acknowledge
            return [run.start.open.pipe(Effect.andThen(awaitDone(run.done))), { _tag: "Running", run }] as const
          }
          case "SuspendingRun": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            yield* acknowledge
            return [awaitDone(run.done), { _tag: "SuspendingRunThenRun", current: st.run, run }] as const
          }
          case "SuspendingShell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            yield* acknowledge
            return [awaitDone(run.done), { _tag: "SuspendingShellThenRun", shell: st.shell, run }] as const
          }
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            yield* acknowledge
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled | Suspended>()
            const run = yield* startRun(work, done)
            yield* acknowledge
            return [run.start.open.pipe(Effect.andThen(awaitDone(done))), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const wake = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
            return [Effect.succeed(false), st] as const
          case "SuspendingRunThenRun":
            return [
              Effect.succeed(false),
              st.suspension === undefined ? st : { _tag: "SuspendingRunThenRun", current: st.current, run: st.run },
            ] as const
          case "SuspendingShellThenRun":
            return [
              Effect.succeed(false),
              st.suspension === undefined ? st : { _tag: "SuspendingShellThenRun", shell: st.shell, run: st.run },
            ] as const
          case "SuspendedRun": {
            const run = yield* startRun(st.run.work, st.run.done)
            return [run.start.open.pipe(Effect.as(false)), { _tag: "Running", run }] as const
          }
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            return [Effect.succeed(true), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "SuspendingRun": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            return [Effect.succeed(true), { _tag: "SuspendingRunThenRun", current: st.run, run }] as const
          }
          case "SuspendingShell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            return [Effect.succeed(true), { _tag: "SuspendingShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled | Suspended>()
            const run = yield* startRun(work, done)
            return [run.start.open.pipe(Effect.as(true)), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const retire = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Running") return [Effect.succeed<Retirement | undefined>(undefined), st] as const
        if (st.run.retirement) {
          return [Effect.succeed<Retirement | undefined>(st.run.retirement.registration), st] as const
        }
        const done = yield* Deferred.make<A, E | Cancelled | Suspended>()
        let retirement!: RetirementHandle<A, E>
        const registration: Retirement = {
          signal: Effect.sync(() => {
            if (retirement.cancelled || retirement.settled) return false
            retirement.signalled = true
            return true
          }),
        }
        retirement = {
          work,
          done,
          registration,
          signalled: false,
          settled: false,
          cancelled: false,
        }
        return [
          Effect.succeed<Retirement | undefined>(retirement.registration),
          { _tag: "Running", run: { ...st.run, retirement } },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy | Suspended> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy | Suspended> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const suspended = yield* Deferred.make<never, Suspended>()
        const start = yield* Latch.make()
        const fiber = yield* start.await.pipe(
          Effect.andThen(work),
          Effect.ensuring(finishShell(id)),
          Effect.forkIn(scope, { startImmediately: true }),
        )
        const shell = { id, cancelled, suspended, start, ready, fiber } satisfies ShellHandle<A, E>
        return [
          start.open.pipe(
            Effect.andThen(
              Effect.raceFirst(
                Effect.gen(function* () {
                  const exit = yield* Fiber.await(fiber)
                  if (Exit.isSuccess(exit)) return exit.value
                  if (
                    Cause.hasInterruptsOnly(exit.cause) ||
                    ((yield* Deferred.isDone(cancelled)) &&
                      Cause.hasInterrupts(exit.cause) &&
                      !Cause.hasDies(exit.cause))
                  ) {
                    if (onInterrupt) return yield* onInterrupt
                    return yield* Effect.die(new Cancelled())
                  }
                  return yield* Effect.failCause(exit.cause)
                }),
                Deferred.await(suspended),
              ),
            ),
          ),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancel = SynchronizedRef.modify(ref, (st) => {
    const cancelFiber = (fiber: Fiber.Fiber<A, E>) =>
      Effect.sync(() => suspendedFibers.delete(fiber.id)).pipe(Effect.andThen(Fiber.interrupt(fiber)))
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* failRetirement(st.run)
            yield* Fiber.interrupt(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "SuspendingRun":
        return [
          Effect.gen(function* () {
            yield* failRetirement(st.run)
            yield* cancelFiber(st.run.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "SuspendingRunThenRun":
        return [
          Effect.gen(function* () {
            yield* cancelFiber(st.current.fiber)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "SuspendedRun":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "SuspendingShell":
        return [
          Effect.gen(function* () {
            suspendedFibers.delete(st.shell.fiber.id)
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "SuspendingShellThenRun":
        return [
          Effect.gen(function* () {
            suspendedFibers.delete(st.shell.fiber.id)
            yield* stopShell(st.shell)
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  // Interruption is forked into the runner scope so suspend returns without waiting for unwinding,
  // while the interrupt observer stays inside the runtime instead of a detached root fiber.
  const latestSuspension = (
    current: Option.Option<unknown> | undefined,
    incoming: Option.Option<unknown>,
  ): Option.Option<unknown> =>
    // The observer path has no provenance. It must not erase provenance from the direct pause signal.
    current !== undefined && Option.isSome(current) && Option.isNone(incoming) ? current : incoming

  const recordSuspension = (fiber: Fiber.Fiber<A, E>, provenance: Option.Option<unknown>) =>
    Effect.sync(() => {
      const latest = latestSuspension(suspendedFibers.get(fiber.id), provenance)
      suspendedFibers.set(fiber.id, latest)
      return latest
    })

  const interruptFork = (fiber: Fiber.Fiber<A, E>) =>
    Fiber.interrupt(fiber).pipe(
      Effect.ensuring(Effect.sync(() => suspendedFibers.delete(fiber.id))),
      Effect.forkIn(scope),
      Effect.asVoid,
    )

  const suspendWithOption = (provenance: Option.Option<unknown>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Idle":
            return [Effect.void, st] as const
          case "Running": {
            const suspended = new Suspended()
            yield* failRetirement(st.run, suspended)
            yield* recordSuspension(st.run.fiber, provenance)
            return [
              Deferred.fail(st.run.done, suspended).pipe(Effect.asVoid, Effect.andThen(interruptFork(st.run.fiber))),
              { _tag: "SuspendingRun", run: st.run } as const,
            ] as const
          }
          case "Shell":
            yield* recordSuspension(st.shell.fiber, provenance)
            return [
              Deferred.fail(st.shell.suspended, new Suspended()).pipe(
                Effect.asVoid,
                Effect.andThen(interruptFork(st.shell.fiber)),
              ),
              { _tag: "SuspendingShell", shell: st.shell } as const,
            ] as const
          case "ShellThenRun":
            yield* recordSuspension(st.shell.fiber, provenance)
            return [
              Effect.gen(function* () {
                yield* Deferred.fail(st.run.done, new Suspended()).pipe(Effect.asVoid)
                yield* Deferred.fail(st.shell.suspended, new Suspended()).pipe(Effect.asVoid)
                yield* interruptFork(st.shell.fiber)
              }),
              { _tag: "SuspendingShell", shell: st.shell } as const,
            ] as const
          case "SuspendingRun":
            yield* recordSuspension(st.run.fiber, provenance)
            return [Effect.void, st] as const
          case "SuspendingRunThenRun": {
            const suspension = yield* recordSuspension(st.current.fiber, provenance)
            return [Effect.void, { ...st, suspension }] as const
          }
          case "SuspendingShell":
            yield* recordSuspension(st.shell.fiber, provenance)
            return [Effect.void, st] as const
          case "SuspendingShellThenRun": {
            const suspension = yield* recordSuspension(st.shell.fiber, provenance)
            return [Effect.void, { ...st, suspension }] as const
          }
          case "SuspendedRun":
            return [Effect.void, { ...st, suspension: latestSuspension(st.suspension, provenance) }] as const
        }
      }),
    ).pipe(Effect.flatten)

  const suspend = suspendWithOption(Option.none())
  const suspendWith = (provenance: unknown) => suspendWithOption(Option.some(provenance))

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    wake,
    retire,
    startShell,
    cancel,
    suspend,
    suspendWith,
  }
}

export * as Runner from "./runner"
