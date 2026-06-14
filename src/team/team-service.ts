import { MainAgent, type MainAgentRunResult } from "../agent/agent"
import { resolveSubAgentProfile, type AgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import type { ModelService } from "../model/model-service"
import {
  TeamMailboxRepository,
  type DeliveredTeamMessage,
  type TeamMailboxMessage,
} from "../persistence/repositories/mailbox"
import { TeamTaskRepository, type TeamTaskRecord, type TeamTaskStatus } from "../persistence/repositories/team-tasks"
import {
  TeamRepository,
  type TeamMemberLifecycle,
  type TeamMemberRecord,
  type TeamRecord,
} from "../persistence/repositories/teams"
import type { TaskScheduler } from "../scheduler/scheduler"
import type { SchedulerTaskHandle } from "../scheduler/task"
import type { SessionService } from "../session/session-service"
import { createToolExecutor, type ToolExecutor } from "../tools/execution"
import type { ToolPermissionService } from "../tools/permissions"
import type { ToolRegistry } from "../tools/registry"
import { recipientKeysForSession, resolveTeamRecipients } from "./mailbox"
import { buildTeamMemberPrompt } from "./prompts"

export interface TeamServiceOptions {
  readonly config: Oc2Config
  readonly sessions: SessionService
  readonly models: ModelService
  readonly registry: ToolRegistry
  readonly scheduler: TaskScheduler
  readonly events?: RuntimeEventBus<unknown>
  readonly permissions?: ToolPermissionService
}

export interface TeamSpawnInput {
  readonly teamId?: string
  readonly leadSessionId: string
  readonly name: string
  readonly agentId: string
  readonly rolePrompt: string
  readonly dependsOn?: readonly string[]
  readonly lifecycle?: TeamMemberLifecycle
  readonly daemonReportingCriteria?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Coordinates persisted teams, teammate child sessions, shared tasks, and mailbox delivery. */
export class TeamService {
  readonly teams: TeamRepository
  readonly tasks: TeamTaskRepository
  readonly mailbox: TeamMailboxRepository
  private readonly activeHandles = new Map<string, SchedulerTaskHandle<MainAgentRunResult>>()

  constructor(private readonly options: TeamServiceOptions) {
    this.teams = new TeamRepository(options.sessions.database.sqlite)
    this.tasks = new TeamTaskRepository(options.sessions.database.sqlite)
    this.mailbox = new TeamMailboxRepository(options.sessions.database.sqlite)
  }

  create(input: { readonly leadSessionId: string; readonly name: string; readonly goal: string }): TeamRecord {
    this.assertCanOwnTeam(input.leadSessionId)
    const team = this.teams.create(input)
    this.options.events?.publish({ type: "team.updated", payload: { teamId: team.id, status: team.status } })
    return team
  }

  async spawn(input: TeamSpawnInput): Promise<TeamMemberRecord> {
    const team = this.resolveTeam(input.leadSessionId, input.teamId)
    this.assertCanOwnTeam(input.leadSessionId)
    if (team.status !== "active") throw invalidTeam(`Team is not active: ${team.id}`)
    if (input.name === "lead") throw invalidTeam("Team member name 'lead' is reserved for the lead mailbox alias")
    const lifecycle = input.lifecycle ?? "task"
    if (lifecycle === "daemon" && !input.daemonReportingCriteria?.trim()) {
      throw invalidTeam("Daemon teammates require explicit reporting criteria")
    }
    const profile = resolveSubAgentProfile(this.options.config, input.agentId)
    if (!profile) throw invalidTeam(`Team agent profile not found or not team-enabled: ${input.agentId}`)
    const dependencies = input.dependsOn ?? []
    const dependencyIds = dependencies.map((dependency) => {
      const member = this.teams.getMemberByNameOrSession(team.id, dependency)
      if (!member) throw invalidTeam(`Team member dependency not found: ${dependency}`)
      if (member.lifecycle === "daemon")
        throw invalidTeam(`Daemon member cannot be a completion dependency: ${dependency}`)
      return member.id
    })
    const blocked =
      dependencyIds.length > 0 && !dependencyIds.every((id) => this.teams.getMember(id)?.status === "completed")
    if (!blocked && this.teams.activeMemberCount(team.id) >= this.options.config.runtime.maxConcurrentTeamMembers) {
      throw invalidTeam(`Team member limit reached for team ${team.id}`)
    }
    const parent = this.options.sessions.resumeSession(input.leadSessionId)
    if (!parent) throw invalidTeam(`Lead session not found: ${input.leadSessionId}`)
    const child = this.options.sessions.createSession({
      title: input.name,
      parentSessionId: parent.id,
      teamId: team.id,
      workspaceRoots: parent.workspaceRoots,
      providerId: parent.providerId,
      modelId: parent.modelId,
      agentId: profile.id,
      status: "idle",
    })
    const member = this.teams.createMember({
      teamId: team.id,
      sessionId: child.id,
      name: input.name,
      agentId: profile.id,
      rolePrompt: input.rolePrompt,
      status: blocked ? "blocked" : "starting",
      lifecycle,
      daemonReportingCriteria: input.daemonReportingCriteria,
      dependencyIds,
    })
    this.options.events?.publish({
      type: "team.member.updated",
      payload: { teamId: team.id, memberId: member.id, status: member.status },
    })
    if (!blocked) this.startMember(team, member, profile, input.timeoutMs, input.signal)
    return member
  }

  shutdown(input: { readonly leadSessionId: string; readonly teamId?: string }): TeamRecord {
    const team = this.resolveLeadTeam(input.leadSessionId, input.teamId)
    for (const member of this.teams.listMembers(team.id)) {
      this.activeHandles.get(member.id)?.cancel("Team was shut down")
      if (member.schedulerTaskId) this.options.scheduler.cancel(member.schedulerTaskId, "Team was shut down")
      this.activeHandles.delete(member.id)
    }
    const shutdown = this.teams.shutdown(team.id)
    this.options.events?.publish({ type: "team.updated", payload: { teamId: team.id, status: shutdown.status } })
    return shutdown
  }

  sendMessage(input: {
    readonly sessionId: string
    readonly teamId?: string
    readonly senderSessionId: string
    readonly recipients: readonly string[]
    readonly body: string
  }): TeamMailboxMessage {
    const team = this.resolveTeam(input.sessionId, input.teamId)
    const members = this.teams.listMembers(team.id)
    const sender = this.senderName(team, input.senderSessionId, members)
    this.assertCanSendMessage(sender, members, false)
    const recipients = resolveTeamRecipients({
      requested: input.recipients,
      leadSessionId: team.leadSessionId,
      members,
    })
    const message = this.mailbox.send({ teamId: team.id, sender, recipients, body: input.body })
    for (const recipient of recipients) {
      this.options.events?.publish({
        type: "team.message.delivered",
        payload: { teamId: team.id, messageId: message.id, recipientId: recipient },
      })
    }
    return message
  }

  broadcast(input: {
    readonly sessionId: string
    readonly teamId?: string
    readonly senderSessionId: string
    readonly body: string
  }): TeamMailboxMessage {
    const team = this.resolveTeam(input.sessionId, input.teamId)
    const members = this.teams.listMembers(team.id)
    const sender = this.senderName(team, input.senderSessionId, members)
    this.assertCanSendMessage(sender, members, true)
    const recipients = ["lead", ...members.map((member) => member.name)].filter((recipient) => recipient !== sender)
    const message = this.mailbox.send({ teamId: team.id, sender, recipients, body: input.body })
    for (const recipient of recipients) {
      this.options.events?.publish({
        type: "team.message.delivered",
        payload: { teamId: team.id, messageId: message.id, recipientId: recipient },
      })
    }
    return message
  }

  getMessages(input: { readonly teamId?: string; readonly sessionId: string }): readonly DeliveredTeamMessage[] {
    const team = this.resolveTeam(input.sessionId, input.teamId)
    const keys = recipientKeysForSession({
      sessionId: input.sessionId,
      leadSessionId: team.leadSessionId,
      members: this.teams.listMembers(team.id),
    })
    return this.mailbox.deliver(team.id, keys)
  }

  createTask(input: {
    readonly sessionId: string
    readonly teamId?: string
    readonly description: string
    readonly assignee?: string
    readonly dependencyIds?: readonly string[]
  }): TeamTaskRecord {
    const team = this.resolveTeam(input.sessionId, input.teamId)
    const task = this.tasks.create({
      teamId: team.id,
      description: input.description,
      assignee: input.assignee,
      dependencyIds: input.dependencyIds,
    })
    this.options.events?.publish({
      type: "team.task.updated",
      payload: { teamId: team.id, taskId: task.id, status: task.status },
    })
    return task
  }

  listTasks(input: { readonly sessionId: string; readonly teamId?: string }): readonly TeamTaskRecord[] {
    return this.tasks.list(this.resolveTeam(input.sessionId, input.teamId).id)
  }

  claimTask(input: { readonly sessionId: string; readonly taskId: string; readonly assignee: string }): TeamTaskRecord {
    this.assertTaskMutation(input.sessionId, input.taskId, input.assignee)
    const task = this.tasks.claim(input.taskId, input.assignee)
    this.options.events?.publish({
      type: "team.task.updated",
      payload: { teamId: task.teamId, taskId: task.id, status: task.status },
    })
    return task
  }

  updateTask(input: {
    readonly sessionId: string
    readonly taskId: string
    readonly status?: TeamTaskStatus
    readonly assignee?: string
  }): TeamTaskRecord {
    this.assertTaskMutation(input.sessionId, input.taskId, input.assignee)
    const task = this.tasks.update(input.taskId, { status: input.status, assignee: input.assignee })
    this.options.events?.publish({
      type: "team.task.updated",
      payload: { teamId: task.teamId, taskId: task.id, status: task.status },
    })
    return task
  }

  private startMember(
    team: TeamRecord,
    member: TeamMemberRecord,
    profile: AgentProfile,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): void {
    const handle = this.options.scheduler.schedule<MainAgentRunResult>({
      kind: "team-member",
      parent: signal,
      timeoutMs: timeoutMs ?? profile.timeoutMs ?? this.options.config.runtime.defaultTimeoutMs,
      run: async ({ signal: childSignal }) => {
        this.teams.updateMember(member.id, {
          status: "active",
          daemonState: member.lifecycle === "daemon" ? "running" : undefined,
        })
        this.options.events?.publish({
          type: "team.member.updated",
          payload: { teamId: team.id, memberId: member.id, status: "active" },
        })
        const session = this.options.sessions.sessions.tryStartRun(member.sessionId)
        if (!session) throw invalidTeam(`Team member session is already running: ${member.sessionId}`)
        const result = await this.createAgent().run({
          session,
          profile,
          prompt: buildTeamMemberPrompt({
            teamName: team.name,
            teamGoal: team.goal,
            memberName: member.name,
            rolePrompt: member.rolePrompt,
            daemonReportingCriteria: member.daemonReportingCriteria,
          }),
          config: this.options.config,
          signal: childSignal,
        })
        this.options.sessions.sessions.updateStatus(member.sessionId, result.status)
        return result
      },
    })
    this.activeHandles.set(member.id, handle)
    this.teams.updateMember(member.id, { schedulerTaskId: handle.id })
    handle.result.then((scheduled) => {
      this.activeHandles.delete(member.id)
      const current = this.teams.getMember(member.id)
      const currentTeam = this.teams.get(team.id)
      if (!current || current.status === "cancelled" || currentTeam?.status === "shutdown") return
      const error = scheduled.error?.toJSON()
      const status =
        member.lifecycle === "daemon" && !error
          ? "idle"
          : error || scheduled.value?.status === "failed"
            ? "failed"
            : "completed"
      const daemonState = member.lifecycle === "daemon" ? (error ? "error" : "idle") : undefined
      const resultText = scheduled.value?.text
      const updated = this.teams.updateMember(member.id, {
        status,
        daemonState,
        daemonError: error,
        result: resultText,
      })
      this.options.events?.publish({
        type: "team.member.updated",
        payload: { teamId: team.id, memberId: member.id, status: updated.status },
      })
      if (error) {
        this.mailbox.send({
          teamId: team.id,
          sender: member.name,
          recipients: ["lead"],
          body: `Member ${member.name} failed: ${error.message}`,
        })
      }
      for (const blocked of this.teams.listRunnableBlockedMembers(team.id)) {
        if (this.teams.activeMemberCount(team.id) >= this.options.config.runtime.maxConcurrentTeamMembers) break
        const blockedProfile = resolveSubAgentProfile(this.options.config, blocked.agentId)
        if (blockedProfile) {
          const starting = this.teams.updateMember(blocked.id, { status: "starting" })
          this.startMember(team, starting, blockedProfile, undefined, undefined)
        }
      }
    })
  }

  private createAgent(): MainAgent {
    const tools: ToolExecutor = createToolExecutor({
      registry: this.options.registry,
      scheduler: this.options.scheduler,
      events: this.options.events,
      config: this.options.config,
      permissions: this.options.permissions,
    })
    return new MainAgent({
      sessions: this.options.sessions,
      models: this.options.models,
      registry: this.options.registry,
      tools,
    })
  }

  private resolveTeam(sessionId: string, teamId: string | undefined): TeamRecord {
    const team = teamId
      ? this.teams.get(teamId)
      : (this.teams.getActiveByLeadSession(sessionId) ?? this.teams.getByMemberSession(sessionId))
    if (!team) throw invalidTeam(teamId ? `Team not found: ${teamId}` : `No active team for session ${sessionId}`)
    if (
      team.leadSessionId !== sessionId &&
      this.teams.getMemberByNameOrSession(team.id, sessionId)?.sessionId !== sessionId
    ) {
      throw invalidTeam(`Session ${sessionId} is not part of team ${team.id}`)
    }
    return team
  }

  private resolveLeadTeam(leadSessionId: string, teamId: string | undefined): TeamRecord {
    const team = teamId ? this.teams.get(teamId) : this.teams.getActiveByLeadSession(leadSessionId)
    if (!team) throw invalidTeam(teamId ? `Team not found: ${teamId}` : `No active team for session ${leadSessionId}`)
    if (team.leadSessionId !== leadSessionId) throw invalidTeam(`Only the lead session can manage team ${team.id}`)
    return team
  }

  private assertTaskMutation(sessionId: string, taskId: string, requestedAssignee: string | undefined): void {
    const task = this.tasks.get(taskId)
    if (!task) throw invalidTeam(`Team task not found: ${taskId}`)
    const team = this.resolveTeam(sessionId, task.teamId)
    if (sessionId === team.leadSessionId) return
    const member = this.teams.getMemberByNameOrSession(team.id, sessionId)
    if (!member) throw invalidTeam(`Session ${sessionId} is not part of team ${team.id}`)
    const assignee = task.assignee ?? requestedAssignee
    if (assignee !== member.name) throw invalidTeam(`Only the lead or assignee can mutate task ${taskId}`)
    if (requestedAssignee && requestedAssignee !== member.name) {
      throw invalidTeam(`Team member ${member.name} cannot claim or reassign task ${taskId} for ${requestedAssignee}`)
    }
  }

  private assertCanOwnTeam(sessionId: string): void {
    const session = this.options.sessions.resumeSession(sessionId)
    if (!session) throw invalidTeam(`Session not found: ${sessionId}`)
    if (session.parentSessionId || session.teamId || this.teams.getByMemberSession(sessionId)) {
      throw invalidTeam("Nested teams are not allowed from child or teammate sessions")
    }
  }

  private senderName(team: TeamRecord, sessionId: string, members: readonly TeamMemberRecord[]): string {
    if (sessionId === team.leadSessionId) return "lead"
    return members.find((member) => member.sessionId === sessionId)?.name ?? sessionId
  }

  private assertCanSendMessage(sender: string, members: readonly TeamMemberRecord[], broadcast: boolean): void {
    const member = members.find((candidate) => candidate.name === sender)
    if (!member || member.lifecycle !== "daemon") return
    if (!member.daemonReportingCriteria) throw invalidTeam(`Daemon member ${member.name} has no reporting criteria`)
    if (broadcast)
      throw invalidTeam(`Daemon member ${member.name} cannot broadcast; report to lead when criteria are met`)
    if (member.daemonState !== "running" && member.daemonState !== "idle") {
      throw invalidTeam(`Daemon member ${member.name} is not ready to report`)
    }
  }
}

export const createTeamService = (options: TeamServiceOptions): TeamService => new TeamService(options)

function invalidTeam(message: string): RuntimeError {
  return new RuntimeError({ code: "invalid_task", message, recoverable: true, kind: "team" })
}
