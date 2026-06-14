import type { Database } from "bun:sqlite"
import { fromJson, toJson } from "./json"

export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TeamTaskRecord {
  readonly id: string
  readonly teamId: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly assignee?: string
  readonly dependencyIds: readonly string[]
  readonly metadata: Record<string, unknown>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateTeamTaskInput {
  readonly teamId: string
  readonly description: string
  readonly assignee?: string
  readonly dependencyIds?: readonly string[]
  readonly metadata?: Record<string, unknown>
  readonly now?: string
}

interface TeamTaskRow {
  readonly id: string
  readonly team_id: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly assignee: string | null
  readonly dependency_ids_json: string
  readonly metadata_json: string
  readonly created_at: string
  readonly updated_at: string
}

const createId = (): string => crypto.randomUUID()

/** Repository for shared team tasks with transactional dependency-aware claiming. */
export class TeamTaskRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateTeamTaskInput): TeamTaskRecord {
    const now = input.now ?? new Date().toISOString()
    const id = createId()
    this.db
      .query(
        `INSERT INTO team_tasks
         (id, team_id, description, status, assignee, dependency_ids_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.teamId,
        input.description,
        "pending",
        input.assignee ?? null,
        toJson(input.dependencyIds ?? []),
        toJson(input.metadata ?? {}),
        now,
        now,
      )
    return this.get(id) as TeamTaskRecord
  }

  get(id: string): TeamTaskRecord | undefined {
    const row = this.db.query<TeamTaskRow, [string]>("SELECT * FROM team_tasks WHERE id = ?").get(id)
    return row ? toRecord(row) : undefined
  }

  list(teamId: string): readonly TeamTaskRecord[] {
    return this.db
      .query<TeamTaskRow, [string]>("SELECT * FROM team_tasks WHERE team_id = ? ORDER BY created_at, id")
      .all(teamId)
      .map(toRecord)
  }

  claim(taskId: string, assignee: string, now = new Date().toISOString()): TeamTaskRecord {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const task = this.get(taskId)
      if (!task) throw new Error(`Team task not found: ${taskId}`)
      if (task.status !== "pending") throw new Error(`Team task is not pending: ${taskId}`)
      const tasks = new Map(this.list(task.teamId).map((candidate) => [candidate.id, candidate]))
      const blocked = task.dependencyIds.find((dependencyId) => tasks.get(dependencyId)?.status !== "completed")
      if (blocked) throw new Error(`Team task dependency is not completed: ${blocked}`)
      this.db
        .query("UPDATE team_tasks SET status = ?, assignee = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .run("in_progress", assignee, now, taskId)
      this.db.exec("COMMIT")
      return this.get(taskId) as TeamTaskRecord
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  update(
    taskId: string,
    input: { readonly status?: TeamTaskStatus; readonly assignee?: string; readonly now?: string },
  ): TeamTaskRecord {
    const existing = this.get(taskId)
    if (!existing) throw new Error(`Team task not found: ${taskId}`)
    const now = input.now ?? new Date().toISOString()
    this.db
      .query("UPDATE team_tasks SET status = ?, assignee = ?, updated_at = ? WHERE id = ?")
      .run(input.status ?? existing.status, input.assignee ?? existing.assignee ?? null, now, taskId)
    return this.get(taskId) as TeamTaskRecord
  }
}

function toRecord(row: TeamTaskRow): TeamTaskRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    description: row.description,
    status: row.status,
    assignee: row.assignee ?? undefined,
    dependencyIds: fromJson<readonly string[]>(row.dependency_ids_json, []),
    metadata: fromJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
