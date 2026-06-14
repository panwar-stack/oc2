import type { RuntimeEvent, RuntimeEventMap, RuntimeEventProjector } from "../events/events"
import type { PersistedToolCall } from "../persistence/repositories/tool-calls"
import type { MessagePart, MessageRole, RuntimeStatus, SessionMessage } from "../session/message"

export interface TuiMessageView {
  readonly id: string
  readonly role: MessageRole | "streaming"
  readonly text: string
  readonly status: RuntimeStatus
}

export interface TuiToolCallView {
  readonly id: string
  readonly name: string
  readonly status: RuntimeStatus
  readonly error?: string
}

export interface TuiState {
  readonly sessionId?: string
  readonly status: RuntimeStatus
  readonly messages: readonly TuiMessageView[]
  readonly streamingText: string
  readonly toolCalls: readonly TuiToolCallView[]
  readonly errors: readonly string[]
  readonly sidePanel: boolean
  readonly running: boolean
}

export const createInitialTuiState = (sidePanel = true): TuiState => ({
  status: "idle",
  messages: [],
  streamingText: "",
  toolCalls: [],
  errors: [],
  sidePanel,
  running: false,
})

/** Projects runtime events into the narrow state needed by the minimal terminal UI. */
export const projectTuiEvent: RuntimeEventProjector<TuiState> = (state, event) => {
  switch (event.type) {
    case "session.created": {
      const payload = event.payload as RuntimeEventMap["session.created"]
      return { ...state, sessionId: payload.sessionId, status: "idle" }
    }
    case "session.updated": {
      const payload = event.payload as RuntimeEventMap["session.updated"]
      return { ...state, sessionId: payload.sessionId, status: toRuntimeStatus(payload.status, state.status) }
    }
    case "model.started": {
      const payload = event.payload as RuntimeEventMap["model.started"]
      return {
        ...state,
        sessionId: payload.sessionId ?? state.sessionId,
        streamingText: "",
        running: true,
        status: "running",
      }
    }
    case "model.delta": {
      const payload = event.payload as RuntimeEventMap["model.delta"]
      return {
        ...state,
        sessionId: payload.sessionId ?? state.sessionId,
        streamingText: state.streamingText + payload.delta,
        running: true,
      }
    }
    case "model.completed": {
      const payload = event.payload as RuntimeEventMap["model.completed"]
      return appendStreamingMessage({
        ...state,
        sessionId: payload.sessionId ?? state.sessionId,
        running: false,
        status: "completed",
      })
    }
    case "model.failed": {
      const payload = event.payload as RuntimeEventMap["model.failed"]
      return appendError(
        { ...state, sessionId: payload.sessionId ?? state.sessionId, running: false, status: "failed" },
        payload.error.message,
      )
    }
    case "tool.started": {
      const payload = event.payload as RuntimeEventMap["tool.started"]
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, {
          id: payload.taskId ?? payload.toolName,
          name: payload.toolName,
          status: "running",
        }),
      }
    }
    case "tool.completed": {
      const payload = event.payload as RuntimeEventMap["tool.completed"]
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, {
          id: payload.taskId ?? payload.toolName,
          name: payload.toolName,
          status: "completed",
        }),
      }
    }
    case "tool.failed": {
      const payload = event.payload as RuntimeEventMap["tool.failed"]
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, {
          id: payload.taskId ?? payload.toolName,
          name: payload.toolName,
          status: "failed",
          error: payload.error.message,
        }),
      }
    }
    case "error": {
      const payload = event.payload as RuntimeEventMap["error"]
      return appendError(state, payload.error.message)
    }
    default:
      return state
  }
}

export const toggleSidePanel = (state: TuiState): TuiState => ({ ...state, sidePanel: !state.sidePanel })

export const appendLocalMessage = (state: TuiState, role: MessageRole, text: string): TuiState => ({
  ...state,
  messages: [...state.messages, { id: crypto.randomUUID(), role, text, status: "completed" }],
})

export function completeTuiRun(
  state: TuiState,
  result: { readonly sessionId: string; readonly status: "completed" | "failed" },
  aborted: boolean,
): TuiState {
  if (aborted) return { ...state, running: false, status: "cancelled" }
  return { ...state, sessionId: result.sessionId, running: false, status: result.status }
}

export function failTuiRun(state: TuiState, error: unknown, aborted: boolean): TuiState {
  if (aborted) return { ...state, running: false, status: "cancelled" }
  return appendError(
    { ...state, running: false, status: "failed" },
    error instanceof Error ? error.message : String(error),
  )
}

export function hydrateTuiState(
  state: TuiState,
  messages: readonly SessionMessage[],
  toolCalls: readonly PersistedToolCall[],
): TuiState {
  return {
    ...state,
    sessionId: messages[0]?.sessionId ?? state.sessionId,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: partsToText(message.parts),
      status: message.status,
    })),
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      status: call.status,
      error: call.error?.message,
    })),
  }
}

export function applyTuiEvent(state: TuiState, event: RuntimeEvent): TuiState {
  return projectTuiEvent(state, event)
}

function appendStreamingMessage(state: TuiState): TuiState {
  if (!state.streamingText) return state
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: crypto.randomUUID(), role: "assistant", text: state.streamingText, status: "completed" },
    ],
    streamingText: "",
  }
}

function appendError(state: TuiState, message: string): TuiState {
  return { ...state, errors: [...state.errors, message] }
}

function upsertToolCall(calls: readonly TuiToolCallView[], next: TuiToolCallView): readonly TuiToolCallView[] {
  const index = calls.findIndex((call) => call.id === next.id)
  if (index === -1) return [...calls, next]
  return calls.map((call, current) => (current === index ? { ...call, ...next } : call))
}

function partsToText(parts: readonly MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text
      if (part.type === "tool-call") return `[tool:${part.toolCall.name} ${part.toolCall.status}]`
      if (part.type === "tool-result") return `[tool-result:${part.result.toolCallId}]`
      if (part.type === "file") return part.text ?? `[file:${part.path}]`
      return `[event:${part.eventId}]`
    })
    .filter(Boolean)
    .join("\n")
}

function toRuntimeStatus(value: string | undefined, fallback: RuntimeStatus): RuntimeStatus {
  const statuses = new Set<RuntimeStatus>([
    "idle",
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ])
  return statuses.has(value as RuntimeStatus) ? (value as RuntimeStatus) : fallback
}
