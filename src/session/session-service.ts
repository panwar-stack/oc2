import type { RuntimeEventBus } from "../events/event-bus"
import type { Oc2Database } from "../persistence/db"
import { MessageRepository, type CreateMessageInput, type UpdateMessageInput } from "../persistence/repositories/messages"
import { RuntimeEventRepository } from "../persistence/repositories/runtime-events"
import { SessionRepository, type CreateSessionInput, type SessionRecord } from "../persistence/repositories/sessions"
import { ToolCallRepository } from "../persistence/repositories/tool-calls"
import type { SessionMessage } from "./message"

export interface SessionServiceOptions {
  readonly database: Oc2Database
  readonly events?: RuntimeEventBus
}

export class SessionService {
  readonly sessions: SessionRepository
  readonly messages: MessageRepository
  readonly toolCalls: ToolCallRepository
  readonly runtimeEvents: RuntimeEventRepository
  private readonly events?: RuntimeEventBus

  constructor(options: SessionServiceOptions) {
    this.sessions = new SessionRepository(options.database.sqlite)
    this.messages = new MessageRepository(options.database.sqlite)
    this.toolCalls = new ToolCallRepository(options.database.sqlite)
    this.runtimeEvents = new RuntimeEventRepository(options.database.sqlite)
    this.events = options.events
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const session = this.sessions.create(input)
    this.events?.publish({ type: "session.created", payload: { sessionId: session.id } })
    return session
  }

  resumeSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id)
  }

  listSessions(): readonly SessionRecord[] {
    return this.sessions.list()
  }

  appendMessage(input: CreateMessageInput): SessionMessage {
    const message = this.messages.append(input)
    this.events?.publish({ type: "message.updated", payload: { sessionId: message.sessionId, messageId: message.id } })
    return message
  }

  updateMessage(id: string, input: UpdateMessageInput): SessionMessage {
    const message = this.messages.update(id, input)
    this.events?.publish({ type: "message.updated", payload: { sessionId: message.sessionId, messageId: message.id } })
    return message
  }
}

export const createSessionService = (options: SessionServiceOptions): SessionService => new SessionService(options)
