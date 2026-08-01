import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E | Suspended>
  /**
   * Schedules `work` for execution and reports whether a run that will execute it is now in
   * flight: `true` when a new run is started or queued, `false` when the wake attached to an
   * already running loop and the passed `work` was dropped (the in-flight run covers the work).
   */
  readonly wake: (work: Effect.Effect<A, E>) => Effect.Effect<boolean, Suspended>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy | Suspended>
  readonly cancel: Effect.Effect<void>
  readonly suspend: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Suspended extends Schema.TaggedErrorClass<Suspended>()("RunnerSuspended", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

const suspendedFibers = new Set<number>()

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

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled | Suspended>
  start: Latch.Latch
  fiber: Fiber.Fiber<A, E>
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
  | { readonly _tag: "SuspendingRunThenRun"; readonly current: RunHandle<A, E>; readonly run: PendingHandle<A, E> }
  | { readonly _tag: "SuspendingShell"; readonly shell: ShellHandle<A, E> }
  | {
      readonly _tag: "SuspendingShellThenRun"
      readonly shell: ShellHandle<A, E>
      readonly run: PendingHandle<A, E>
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
          return [idle.pipe(Effect.andThen(complete(done, exit))), { _tag: "Idle" }] as const
        }
        if (st._tag === "SuspendingRun" && st.run.id === id) {
          return [idle.pipe(Effect.andThen(complete(done, exit))), { _tag: "Idle" }] as const
        }
        if (st._tag === "SuspendingRunThenRun" && st.current.id === id) {
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

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "SuspendingRunThenRun":
          case "SuspendingShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "SuspendingRun": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "SuspendingRunThenRun", current: st.run, run }] as const
          }
          case "SuspendingShell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "SuspendingShellThenRun", shell: st.shell, run }] as const
          }
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled | Suspended>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled | Suspended>()
            const run = yield* startRun(work, done)
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
          case "SuspendingRunThenRun":
          case "SuspendingShellThenRun":
            return [Effect.succeed(false), st] as const
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
  const interruptFork = (fiber: Fiber.Fiber<A, E>) =>
    Effect.sync(() => suspendedFibers.add(fiber.id)).pipe(
      Effect.andThen(
        Fiber.interrupt(fiber).pipe(
          Effect.ensuring(Effect.sync(() => suspendedFibers.delete(fiber.id))),
          Effect.forkIn(scope),
        ),
      ),
      Effect.asVoid,
    )

  const suspend = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.run.done, new Suspended()).pipe(Effect.asVoid)
            yield* interruptFork(st.run.fiber)
          }),
          { _tag: "SuspendingRun", run: st.run } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.shell.suspended, new Suspended()).pipe(Effect.asVoid)
            yield* interruptFork(st.shell.fiber)
          }),
          { _tag: "SuspendingShell", shell: st.shell } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.run.done, new Suspended()).pipe(Effect.asVoid)
            yield* Deferred.fail(st.shell.suspended, new Suspended()).pipe(Effect.asVoid)
            yield* interruptFork(st.shell.fiber)
          }),
          { _tag: "SuspendingShell", shell: st.shell } as const,
        ] as const
      case "SuspendingRun":
      case "SuspendingRunThenRun":
      case "SuspendingShell":
      case "SuspendingShellThenRun":
        return [Effect.void, st] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    wake,
    startShell,
    cancel,
    suspend,
  }
}

export * as Runner from "./runner"
