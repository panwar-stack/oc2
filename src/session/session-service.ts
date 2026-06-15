import type { RuntimeEventBus } from "../events/event-bus"
import type { Oc2Database } from "../persistence/db"
import {
  MessageRepository,
  type CreateMessageInput,
  type UpdateMessageInput,
} from "../persistence/repositories/messages"
import { RuntimeEventRepository } from "../persistence/repositories/runtime-events"
import {
  SessionRepository,
  type CreateSessionInput,
  type SessionRecord,
  type UpdateModelSelectionInput,
  type WorkspaceRoot,
} from "../persistence/repositories/sessions"
import { ToolCallRepository } from "../persistence/repositories/tool-calls"
import type { SessionMessage } from "./message"
import type { SessionTranscript } from "./transcript"

export interface SessionServiceOptions {
  readonly database: Oc2Database
  readonly events?: RuntimeEventBus
}

/** High-level session facade that keeps repositories and runtime events in sync. */
export class SessionService {
  readonly database: Oc2Database
  readonly sessions: SessionRepository
  readonly messages: MessageRepository
  readonly toolCalls: ToolCallRepository
  readonly runtimeEvents: RuntimeEventRepository
  private readonly events?: RuntimeEventBus

  constructor(options: SessionServiceOptions) {
    this.database = options.database
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

  listWorkspaceRoots(sessionId: string): readonly WorkspaceRoot[] {
    return this.sessions.get(sessionId)?.workspaceRoots ?? []
  }

  getTranscript(sessionId: string): SessionTranscript | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    return { session, messages: this.messages.listBySession(sessionId) }
  }

  collectTranscripts(sessionId: string, options: { recursive?: boolean } = {}): readonly SessionTranscript[] {
    const root = this.getTranscript(sessionId)
    if (!root) return []
    const transcripts: SessionTranscript[] = [root]
    if (!options.recursive) return transcripts

    const collectChildren = (parentId: string) => {
      for (const child of this.sessions.listChildren(parentId)) {
        transcripts.push({ session: child, messages: this.messages.listBySession(child.id) })
        collectChildren(child.id)
      }
    }
    collectChildren(sessionId)
    return transcripts
  }

  addWorkspaceRoot(sessionId: string, root: Omit<WorkspaceRoot, "id">): WorkspaceRoot {
    const workspaceRoot = this.sessions.addWorkspaceRoot(sessionId, root)
    this.events?.publish({ type: "session.updated", payload: { sessionId } })
    return workspaceRoot
  }

  updateModelSelection(input: UpdateModelSelectionInput): SessionRecord {
    const session = this.sessions.updateModelSelection(input)
    this.events?.publish({ type: "session.updated", payload: { sessionId: input.sessionId } })
    return session
  }

  appendMessage(input: CreateMessageInput): SessionMessage {
    const message = this.messages.append(input)
    // Appends affect the visible transcript, so notify the same consumers as message updates.
    this.events?.publish({ type: "message.updated", payload: { sessionId: message.sessionId, messageId: message.id } })
    return message
  }

  updateMessage(id: string, input: UpdateMessageInput): SessionMessage {
    const message = this.messages.update(id, input)
    this.events?.publish({ type: "message.updated", payload: { sessionId: message.sessionId, messageId: message.id } })
    return message
  }
}

/** Constructs the repository-backed session service for a database connection. */
export const createSessionService = (options: SessionServiceOptions): SessionService => new SessionService(options)
