/** Event names used on the in-process runtime bus and optional persistence. */
export type RuntimeEventType =
  | "session.created"
  | "session.updated"
  | "message.updated"
  | "model.started"
  | "model.delta"
  | "model.completed"
  | "model.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.requested"
  | "permission.resolved"
  | "subagent.updated"
  | "team.updated"
  | "team.member.updated"
  | "team.task.updated"
  | "team.message.delivered"
  | "mcp.status"
  | "scheduler.task.updated"
  | "diagnostic.warning"
  | "error"

export type RuntimeErrorCode = "cancelled" | "timed_out" | "task_failed" | "invalid_task" | "unknown"

export interface RuntimeErrorShape {
  readonly name: "RuntimeError"
  readonly code: RuntimeErrorCode
  readonly message: string
  readonly recoverable: boolean
  readonly cause?: unknown
  readonly details?: Record<string, unknown>
  readonly taskId?: string
  readonly kind?: string
}

/** Serializable runtime error used across schedulers, sessions, tools, and providers. */
export class RuntimeError extends Error implements RuntimeErrorShape {
  override readonly name = "RuntimeError"
  readonly code: RuntimeErrorCode
  readonly recoverable: boolean
  override readonly cause?: unknown
  readonly details?: Record<string, unknown>
  readonly taskId?: string
  readonly kind?: string

  constructor(input: {
    code: RuntimeErrorCode
    message: string
    recoverable?: boolean
    cause?: unknown
    details?: Record<string, unknown>
    taskId?: string
    kind?: string
  }) {
    super(input.message)
    this.code = input.code
    this.recoverable = input.recoverable ?? input.code !== "task_failed"
    this.cause = input.cause
    this.details = input.details
    this.taskId = input.taskId
    this.kind = input.kind
  }

  toJSON(): RuntimeErrorShape {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      cause: this.cause,
      details: this.details,
      taskId: this.taskId,
      kind: this.kind,
    }
  }
}

/** Type-safe payload registry keyed by runtime event type. */
export interface RuntimeEventMap {
  "session.created": { readonly sessionId: string }
  "session.updated": { readonly sessionId: string; readonly status?: string }
  "message.updated": { readonly sessionId: string; readonly messageId: string }
  "model.started": { readonly sessionId?: string; readonly taskId?: string; readonly model?: string }
  "model.delta": {
    readonly sessionId?: string
    readonly taskId?: string
    readonly delta: string
    readonly modelEvent?: unknown
  }
  "model.completed": { readonly sessionId?: string; readonly taskId?: string }
  "model.failed": { readonly sessionId?: string; readonly taskId?: string; readonly error: RuntimeErrorShape }
  "tool.started": { readonly sessionId?: string; readonly taskId?: string; readonly toolName: string }
  "tool.completed": { readonly sessionId?: string; readonly taskId?: string; readonly toolName: string }
  "tool.failed": {
    readonly sessionId?: string
    readonly taskId?: string
    readonly toolName: string
    readonly error: RuntimeErrorShape
  }
  "permission.requested": { readonly permissionId: string; readonly toolName?: string }
  "permission.resolved": { readonly permissionId: string; readonly decision: "allow" | "deny" }
  "subagent.updated": { readonly subagentId: string; readonly status: string; readonly taskId?: string }
  "team.updated": { readonly teamId: string; readonly status: string }
  "team.member.updated": { readonly teamId: string; readonly memberId: string; readonly status: string }
  "team.task.updated": { readonly teamId: string; readonly taskId: string; readonly status: string }
  "team.message.delivered": { readonly teamId: string; readonly messageId: string; readonly recipientId: string }
  "mcp.status": { readonly serverId: string; readonly status: string; readonly error?: RuntimeErrorShape }
  "scheduler.task.updated": {
    readonly taskId: string
    readonly kind: string
    readonly status: string
    readonly parentTaskId?: string
    readonly error?: RuntimeErrorShape
    readonly progress?: unknown
  }
  "diagnostic.warning": { readonly message: string; readonly code?: string }
  error: { readonly error: RuntimeErrorShape }
}

export interface RuntimeEvent<TType extends RuntimeEventType = RuntimeEventType> {
  readonly id: string
  readonly type: TType
  readonly timestamp: Date
  readonly payload: RuntimeEventMap[TType]
}

export type RuntimeEventInput<TType extends RuntimeEventType> = {
  readonly type: TType
  readonly payload: RuntimeEventMap[TType]
}

export type RuntimeEventListener<TEvent extends RuntimeEvent = RuntimeEvent> = (event: TEvent) => void

export type RuntimeEventProjector<TState> = (state: TState, event: RuntimeEvent) => TState

/** Creates a globally unique event id for runtime bus messages. */
export const createRuntimeEventId = (): string => crypto.randomUUID()

/** Adds id and timestamp metadata to a typed runtime event payload. */
export const createRuntimeEvent = <TType extends RuntimeEventType>(
  input: RuntimeEventInput<TType>,
): RuntimeEvent<TType> => ({
  id: createRuntimeEventId(),
  type: input.type,
  timestamp: new Date(),
  payload: input.payload,
})
