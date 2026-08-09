import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Option, Ref, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { it } from "../lib/effect"

const waitForState = <A, E>(runner: Runner.Runner<A, E>, tag: Runner.State<A, E>["_tag"]) =>
  Effect.gen(function* () {
    while (runner.state._tag !== tag) yield* Effect.yieldNow
  }).pipe(Effect.timeout("1 second"))

describe("Runner", () => {
  // --- ensureRunning semantics ---

  it.live(
    "ensureRunning starts work and returns result",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.ensureRunning(Effect.succeed("hello"))
      expect(result).toBe("hello")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "ensureRunning propagates work failures",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const exit = yield* runner.ensureRunning(Effect.fail("boom")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "concurrent callers share the same run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Effect.sleep("10 millis")
        return "shared"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(work)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("shared")
      expect(b).toBe("shared")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "concurrent callers all receive same error",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const work = Effect.gen(function* () {
        yield* Effect.sleep("10 millis")
        return yield* Effect.fail("boom")
      })

      const [a, b] = yield* Effect.all(
        [runner.ensureRunning(work).pipe(Effect.exit), runner.ensureRunning(work).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      )

      expect(Exit.isFailure(a)).toBe(true)
      expect(Exit.isFailure(b)).toBe(true)
    }),
  )

  it.live(
    "ensureRunning can be called again after previous run completes",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      expect(yield* runner.ensureRunning(Effect.succeed("first"))).toBe("first")
      expect(yield* runner.ensureRunning(Effect.succeed("second"))).toBe("second")
    }),
  )

  it.live(
    "second ensureRunning ignores new work if already running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const ran = yield* Ref.make<string[]>([])

      const first = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "first"])
        yield* Effect.sleep("50 millis")
        return "first-result"
      })
      const second = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "second"])
        return "second-result"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(first), runner.ensureRunning(second)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("first-result")
      expect(b).toBe("first-result")
      expect(yield* Ref.get(ran)).toEqual(["first"])
    }),
  )

  it.live(
    "a signalled retirement starts one continuation only after the current run exits",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const currentStarted = yield* Deferred.make<void>()
      const releaseCurrent = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const releaseContinuation = yield* Deferred.make<void>()
      const continuationFinished = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const current = yield* runner
        .ensureRunning(
          Deferred.succeed(currentStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCurrent)),
            Effect.as("current"),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(currentStarted)

      const retirement = yield* runner.retire(
        Effect.gen(function* () {
          yield* Ref.update(calls, (count) => count + 1)
          yield* Deferred.succeed(continuationStarted, undefined)
          yield* Deferred.await(releaseContinuation)
          yield* Deferred.succeed(continuationFinished, undefined)
          return "continuation"
        }),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)
      expect(yield* retirement.signal).toBe(true)
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)

      yield* Deferred.succeed(releaseCurrent, undefined)
      expect(yield* Fiber.join(current)).toBe("current")
      yield* Deferred.await(continuationStarted)
      expect(yield* Ref.get(calls)).toBe(1)
      yield* Deferred.succeed(releaseContinuation, undefined)
      yield* Deferred.await(continuationFinished)
      yield* waitForState(runner, "Idle")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "ensureRunning returns the signalled retirement continuation result",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const currentStarted = yield* Deferred.make<void>()
      const releaseCurrent = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const releaseContinuation = yield* Deferred.make<void>()
      const unexpectedWorkStarted = yield* Deferred.make<void>()
      const attachedCompleted = yield* Deferred.make<string>()
      const attachment = yield* Latch.make()
      const current = yield* runner
        .ensureRunning(
          Deferred.succeed(currentStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCurrent)),
            Effect.as("current"),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(currentStarted)

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseContinuation)),
          Effect.as("continuation"),
        ),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)

      const attached = yield* runner
        .ensureRunning(
          Deferred.succeed(unexpectedWorkStarted, undefined).pipe(Effect.as("unexpected replacement work")),
          attachment,
        )
        .pipe(Effect.tap((result) => Deferred.succeed(attachedCompleted, result)))
        .pipe(Effect.forkChild)
      yield* attachment.await
      yield* Deferred.succeed(releaseCurrent, undefined)
      yield* Deferred.await(continuationStarted)

      expect(yield* Deferred.isDone(attachedCompleted)).toBe(false)
      expect(yield* Deferred.isDone(unexpectedWorkStarted)).toBe(false)
      expect(yield* Fiber.join(current)).toBe("current")

      yield* Deferred.succeed(releaseContinuation, undefined)
      expect(yield* Fiber.join(attached)).toBe("continuation")
      yield* waitForState(runner, "Idle")
    }),
  )

  it.live(
    "cancelling the current run suppresses its signalled retirement",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const currentStarted = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const current = yield* runner
        .ensureRunning(
          Deferred.succeed(currentStarted, undefined).pipe(Effect.andThen(Effect.never), Effect.as("current")),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(currentStarted)

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(Effect.as("continuation")),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)

      yield* runner.cancel
      yield* Fiber.await(current)
      expect(runner.state._tag).toBe("Idle")
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)
      expect(yield* retirement.signal).toBe(false)
    }),
  )

  it.live(
    "a retirement signal after settlement does not swallow a wake before idle cleanup",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const releaseCurrent = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const runner = Runner.make<string>(s, {
        onIdle: Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup))),
      })
      const current = yield* runner
        .ensureRunning(Deferred.await(releaseCurrent).pipe(Effect.as("current")))
        .pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(Effect.as("continuation")),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return

      yield* Deferred.succeed(releaseCurrent, undefined)
      yield* Deferred.await(cleanupStarted)
      expect(runner.state._tag).toBe("Idle")
      expect(yield* retirement.signal).toBe(false)
      expect(yield* runner.wake(Deferred.succeed(replacementStarted, undefined).pipe(Effect.as("replacement")))).toBe(
        true,
      )
      yield* Deferred.await(replacementStarted)
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)

      yield* Deferred.succeed(releaseCleanup, undefined)
      expect(yield* Fiber.join(current)).toBe("current")
      yield* waitForState(runner, "Idle")
    }),
  )

  it.live(
    "a typed failure suppresses a signalled retirement",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const releaseCurrent = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const unexpectedWorkStarted = yield* Deferred.make<void>()
      const attachment = yield* Latch.make()
      const runner = Runner.make<string, string>(s)
      const current = yield* runner
        .ensureRunning(Deferred.await(releaseCurrent).pipe(Effect.andThen(Effect.fail("boom"))))
        .pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(Effect.as("continuation")),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)
      const attached = yield* runner
        .ensureRunning(
          Deferred.succeed(unexpectedWorkStarted, undefined).pipe(Effect.as("unexpected replacement work")),
          attachment,
        )
        .pipe(Effect.flip, Effect.forkChild)
      yield* attachment.await

      yield* Deferred.succeed(releaseCurrent, undefined)
      expect(Exit.isFailure(yield* Fiber.await(current))).toBe(true)
      expect(yield* Fiber.join(attached)).toBe("boom")
      yield* waitForState(runner, "Idle")
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)
      expect(yield* Deferred.isDone(unexpectedWorkStarted)).toBe(false)
      expect(yield* retirement.signal).toBe(false)
    }),
  )

  it.live(
    "a defect suppresses a signalled retirement",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const releaseCurrent = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const runner = Runner.make<string>(s)
      const current = yield* runner
        .ensureRunning(Deferred.await(releaseCurrent).pipe(Effect.andThen(Effect.die("boom"))))
        .pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(Effect.as("continuation")),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)

      yield* Deferred.succeed(releaseCurrent, undefined)
      expect(Exit.isFailure(yield* Fiber.await(current))).toBe(true)
      yield* waitForState(runner, "Idle")
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)
      expect(yield* retirement.signal).toBe(false)
    }),
  )

  it.live(
    "an interrupted exit suppresses a signalled retirement",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const releaseCurrent = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const runner = Runner.make<string>(s)
      const current = yield* runner
        .ensureRunning(Deferred.await(releaseCurrent).pipe(Effect.andThen(Effect.interrupt)))
        .pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(Effect.as("continuation")),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)

      yield* Deferred.succeed(releaseCurrent, undefined)
      expect(Exit.isFailure(yield* Fiber.await(current))).toBe(true)
      yield* waitForState(runner, "Idle")
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)
      expect(yield* retirement.signal).toBe(false)
    }),
  )

  it.live(
    "suspension reaches callers attached to a signalled retirement",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const currentStarted = yield* Deferred.make<void>()
      const continuationStarted = yield* Deferred.make<void>()
      const unexpectedWorkStarted = yield* Deferred.make<void>()
      const attachment = yield* Latch.make()
      const runner = Runner.make<string>(s)
      const current = yield* runner
        .ensureRunning(
          Deferred.succeed(currentStarted, undefined).pipe(Effect.andThen(Effect.never), Effect.as("current")),
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(currentStarted)

      const retirement = yield* runner.retire(
        Deferred.succeed(continuationStarted, undefined).pipe(Effect.as("continuation")),
      )
      expect(retirement).toBeDefined()
      if (!retirement) return
      expect(yield* retirement.signal).toBe(true)
      const attached = yield* runner
        .ensureRunning(
          Deferred.succeed(unexpectedWorkStarted, undefined).pipe(Effect.as("unexpected replacement work")),
          attachment,
        )
        .pipe(Effect.exit, Effect.forkChild)
      yield* attachment.await

      yield* runner.suspend
      const [currentExit, attachedExit] = yield* Effect.all([Fiber.join(current), Fiber.join(attached)])
      expect(Exit.isFailure(currentExit)).toBe(true)
      expect(Exit.isFailure(attachedExit)).toBe(true)
      if (Exit.isFailure(currentExit)) expect(Cause.squash(currentExit.cause)).toBeInstanceOf(Runner.Suspended)
      if (Exit.isFailure(attachedExit)) expect(Cause.squash(attachedExit.cause)).toBeInstanceOf(Runner.Suspended)
      expect(yield* Deferred.isDone(continuationStarted)).toBe(false)
      expect(yield* Deferred.isDone(unexpectedWorkStarted)).toBe(false)
      expect(yield* retirement.signal).toBe(false)
      yield* waitForState(runner, "Idle")
    }),
  )

  // --- cancel semantics ---

  it.live(
    "cancel interrupts running work",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, void 0)
            return yield* Effect.never.pipe(Effect.as("never"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(runner.busy).toBe(true)
      expect(runner.state._tag).toBe("Running")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live(
    "cancel on idle is a no-op",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      yield* runner.cancel
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "cancel with onInterrupt resolves callers gracefully",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("never"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")

      yield* runner.cancel

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("fallback")
    }),
  )

  it.live(
    "cancel with queued callers resolves all",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })

      const a = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      const b = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* runner.cancel

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA)) expect(exitA.value).toBe("fallback")
      if (Exit.isSuccess(exitB)) expect(exitB.value).toBe("fallback")
    }),
  )

  it.live(
    "work can be started after cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      yield* runner.cancel
      yield* Fiber.await(fiber)

      const result = yield* runner.ensureRunning(Effect.succeed("after-cancel"))
      expect(result).toBe("after-cancel")
    }),
  )

  it.live(
    "suspend signals callers without waiting for interruption finalizers",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const workStarted = yield* Deferred.make<void>()
      const finalizerStarted = yield* Deferred.make<void>()
      const releaseFinalizer = yield* Deferred.make<void>()
      const interruptedFallbacks = yield* Ref.make(0)
      yield* Effect.gen(function* () {
        const runner = Runner.make<string>(s, {
          onInterrupt: Ref.updateAndGet(interruptedFallbacks, (count) => count + 1).pipe(Effect.as("cancelled")),
        })
        const work = Deferred.succeed(workStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(finalizerStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFinalizer))),
          ),
          Effect.as("never"),
        )
        const caller = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
        yield* Deferred.await(workStarted)

        yield* runner.suspend.pipe(Effect.timeout("100 millis"))

        const exit = yield* Fiber.await(caller).pipe(Effect.timeout("100 millis"))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
        expect(yield* Ref.get(interruptedFallbacks)).toBe(0)
        expect(runner.state._tag).toBe("SuspendingRun")
        expect(runner.busy).toBe(true)

        const replacementStarted = yield* Deferred.make<void>()
        const replacement = yield* runner
          .ensureRunning(Deferred.succeed(replacementStarted, undefined).pipe(Effect.as("replacement")))
          .pipe(Effect.forkChild)
        yield* waitForState(runner, "SuspendingRunThenRun")
        expect(yield* Deferred.isDone(replacementStarted)).toBe(false)

        yield* Deferred.await(finalizerStarted).pipe(Effect.timeout("100 millis"))
        yield* Deferred.succeed(releaseFinalizer, undefined)
        expect(yield* Fiber.join(replacement).pipe(Effect.timeout("100 millis"))).toBe("replacement")
        expect(runner.busy).toBe(false)
      }).pipe(Effect.ensuring(Deferred.succeed(releaseFinalizer, undefined).pipe(Effect.ignore)))
    }),
  )

  it.live(
    "suspendWith keeps exact provenance until the target fiber finishes unwinding",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const started = yield* Deferred.make<void>()
      const observed = yield* Deferred.make<Option.Option<unknown>>()
      const release = yield* Deferred.make<void>()
      const provenance = { source: "pause", generation: 7 }
      const runner = Runner.make<string>(s)
      const caller = yield* runner
        .ensureRunning(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Runner.currentSuspension.pipe(
                Effect.tap((current) => Deferred.succeed(observed, current)),
                Effect.andThen(Deferred.await(release)),
              ),
            ),
            Effect.as("never"),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      yield* runner.suspendWith(provenance)

      const current = yield* Deferred.await(observed).pipe(Effect.timeout("100 millis"))
      expect(Option.isSome(current)).toBe(true)
      if (Option.isSome(current)) expect(current.value).toBe(provenance)
      expect(runner.state._tag).toBe("SuspendingRun")

      yield* Deferred.succeed(release, undefined)
      yield* waitForState(runner, "Idle")
      expect(Option.isNone(yield* Runner.currentSuspension)).toBe(true)
      const exit = yield* Fiber.await(caller)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
    }),
  )

  it.live(
    "a newer suspension blocks queued work after the interrupted run unwinds",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const started = yield* Deferred.make<void>()
      const finalizerStarted = yield* Deferred.make<void>()
      const inspectSuspension = yield* Deferred.make<void>()
      const observed = yield* Deferred.make<Option.Option<unknown>>()
      const releaseFinalizer = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()
      const releaseReplacement = yield* Deferred.make<void>()
      const pauseA = { source: "pause-a", generation: 1 }
      const pauseB = { source: "pause-b", generation: 2 }

      yield* Effect.gen(function* () {
        const runner = Runner.make<string>(s)
        const caller = yield* runner
          .ensureRunning(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Deferred.succeed(finalizerStarted, undefined)
                  yield* Deferred.await(inspectSuspension)
                  yield* Runner.currentSuspension.pipe(Effect.tap((current) => Deferred.succeed(observed, current)))
                  yield* Deferred.await(releaseFinalizer)
                }),
              ),
              Effect.as("never"),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)

        yield* runner.suspendWith(pauseA)
        yield* Deferred.await(finalizerStarted)
        const callerExit = yield* Fiber.await(caller)
        expect(Exit.isFailure(callerExit)).toBe(true)
        if (Exit.isFailure(callerExit)) expect(Cause.squash(callerExit.cause)).toBeInstanceOf(Runner.Suspended)

        expect(
          yield* runner.wake(
            Deferred.succeed(replacementStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReplacement)),
              Effect.as("replacement"),
            ),
          ),
        ).toBe(true)
        expect(runner.state._tag).toBe("SuspendingRunThenRun")

        yield* runner.suspendWith(pauseB)
        // The observer event for the same durable pause has no provenance and must not erase pause B.
        yield* runner.suspend
        yield* Deferred.succeed(inspectSuspension, undefined)
        const current = yield* Deferred.await(observed)
        expect(Option.isSome(current)).toBe(true)
        if (Option.isSome(current)) expect(current.value).toBe(pauseB)

        yield* Deferred.succeed(releaseFinalizer, undefined)
        yield* waitForState(runner, "SuspendedRun")
        expect(yield* Deferred.isDone(replacementStarted)).toBe(false)

        // A wake admitted after pause B is released resumes the already queued run and drops its new work.
        expect(yield* runner.wake(Effect.die("replacement work must not be replaced"))).toBe(false)
        yield* Deferred.await(replacementStarted)
        expect(runner.state._tag).toBe("Running")

        yield* Deferred.succeed(releaseReplacement, undefined)
        yield* waitForState(runner, "Idle")
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Deferred.succeed(inspectSuspension, undefined),
              Deferred.succeed(releaseFinalizer, undefined),
              Deferred.succeed(releaseReplacement, undefined),
            ],
            { discard: true },
          ).pipe(Effect.ignore),
        ),
      )
    }),
  )

  it.live(
    "cancel does not deadlock when replacement work starts before interrupted run exits",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const hit = yield* Deferred.make<void>()
      const hold = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const runner = Runner.make<string>(s)
        const first = Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(hit, undefined)),
          Effect.ensuring(Deferred.await(hold)),
          Effect.as("first"),
        )

        const a = yield* runner.ensureRunning(first).pipe(Effect.exit, Effect.forkChild)
        yield* waitForState(runner, "Running")

        const stop = yield* runner.cancel.pipe(Effect.forkChild)
        yield* Deferred.await(hit).pipe(Effect.timeout("250 millis"))

        const b = yield* runner.ensureRunning(Deferred.await(done).pipe(Effect.as("second"))).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(runner.busy).toBe(true)

        yield* Deferred.succeed(hold, undefined)
        const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
        expect(Exit.isSuccess(stopExit)).toBe(true)

        expect(runner.busy).toBe(true)
        yield* Deferred.succeed(done, undefined)
        expect(yield* Fiber.join(b).pipe(Effect.timeout("250 millis"))).toBe("second")
        expect(runner.busy).toBe(false)

        const exit = yield* Fiber.join(a)
        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(
        Effect.ensuring(
          Effect.all([Deferred.succeed(hold, undefined), Deferred.succeed(done, undefined)], { discard: true }).pipe(
            Effect.ignore,
          ),
        ),
      )
    }),
  )

  // --- shell semantics ---

  it.live(
    "shell runs exclusively",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.startShell(Effect.succeed("shell-done"))
      expect(result).toBe("shell-done")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "shell rejects when run is active",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const started = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never.pipe(Effect.as("x"))
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started).pipe(Effect.timeout("250 millis"))
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Running") yield* Effect.yieldNow
      }).pipe(Effect.timeout("250 millis"))

      const exit = yield* runner.startShell(Effect.succeed("nope")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      yield* runner.cancel
      yield* Fiber.await(fiber).pipe(Effect.timeout("250 millis"))
    }),
  )

  it.live(
    "shell rejects when another shell is running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("first"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const exit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Busy)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
    }),
  )

  it.live(
    "cancel interrupts shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ignored"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const stop = yield* runner.cancel.pipe(Effect.forkChild)
      const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
      expect(Exit.isSuccess(stopExit)).toBe(true)
      expect(runner.busy).toBe(false)

      const shellExit = yield* Fiber.await(sh)
      expect(Exit.isFailure(shellExit)).toBe(true)

      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "suspend signals a shell distinctly from cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const interruptedFallbacks = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onInterrupt: Ref.updateAndGet(interruptedFallbacks, (count) => count + 1).pipe(Effect.as("cancelled")),
      })
      const shell = yield* runner.startShell(Effect.never.pipe(Effect.as("never"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      yield* runner.suspend.pipe(Effect.timeout("100 millis"))

      const exit = yield* Fiber.await(shell).pipe(Effect.timeout("100 millis"))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
      expect(yield* Ref.get(interruptedFallbacks)).toBe(0)
      yield* waitForState(runner, "Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "explicit cancel takes terminal ownership from an in-flight suspension",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const started = yield* Deferred.make<void>()
      const finalizerStarted = yield* Deferred.make<void>()
      const inspectFinalizer = yield* Deferred.make<void>()
      const observedSuspending = yield* Deferred.make<boolean>()
      const runner = Runner.make<string>(s)
      const caller = yield* runner
        .ensureRunning(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Deferred.succeed(finalizerStarted, undefined)
                yield* Deferred.await(inspectFinalizer)
                yield* Deferred.succeed(observedSuspending, yield* Runner.isSuspending)
              }),
            ),
            Effect.as("never"),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* runner.suspend
      yield* Deferred.await(finalizerStarted)
      const cancel = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(inspectFinalizer, undefined)

      expect(yield* Deferred.await(observedSuspending)).toBe(false)
      yield* Fiber.join(cancel)
      expect(Exit.isFailure(yield* Fiber.await(caller))).toBe(true)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "cancel does not mask shell defects",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("interrupted") })
      const ready = yield* Latch.make()

      const sh = yield* runner
        .startShell(
          Effect.gen(function* () {
            yield* ready.open
            return yield* Effect.never.pipe(Effect.as("ignored"))
          }).pipe(Effect.ensuring(Effect.die("boom"))),
          ready,
        )
        .pipe(Effect.forkChild)
      yield* ready.await.pipe(Effect.timeout("250 millis"))

      yield* runner.cancel
      expect(Exit.isFailure(yield* Fiber.await(sh))).toBe(true)
    }),
  )

  // --- shell→run handoff ---

  it.live(
    "ensureRunning queues behind shell then runs after",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell-result"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")
      expect(runner.state._tag).toBe("Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("run-result")).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("run-result")
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "multiple ensureRunning callers share the queued run behind shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        return "run"
      })
      const a = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      const b = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "cancel during shell_then_run cancels both",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const sh = yield* runner.startShell(Effect.never.pipe(Effect.as("aborted"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* waitForState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  // --- lifecycle callbacks ---

  it.live(
    "onIdle fires when returning to idle from running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      yield* runner.ensureRunning(Effect.succeed("ok"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  it.live(
    "onIdle fires on cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      const fiber = yield* runner.ensureRunning(Effect.never.pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      yield* runner.cancel
      yield* Fiber.await(fiber)
      expect(yield* Ref.get(count)).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live(
    "onBusy fires when shell starts",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onBusy: Ref.update(count, (n) => n + 1),
      })
      yield* runner.startShell(Effect.succeed("done"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  // --- busy flag ---

  it.live(
    "busy is true during run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.ensureRunning(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Running")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "busy is true during shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForState(runner, "Shell")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )
})
