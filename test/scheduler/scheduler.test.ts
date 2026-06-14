import { expect, test } from "bun:test"
import { createRuntimeEventBus } from "../../src/events/event-bus"
import { RuntimeError, type RuntimeEvent } from "../../src/events/events"
import { createTaskScheduler } from "../../src/scheduler/scheduler"
import type { SchedulerTaskKind } from "../../src/scheduler/task"

const createScheduler = (limits: Partial<Record<SchedulerTaskKind, number>> = {}, defaultTimeoutMs = 1_000) =>
  createTaskScheduler({
    defaultTimeoutMs,
    limits: {
      model: limits.model ?? 1,
      tool: limits.tool ?? 1,
      mcp: limits.mcp ?? 1,
      subagent: limits.subagent ?? 1,
      "team-member": limits["team-member"] ?? 1,
    },
  })

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

test("scheduler enforces per-kind concurrency limits", async () => {
  const scheduler = createScheduler({ tool: 2 })
  let running = 0
  let maxRunning = 0

  const tasks = Array.from(
    { length: 5 },
    () =>
      scheduler.schedule({
        kind: "tool",
        run: async () => {
          running += 1
          maxRunning = Math.max(maxRunning, running)
          await wait(5)
          running -= 1
        },
      }).result,
  )

  await Promise.all(tasks)

  expect(maxRunning).toBe(2)
})

test("scheduler starts higher priority queued tasks first", async () => {
  const scheduler = createScheduler({ model: 1 })
  const started: string[] = []
  let releaseFirst!: () => void
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const first = scheduler.schedule({
    id: "first",
    kind: "model",
    priority: "low",
    run: async () => {
      started.push("first")
      await firstCanFinish
    },
  })
  const low = scheduler.schedule({
    id: "low",
    kind: "model",
    priority: "low",
    run: () => started.push("low"),
  })
  const high = scheduler.schedule({
    id: "high",
    kind: "model",
    priority: "high",
    run: () => started.push("high"),
  })

  await wait(1)
  releaseFirst()
  await Promise.all([first.result, low.result, high.result])

  expect(started).toEqual(["first", "high", "low"])
})

test("scheduler returns structured RuntimeError on timeout", async () => {
  const scheduler = createScheduler({ mcp: 1 }, 5)
  const handle = scheduler.schedule({
    id: "slow",
    kind: "mcp",
    run: async ({ signal }) => {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    },
  })

  const result = await handle.result

  expect(result.error).toBeInstanceOf(RuntimeError)
  expect(result.error?.code).toBe("timed_out")
  expect(result.task.status).toBe("timed_out")
})

test("scheduler timeout wins when a task ignores abort", async () => {
  const scheduler = createScheduler({ mcp: 1 }, 5)
  const handle = scheduler.schedule({
    id: "ignores-abort",
    kind: "mcp",
    run: async () => {
      await wait(20)
      return "too late"
    },
  })

  const result = await handle.result

  expect(result.value).toBeUndefined()
  expect(result.error?.code).toBe("timed_out")
  expect(result.task.status).toBe("timed_out")
})

test("scheduler propagates parent cancellation to queued and running tasks", async () => {
  const scheduler = createScheduler({ subagent: 1 })
  const parent = new AbortController()
  let releaseRunning!: () => void
  const runningCanFinish = new Promise<void>((resolve) => {
    releaseRunning = resolve
  })

  const running = scheduler.schedule({
    id: "running",
    kind: "subagent",
    parent: parent.signal,
    run: async ({ signal }) => {
      await Promise.race([
        runningCanFinish,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ])
    },
  })
  const queued = scheduler.schedule({
    id: "queued",
    kind: "subagent",
    parent: parent.signal,
    run: () => undefined,
  })

  await wait(1)
  parent.abort()
  releaseRunning()

  const [runningResult, queuedResult] = await Promise.all([running.result, queued.result])

  expect(runningResult.task.status).toBe("cancelled")
  expect(queuedResult.task.status).toBe("cancelled")
})

test("scheduler does not run tasks scheduled with an already aborted parent", async () => {
  const scheduler = createScheduler({ tool: 1 })
  const parent = new AbortController()
  let ran = false

  parent.abort()
  const handle = scheduler.schedule({
    id: "pre-cancelled",
    kind: "tool",
    parent: parent.signal,
    run: () => {
      ran = true
    },
  })

  const result = await handle.result

  expect(ran).toBe(false)
  expect(result.task.status).toBe("cancelled")
  expect(result.error?.code).toBe("cancelled")
})

test("scheduler bounds queue capacity per kind", async () => {
  const scheduler = createTaskScheduler({
    defaultTimeoutMs: 1_000,
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
    queueLimits: { tool: 1 },
  })
  let releaseRunning!: () => void
  const runningCanFinish = new Promise<void>((resolve) => {
    releaseRunning = resolve
  })

  const running = scheduler.schedule({ kind: "tool", run: () => runningCanFinish })
  const queued = scheduler.schedule({ kind: "tool", run: () => undefined })
  const rejected = scheduler.schedule({ kind: "tool", run: () => undefined })

  const rejectedResult = await rejected.result
  releaseRunning()
  await Promise.all([running.result, queued.result])

  expect(rejectedResult.task.status).toBe("failed")
  expect(rejectedResult.error?.code).toBe("invalid_task")
})

test("scheduler isolates failed tasks from later tasks", async () => {
  const scheduler = createScheduler({ "team-member": 1 })
  const completed: string[] = []

  const failed = scheduler.schedule({
    kind: "team-member",
    run: () => {
      throw new Error("bad teammate")
    },
  })
  const next = scheduler.schedule({
    kind: "team-member",
    run: () => completed.push("next"),
  })

  const [failedResult, nextResult] = await Promise.all([failed.result, next.result])

  expect(failedResult.task.status).toBe("failed")
  expect(failedResult.error?.code).toBe("task_failed")
  expect(nextResult.task.status).toBe("completed")
  expect(completed).toEqual(["next"])
})

test("scheduler emits lifecycle events", async () => {
  const events: RuntimeEvent<"scheduler.task.updated">[] = []
  const bus = createRuntimeEventBus()
  bus.subscribe("scheduler.task.updated", (event) => events.push(event))
  const scheduler = createTaskScheduler({
    defaultTimeoutMs: 1_000,
    events: bus,
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
  })

  await scheduler.schedule({
    id: "evented",
    kind: "tool",
    run: ({ progress }) => progress({ bytes: 1 }),
  }).result

  expect(events.map((event) => event.payload.status)).toEqual(["queued", "started", "progress", "completed"])
})
