import type { Database } from "bun:sqlite"
import { fromJson, toJson } from "./json"
import type { RuntimeStatus } from "../../session/message"

export interface WorkspaceRoot {
  readonly id: string
  readonly path: string
  readonly label?: string
  readonly readonly: boolean
}

export interface SessionRecord {
  readonly id: string
  readonly title: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly workspaceRoots: readonly WorkspaceRoot[]
  readonly providerId: string
  readonly modelId: string
  readonly agentId: string
  readonly status: RuntimeStatus
  readonly parentSessionId?: string
  readonly teamId?: string
  readonly metadata: Record<string, unknown>
}

export interface CreateSessionInput {
  readonly id?: string
  readonly title?: string | null
  readonly workspaceRoots: readonly Omit<WorkspaceRoot, "id">[]
  readonly providerId: string
  readonly modelId: string
  readonly agentId: string
  readonly status?: RuntimeStatus
  readonly parentSessionId?: string
  readonly teamId?: string
  readonly metadata?: Record<string, unknown>
  readonly now?: string
}

interface SessionRow {
  readonly id: string
  readonly title: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly provider_id: string
  readonly model_id: string
  readonly agent_id: string
  readonly status: RuntimeStatus
  readonly parent_session_id: string | null
  readonly team_id: string | null
  readonly metadata_json: string
}

interface RootRow {
  readonly id: string
  readonly path: string
  readonly label: string | null
  readonly readonly: 0 | 1
  readonly root_index: number
}

const createId = (): string => crypto.randomUUID()

export class SessionRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateSessionInput): SessionRecord {
    const now = input.now ?? new Date().toISOString()
    const id = input.id ?? createId()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .query(
          `INSERT INTO sessions
          (id, title, created_at, updated_at, provider_id, model_id, agent_id, status, parent_session_id, team_id, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title ?? null,
          now,
          now,
          input.providerId,
          input.modelId,
          input.agentId,
          input.status ?? "idle",
          input.parentSessionId ?? null,
          input.teamId ?? null,
          toJson(input.metadata ?? {}),
        )

      const insertRoot = this.db.query(
        `INSERT INTO workspace_roots (id, session_id, path, label, readonly, root_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      input.workspaceRoots.forEach((root, index) => {
        insertRoot.run(createId(), id, root.path, root.label ?? null, root.readonly ? 1 : 0, index, now)
      })
      this.db.exec("COMMIT")
      return this.get(id) as SessionRecord
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)
    if (!row) return undefined
    return this.toRecord(row)
  }

  list(): readonly SessionRecord[] {
    return this.db
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC, id DESC")
      .all()
      .map((row) => this.toRecord(row))
  }

  updateStatus(id: string, status: RuntimeStatus, now = new Date().toISOString()): SessionRecord {
    this.db.query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id)
    const session = this.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return session
  }

  addWorkspaceRoot(sessionId: string, root: Omit<WorkspaceRoot, "id">, now = new Date().toISOString()): WorkspaceRoot {
    const id = createId()
    const nextIndex =
      this.db.query<{ readonly next_index: number }, [string]>("SELECT COUNT(*) AS next_index FROM workspace_roots WHERE session_id = ?").get(sessionId)
        ?.next_index ?? 0
    this.db
      .query(`INSERT INTO workspace_roots (id, session_id, path, label, readonly, root_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sessionId, root.path, root.label ?? null, root.readonly ? 1 : 0, nextIndex, now)
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId)
    return { id, ...root }
  }

  private toRecord(row: SessionRow): SessionRecord {
    const roots = this.db
      .query<RootRow, [string]>("SELECT id, path, label, readonly, root_index FROM workspace_roots WHERE session_id = ? ORDER BY root_index, created_at, id")
      .all(row.id)
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      workspaceRoots: roots.map((root) => ({
        id: root.id,
        path: root.path,
        label: root.label ?? undefined,
        readonly: root.readonly === 1,
      })),
      providerId: row.provider_id,
      modelId: row.model_id,
      agentId: row.agent_id,
      status: row.status,
      parentSessionId: row.parent_session_id ?? undefined,
      teamId: row.team_id ?? undefined,
      metadata: fromJson(row.metadata_json, {}),
    }
  }
}
