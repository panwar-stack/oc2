import { RuntimeError, type RuntimeErrorShape } from "../events/events"

export type SchedulerTaskKind = "model" | "tool" | "mcp" | "subagent" | "team-member"

export type SchedulerTaskStatus = "queued" | "started" | "progress" | "completed" | "failed" | "cancelled" | "timed_out"

export type SchedulerTaskPriority = "low" | "normal" | "high"

export interface SchedulerTaskContext {
  readonly taskId: string
  readonly kind: SchedulerTaskKind
  readonly parentTaskId?: string
  readonly signal: AbortSignal
  progress(value: unknown): void
}

export type SchedulerTaskRunner<TResult> = (context: SchedulerTaskContext) => Promise<TResult> | TResult

export interface ScheduleTaskInput<TResult> {
  readonly id?: string
  readonly kind: SchedulerTaskKind
  readonly priority?: SchedulerTaskPriority | number
  readonly timeoutMs?: number
  readonly parent?: AbortSignal | SchedulerTaskHandle<unknown>
  readonly run: SchedulerTaskRunner<TResult>
}

export interface SchedulerTaskSnapshot {
  readonly id: string
  readonly kind: SchedulerTaskKind
  readonly status: SchedulerTaskStatus
  readonly priority: number
  readonly queuedAt: Date
  readonly startedAt?: Date
  readonly completedAt?: Date
  readonly parentTaskId?: string
  readonly error?: RuntimeErrorShape
  readonly progress?: unknown
}

export interface SchedulerTaskResult<TResult> {
  readonly task: SchedulerTaskSnapshot
  readonly value?: TResult
  readonly error?: RuntimeError
}

export interface SchedulerTaskHandle<TResult> {
  readonly id: string
  readonly kind: SchedulerTaskKind
  readonly signal: AbortSignal
  readonly result: Promise<SchedulerTaskResult<TResult>>
  cancel(reason?: string): void
  snapshot(): SchedulerTaskSnapshot
}

/** Generates unique scheduler task identifiers for callers that do not supply one. */
export const createTaskId = (): string => crypto.randomUUID()

/** Normalizes arbitrary thrown values into RuntimeError instances tied to a scheduler task. */
export const toRuntimeError = (error: unknown, input: { taskId: string; kind: SchedulerTaskKind }): RuntimeError => {
  if (error instanceof RuntimeError) {
    return error
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new RuntimeError({
      code: "cancelled",
      message: error.message || "Task was cancelled",
      recoverable: true,
      cause: error,
      taskId: input.taskId,
      kind: input.kind,
    })
  }
  if (error instanceof Error) {
    return new RuntimeError({
      code: "task_failed",
      message: error.message,
      recoverable: false,
      cause: error,
      taskId: input.taskId,
      kind: input.kind,
    })
  }
  return new RuntimeError({
    code: "unknown",
    message: "Task failed with a non-error value",
    recoverable: false,
    cause: error,
    taskId: input.taskId,
    kind: input.kind,
  })
}
