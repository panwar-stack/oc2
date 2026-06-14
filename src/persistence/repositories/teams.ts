import type { Database } from "bun:sqlite"
import type { RuntimeErrorShape } from "../../events/events"
import { fromJson, toJson } from "./json"

export type TeamStatus = "active" | "shutdown"
export type TeamMemberStatus =
  | "starting"
  | "blocked"
  | "plan_pending"
  | "active"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
export type TeamMemberLifecycle = "task" | "daemon"
export type DaemonState = "initializing" | "running" | "idle" | "cancelled" | "error"
export type TeamPlanStatus = "none" | "submitted" | "approved" | "rejected"

export interface TeamRecord {
  readonly id: string
  readonly name: string
  readonly goal: string
  readonly leadSessionId: string
  readonly status: TeamStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TeamMemberRecord {
  readonly id: string
  readonly teamId: string
  readonly sessionId: string
  readonly schedulerTaskId?: string
  readonly name: string
  readonly agentId: string
  readonly rolePrompt: string
  readonly status: TeamMemberStatus
  readonly lifecycle: TeamMemberLifecycle
  readonly daemonState?: DaemonState
  readonly daemonReportingCriteria?: string
  readonly daemonLastActiveAt?: string
  readonly daemonError?: RuntimeErrorShape
  readonly dependencyIds: readonly string[]
  readonly planMode: boolean
  readonly planStatus: TeamPlanStatus
  readonly planText?: string
  readonly planDecision?: "approved" | "rejected"
  readonly planFeedback?: string
  readonly planSubmittedAt?: string
  readonly planDecidedAt?: string
  readonly result?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CreateTeamInput {
  readonly name: string
  readonly goal: string
  readonly leadSessionId: string
  readonly now?: string
}

export interface CreateTeamMemberInput {
  readonly teamId: string
  readonly sessionId: string
  readonly name: string
  readonly agentId: string
  readonly rolePrompt: string
  readonly status: TeamMemberStatus
  readonly lifecycle: TeamMemberLifecycle
  readonly daemonReportingCriteria?: string
  readonly dependencyIds?: readonly string[]
  readonly schedulerTaskId?: string
  readonly planMode?: boolean
  readonly now?: string
}

export interface UpdateTeamMemberInput {
  readonly status?: TeamMemberStatus
  readonly daemonState?: DaemonState
  readonly daemonError?: RuntimeErrorShape
  readonly result?: string
  readonly schedulerTaskId?: string
  readonly planMode?: boolean
  readonly planStatus?: TeamPlanStatus
  readonly planText?: string
  readonly planDecision?: "approved" | "rejected"
  readonly planFeedback?: string
  readonly planSubmittedAt?: string
  readonly planDecidedAt?: string
  readonly now?: string
}

interface TeamRow {
  readonly id: string
  readonly name: string
  readonly goal: string
  readonly lead_session_id: string
  readonly status: TeamStatus
  readonly created_at: string
  readonly updated_at: string
}

interface TeamMemberRow {
  readonly id: string
  readonly team_id: string
  readonly session_id: string
  readonly scheduler_task_id: string | null
  readonly name: string
  readonly agent_id: string
  readonly role_prompt: string
  readonly status: TeamMemberStatus
  readonly lifecycle: TeamMemberLifecycle
  readonly daemon_state: DaemonState | null
  readonly daemon_reporting_criteria: string | null
  readonly daemon_last_active_at: string | null
  readonly daemon_error_json: string | null
  readonly dependency_ids_json: string
  readonly plan_mode: number
  readonly plan_status: TeamPlanStatus
  readonly plan_text: string | null
  readonly plan_decision: "approved" | "rejected" | null
  readonly plan_feedback: string | null
  readonly plan_submitted_at: string | null
  readonly plan_decided_at: string | null
  readonly result: string | null
  readonly created_at: string
  readonly updated_at: string
}

const createId = (): string => crypto.randomUUID()

/** Repository for durable team and member lifecycle records. */
export class TeamRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateTeamInput): TeamRecord {
    const now = input.now ?? new Date().toISOString()
    const id = createId()
    this.db
      .query(
        "INSERT INTO teams (id, name, goal, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.goal, input.leadSessionId, "active", now, now)
    return this.get(id) as TeamRecord
  }

  get(id: string): TeamRecord | undefined {
    const row = this.db.query<TeamRow, [string]>("SELECT * FROM teams WHERE id = ?").get(id)
    return row ? toTeamRecord(row) : undefined
  }

  getActiveByLeadSession(leadSessionId: string): TeamRecord | undefined {
    const row = this.db
      .query<
        TeamRow,
        [string]
      >("SELECT * FROM teams WHERE lead_session_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(leadSessionId)
    return row ? toTeamRecord(row) : undefined
  }

  getByMemberSession(sessionId: string): TeamRecord | undefined {
    const row = this.db
      .query<TeamRow, [string]>(
        `SELECT teams.* FROM teams
         JOIN team_members ON team_members.team_id = teams.id
         WHERE team_members.session_id = ?
         ORDER BY teams.created_at DESC LIMIT 1`,
      )
      .get(sessionId)
    return row ? toTeamRecord(row) : undefined
  }

  shutdown(teamId: string, now = new Date().toISOString()): TeamRecord {
    this.db.query("UPDATE teams SET status = ?, updated_at = ? WHERE id = ?").run("shutdown", now, teamId)
    this.db
      .query(
        `UPDATE team_members
         SET status = 'cancelled', daemon_state = CASE WHEN lifecycle = 'daemon' THEN 'cancelled' ELSE daemon_state END, updated_at = ?
         WHERE team_id = ? AND status IN ('starting', 'blocked', 'plan_pending', 'active', 'idle')`,
      )
      .run(now, teamId)
    return this.get(teamId) as TeamRecord
  }

  createMember(input: CreateTeamMemberInput): TeamMemberRecord {
    const now = input.now ?? new Date().toISOString()
    const id = createId()
    this.db
      .query(
        `INSERT INTO team_members
         (id, team_id, session_id, scheduler_task_id, name, agent_id, role_prompt, status, lifecycle, daemon_state, daemon_reporting_criteria,
           daemon_last_active_at, daemon_error_json, dependency_ids_json, plan_mode, plan_status, plan_text, plan_decision, plan_feedback,
           plan_submitted_at, plan_decided_at, result, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.teamId,
        input.sessionId,
        input.schedulerTaskId ?? null,
        input.name,
        input.agentId,
        input.rolePrompt,
        input.status,
        input.lifecycle,
        input.lifecycle === "daemon" ? "initializing" : null,
        input.daemonReportingCriteria ?? null,
        null,
        null,
        toJson(input.dependencyIds ?? []),
        input.planMode ? 1 : 0,
        "none",
        null,
        null,
        null,
        null,
        null,
        null,
        now,
        now,
      )
    return this.getMember(id) as TeamMemberRecord
  }

  getMember(id: string): TeamMemberRecord | undefined {
    const row = this.db.query<TeamMemberRow, [string]>("SELECT * FROM team_members WHERE id = ?").get(id)
    return row ? toMemberRecord(row) : undefined
  }

  getMemberByNameOrSession(teamId: string, value: string): TeamMemberRecord | undefined {
    const row = this.db
      .query<
        TeamMemberRow,
        [string, string, string]
      >("SELECT * FROM team_members WHERE team_id = ? AND (name = ? OR session_id = ?)")
      .get(teamId, value, value)
    return row ? toMemberRecord(row) : undefined
  }

  listMembers(teamId: string): readonly TeamMemberRecord[] {
    return this.db
      .query<TeamMemberRow, [string]>("SELECT * FROM team_members WHERE team_id = ? ORDER BY created_at, id")
      .all(teamId)
      .map(toMemberRecord)
  }

  listRunnableBlockedMembers(teamId: string): readonly TeamMemberRecord[] {
    return this.db
      .query<TeamMemberRow, [string]>(
        "SELECT * FROM team_members WHERE team_id = ? AND status = 'blocked' ORDER BY created_at, id",
      )
      .all(teamId)
      .map(toMemberRecord)
      .filter((member) => this.memberDependenciesCompleted(teamId, member.dependencyIds))
  }

  activeMemberCount(teamId: string): number {
    return (
      this.db
        .query<
          { readonly count: number },
          [string]
        >("SELECT COUNT(*) AS count FROM team_members WHERE team_id = ? AND status IN ('starting', 'active', 'idle')")
        .get(teamId)?.count ?? 0
    )
  }

  dependenciesCompleted(teamId: string, dependencies: readonly string[]): boolean {
    const resolved = dependencies.map((dependency) => this.getMemberByNameOrSession(teamId, dependency))
    return resolved.every((member) => member && member.lifecycle !== "daemon" && member.status === "completed")
  }

  updateMember(id: string, input: UpdateTeamMemberInput): TeamMemberRecord {
    const existing = this.getMember(id)
    if (!existing) throw new Error(`Team member not found: ${id}`)
    const now = input.now ?? new Date().toISOString()
    const daemonState =
      input.daemonState ??
      (input.status === "active" && existing.lifecycle === "daemon" ? "running" : existing.daemonState)
    this.db
      .query(
        `UPDATE team_members
          SET status = ?, scheduler_task_id = ?, daemon_state = ?, daemon_last_active_at = ?, daemon_error_json = ?,
              plan_mode = ?, plan_status = ?, plan_text = ?, plan_decision = ?, plan_feedback = ?, plan_submitted_at = ?, plan_decided_at = ?,
              result = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.status ?? existing.status,
        input.schedulerTaskId ?? existing.schedulerTaskId ?? null,
        daemonState ?? null,
        daemonState ? now : (existing.daemonLastActiveAt ?? null),
        input.daemonError ? toJson(input.daemonError) : existing.daemonError ? toJson(existing.daemonError) : null,
        input.planMode === undefined ? (existing.planMode ? 1 : 0) : input.planMode ? 1 : 0,
        input.planStatus ?? existing.planStatus,
        input.planText ?? existing.planText ?? null,
        input.planDecision ?? existing.planDecision ?? null,
        input.planFeedback ?? existing.planFeedback ?? null,
        input.planSubmittedAt ?? existing.planSubmittedAt ?? null,
        input.planDecidedAt ?? existing.planDecidedAt ?? null,
        input.result ?? existing.result ?? null,
        now,
        id,
      )
    return this.getMember(id) as TeamMemberRecord
  }

  private memberDependenciesCompleted(teamId: string, dependencyIds: readonly string[]): boolean {
    return dependencyIds.every(
      (id) => this.getMember(id)?.teamId === teamId && this.getMember(id)?.status === "completed",
    )
  }
}

function toTeamRecord(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    leadSessionId: row.lead_session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMemberRecord(row: TeamMemberRow): TeamMemberRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    sessionId: row.session_id,
    schedulerTaskId: row.scheduler_task_id ?? undefined,
    name: row.name,
    agentId: row.agent_id,
    rolePrompt: row.role_prompt,
    status: row.status,
    lifecycle: row.lifecycle,
    daemonState: row.daemon_state ?? undefined,
    daemonReportingCriteria: row.daemon_reporting_criteria ?? undefined,
    daemonLastActiveAt: row.daemon_last_active_at ?? undefined,
    daemonError: fromJson<RuntimeErrorShape | undefined>(row.daemon_error_json, undefined),
    dependencyIds: fromJson<readonly string[]>(row.dependency_ids_json, []),
    planMode: row.plan_mode === 1,
    planStatus: row.plan_status,
    planText: row.plan_text ?? undefined,
    planDecision: row.plan_decision ?? undefined,
    planFeedback: row.plan_feedback ?? undefined,
    planSubmittedAt: row.plan_submitted_at ?? undefined,
    planDecidedAt: row.plan_decided_at ?? undefined,
    result: row.result ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
