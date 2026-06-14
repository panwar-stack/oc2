import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import { normalizePriority } from "./priority"
import { createTaskQueue } from "./queue"
import {
  createTaskId,
  toRuntimeError,
  type ScheduleTaskInput,
  type SchedulerTaskHandle,
  type SchedulerTaskKind,
  type SchedulerTaskResult,
  type SchedulerTaskSnapshot,
  type SchedulerTaskStatus,
} from "./task"

export interface SchedulerLimits {
  readonly model: number
  readonly tool: number
  readonly mcp: number
  readonly subagent: number
  readonly "team-member": number
}

export type SchedulerQueueLimits = SchedulerLimits

export interface TaskSchedulerOptions {
  readonly limits: SchedulerLimits
  readonly queueLimits?: Partial<SchedulerQueueLimits>
  readonly defaultTimeoutMs: number
  readonly events?: RuntimeEventBus<unknown>
}

export interface TaskScheduler {
  schedule<TResult>(input: ScheduleTaskInput<TResult>): SchedulerTaskHandle<TResult>
  snapshot(taskId: string): SchedulerTaskSnapshot | undefined
  cancel(taskId: string, reason?: string): boolean
}

interface InternalTask<TResult> {
  readonly handle: SchedulerTaskHandle<TResult>
  readonly run: ScheduleTaskInput<TResult>["run"]
  readonly controller: AbortController
  readonly priority: number
  readonly timeoutMs: number
  readonly parent?: AbortSignal | SchedulerTaskHandle<unknown>
  snapshot: SchedulerTaskSnapshot
  settled: boolean
  settle(result: SchedulerTaskResult<TResult>): void
}

const taskKinds: readonly SchedulerTaskKind[] = ["model", "tool", "mcp", "subagent", "team-member"]
const defaultQueueLimit = 100

/**
 * Creates a concurrency-limited task scheduler with per-kind queues, timeouts,
 * cancellation, progress snapshots, and optional runtime events.
 */
export const createTaskScheduler = (options: TaskSchedulerOptions): TaskScheduler => {
  const queues = new Map(
    taskKinds.map((kind) => [kind, createTaskQueue<InternalTask<unknown>>(options.queueLimits?.[kind] ?? defaultQueueLimit)]),
  )
  const running = new Map<SchedulerTaskKind, Set<string>>(taskKinds.map((kind) => [kind, new Set<string>()]))
  const tasks = new Map<string, InternalTask<unknown>>()

  const emit = (snapshot: SchedulerTaskSnapshot) => {
    options.events?.publish({
      type: "scheduler.task.updated",
      payload: {
        taskId: snapshot.id,
        kind: snapshot.kind,
        status: snapshot.status,
        parentTaskId: snapshot.parentTaskId,
        error: snapshot.error,
        progress: snapshot.progress,
      },
    })
  }

  const update = (task: InternalTask<unknown>, status: SchedulerTaskStatus, patch: Partial<SchedulerTaskSnapshot> = {}) => {
    task.snapshot = {
      ...task.snapshot,
      ...patch,
      status,
    }
    emit(task.snapshot)
  }

  const finish = <TResult>(task: InternalTask<TResult>, result: SchedulerTaskResult<TResult>) => {
    if (task.settled) {
      return
    }
    task.settled = true
    running.get(task.snapshot.kind)?.delete(task.snapshot.id)
    task.settle(result)
    drain(task.snapshot.kind)
  }

  const failQueued = (task: InternalTask<unknown>, error: RuntimeError, status: "cancelled" | "timed_out" | "failed") => {
    queues.get(task.snapshot.kind)?.remove((candidate) => candidate.snapshot.id === task.snapshot.id)
    update(task, status, { completedAt: new Date(), error: error.toJSON() })
    finish(task, { task: task.snapshot, error })
    tasks.delete(task.snapshot.id)
  }

  const cancelTask = (task: InternalTask<unknown>, reason = "Task was cancelled") => {
    // Queued tasks have not seen their AbortSignal yet, so resolve them immediately.
    if (task.snapshot.status === "queued") {
      failQueued(
        task,
        new RuntimeError({ code: "cancelled", message: reason, taskId: task.snapshot.id, kind: task.snapshot.kind }),
        "cancelled",
      )
      return
    }
    if (task.snapshot.status === "started" || task.snapshot.status === "progress") {
      task.controller.abort(reason)
    }
  }

  const runTask = <TResult>(task: InternalTask<TResult>) => {
    running.get(task.snapshot.kind)?.add(task.snapshot.id)
    update(task, "started", { startedAt: new Date() })

    let timeout: Timer | undefined
    if (task.timeoutMs > 0) {
      timeout = setTimeout(() => {
        task.controller.abort(
          new RuntimeError({
            code: "timed_out",
            message: `Task timed out after ${task.timeoutMs}ms`,
            taskId: task.snapshot.id,
            kind: task.snapshot.kind,
          }),
        )
      }, task.timeoutMs)
    }

    const context = {
      taskId: task.snapshot.id,
      kind: task.snapshot.kind,
      parentTaskId: task.snapshot.parentTaskId,
      signal: task.controller.signal,
      progress(value: unknown) {
        if (!task.snapshot.completedAt && !task.controller.signal.aborted) {
          update(task, "progress", { progress: value })
        }
      },
    }

    const abortResult = new Promise<never>((_, reject) => {
      const onAbort = () => reject(task.controller.signal.reason)
      if (task.controller.signal.aborted) {
        onAbort()
        return
      }
      task.controller.signal.addEventListener("abort", onAbort, { once: true })
    })

    Promise.resolve()
      .then(() => Promise.race([Promise.resolve(task.run(context)), abortResult]))
      .then((value) => {
        if (timeout) {
          clearTimeout(timeout)
        }
        if (task.controller.signal.aborted) {
          const reason = task.controller.signal.reason
          throw reason instanceof RuntimeError
            ? reason
            : new RuntimeError({
                code: "cancelled",
                message: typeof reason === "string" ? reason : "Task was cancelled",
                taskId: task.snapshot.id,
                kind: task.snapshot.kind,
              })
        }
        update(task, "completed", { completedAt: new Date() })
        finish(task, { task: task.snapshot, value })
      })
      .catch((error) => {
        if (timeout) {
          clearTimeout(timeout)
        }
        const runtimeError = task.controller.signal.aborted
          ? task.controller.signal.reason instanceof RuntimeError
            ? task.controller.signal.reason
            : new RuntimeError({
                code: "cancelled",
                message:
                  typeof task.controller.signal.reason === "string" ? task.controller.signal.reason : "Task was cancelled",
                cause: error,
                taskId: task.snapshot.id,
                kind: task.snapshot.kind,
              })
          : toRuntimeError(error, { taskId: task.snapshot.id, kind: task.snapshot.kind })
        const status = runtimeError.code === "timed_out" ? "timed_out" : runtimeError.code === "cancelled" ? "cancelled" : "failed"
        if (!task.snapshot.completedAt) {
          update(task, status, { completedAt: new Date(), error: runtimeError.toJSON() })
        }
        finish(task, { task: task.snapshot, error: runtimeError })
      })
  }

  function drain(kind: SchedulerTaskKind) {
    const limit = Math.max(0, options.limits[kind])
    const active = running.get(kind)?.size ?? 0
    const queue = queues.get(kind)
    if (!queue || active >= limit) {
      return
    }
    const available = limit - active
    for (let index = 0; index < available; index += 1) {
      const task = queue.dequeue()
      if (!task) {
        return
      }
      if (task.controller.signal.aborted) {
        // Parent cancellation can abort a queued task before capacity is available.
        cancelTask(task, "Task was cancelled before it started")
        continue
      }
      runTask(task)
    }
  }

  return {
    schedule<TResult>(input: ScheduleTaskInput<TResult>): SchedulerTaskHandle<TResult> {
      const id = input.id ?? createTaskId()
      const controller = new AbortController()
      const priority = normalizePriority(input.priority)
      const parentSignal = input.parent instanceof AbortSignal ? input.parent : input.parent?.signal
      const parentTaskId = input.parent instanceof AbortSignal ? undefined : input.parent?.id
      let settle!: (result: SchedulerTaskResult<TResult>) => void
      const result = new Promise<SchedulerTaskResult<TResult>>((resolve) => {
        settle = resolve
      })
      const task: InternalTask<TResult> = {
        controller,
        handle: undefined as never,
        parent: input.parent,
        priority,
        run: input.run,
        settled: false,
        settle,
        timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs,
        snapshot: {
          id,
          kind: input.kind,
          status: "queued",
          priority,
          queuedAt: new Date(),
          parentTaskId,
        },
      }
      const handle: SchedulerTaskHandle<TResult> = {
        id,
        kind: input.kind,
        signal: controller.signal,
        result,
        cancel: (reason?: string) => cancelTask(task, reason),
        snapshot: () => task.snapshot,
      }
      ;(task as { handle: SchedulerTaskHandle<TResult> }).handle = handle

      tasks.set(id, task as InternalTask<unknown>)
      emit(task.snapshot)

      if (parentSignal?.aborted) {
        cancelTask(task, "Parent task was cancelled")
        return handle
      }

      if (parentSignal) {
        const abortFromParent = () => cancelTask(task, "Parent task was cancelled")
        parentSignal.addEventListener("abort", abortFromParent, { once: true })
        result.finally(() => parentSignal.removeEventListener("abort", abortFromParent))
      }

      const enqueued = queues.get(input.kind)?.enqueue(task as InternalTask<unknown>, priority) ?? false
      if (!enqueued) {
        failQueued(
          task,
          new RuntimeError({
            code: "invalid_task",
            message: `Scheduler queue for ${input.kind} is full`,
            recoverable: true,
            taskId: id,
            kind: input.kind,
            details: { queueLimit: queues.get(input.kind)?.capacity ?? 0 },
          }),
          "failed",
        )
        return handle
      }
      drain(input.kind)
      return handle
    },

    snapshot(taskId) {
      return tasks.get(taskId)?.snapshot
    },

    cancel(taskId, reason) {
      const task = tasks.get(taskId)
      if (!task) {
        return false
      }
      cancelTask(task, reason)
      return true
    },
  }
}
