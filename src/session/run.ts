import { join } from "node:path"

import { MainAgent, type MainAgentRunResult } from "../agent/agent"
import { resolveMainAgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus, type RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import { createMcpService, createMcpToolConfigEntries } from "../mcp/mcp-service"
import type { McpClientFactory } from "../mcp/client"
import { createModelService, type ModelService, type ModelServiceOptions } from "../model/model-service"
import { openOc2Database, type Oc2Database } from "../persistence/db"
import { createTaskScheduler, type TaskScheduler } from "../scheduler/scheduler"
import { createSessionService, type SessionService } from "./session-service"
import { createBuiltInToolRegistry } from "../tools/builtins/index"
import { createToolExecutor } from "../tools/execution"
import type { ToolRegistry } from "../tools/registry"
import { createSubAgentService } from "../subagent/subagent-service"
import { createSubAgentTool } from "../subagent/subagent-tool"
import { createTeamService } from "../team/team-service"
import { createTeamTools } from "../team/team-tools"
import { TeamRepository } from "../persistence/repositories/teams"

export interface SessionRunServiceOptions {
  readonly config: Oc2Config
  readonly cwd: string
  readonly dataDir?: string
  readonly database?: Oc2Database
  readonly events?: RuntimeEventBus<unknown>
  readonly sessions?: SessionService
  readonly models?: ModelService
  readonly registry?: ToolRegistry
  readonly scheduler?: TaskScheduler
  readonly providers?: ModelServiceOptions["providers"]
  readonly mcpClientFactory?: McpClientFactory
  readonly resolveQuestion?: (input: unknown, signal: AbortSignal) => Promise<unknown>
}

export interface RunPromptInput {
  readonly prompt: string
  readonly sessionId?: string
  readonly model?: string
  readonly enabledTools?: readonly string[]
  readonly disabledTools?: readonly string[]
  readonly enabledMcp?: readonly string[]
  readonly disabledMcp?: readonly string[]
  readonly signal?: AbortSignal
}

/** Owns one-shot session runs and enforces a single active model loop per session. */
export class SessionRunService {
  readonly sessions: SessionService
  readonly database?: Oc2Database
  private readonly models: ModelService
  private readonly registry: ToolRegistry
  private readonly scheduler: TaskScheduler
  private readonly events: RuntimeEventBus<unknown>
  private readonly config: Oc2Config
  private readonly cwd: string
  private readonly mcpClientFactory?: McpClientFactory
  private readonly resolveQuestion?: (input: unknown, signal: AbortSignal) => Promise<unknown>
  private readonly active = new Set<string>()

  constructor(options: SessionRunServiceOptions) {
    this.events = options.events ?? createRuntimeEventBus()
    this.scheduler =
      options.scheduler ??
      createTaskScheduler({
        limits: {
          model: 1,
          tool: options.config.runtime.maxConcurrentTools,
          mcp: 1,
          subagent: options.config.runtime.maxConcurrentSubAgents,
          "team-member": options.config.runtime.maxConcurrentTeamMembers,
        },
        defaultTimeoutMs: options.config.runtime.defaultTimeoutMs,
        events: this.events,
      })
    this.database = options.database ?? openOc2Database({ path: join(options.dataDir ?? options.cwd, "oc2.sqlite") })
    this.sessions = options.sessions ?? createSessionService({ database: this.database, events: this.events })
    this.registry = options.registry ?? createBuiltInToolRegistry()
    this.models =
      options.models ??
      createModelService({ providers: options.providers, scheduler: this.scheduler, events: this.events })
    this.config = options.config
    this.cwd = options.cwd
    this.mcpClientFactory = options.mcpClientFactory
    this.resolveQuestion = options.resolveQuestion
  }

  async run(input: RunPromptInput): Promise<MainAgentRunResult> {
    const profile = resolveMainAgentProfile(this.config)
    const model = parseModel(input.model ?? profile.defaultModel, this.config)
    const session = input.sessionId
      ? this.sessions.resumeSession(input.sessionId)
      : this.sessions.createSession({
          title: input.prompt.slice(0, 80),
          workspaceRoots: [{ path: this.cwd, readonly: false }],
          providerId: model.providerId,
          modelId: model.modelId,
          agentId: profile.id,
          status: "idle",
        })
    if (!session)
      throw new RuntimeError({
        code: "invalid_task",
        message: `Session not found: ${input.sessionId}`,
        recoverable: true,
      })
    this.assertTeamPlanRunAllowed(session.id)
    if (this.active.has(session.id)) {
      throw new RuntimeError({
        code: "invalid_task",
        message: `A model run is already active for session ${session.id}`,
        recoverable: true,
        details: { reason: "run_already_active" },
      })
    }

    this.active.add(session.id)
    const started = this.sessions.sessions.tryStartRun(session.id)
    if (!started) {
      this.active.delete(session.id)
      throw new RuntimeError({
        code: "invalid_task",
        message: `A model run is already active for session ${session.id}`,
        recoverable: true,
        details: { reason: "run_already_active" },
      })
    }
    const runConfig = applyRunSelections(this.config, input)
    const mcp = createMcpService({
      config: runConfig,
      registry: this.registry,
      events: this.events,
      scheduler: this.scheduler,
      clientFactory: this.mcpClientFactory,
    })
    const mcpStatuses = await mcp.startEnabled(input.signal)
    const agentConfig = {
      ...runConfig,
      tools: { ...runConfig.tools, ...createMcpToolConfigEntries(runConfig, mcpStatuses) },
    }
    const tools = createToolExecutor({
      registry: this.registry,
      scheduler: this.scheduler,
      events: this.events,
      config: agentConfig,
    })
    const subagents = createSubAgentService({
      config: agentConfig,
      sessions: this.sessions,
      models: this.models,
      registry: this.registry,
      scheduler: this.scheduler,
      events: this.events,
    })
    const teams = createTeamService({
      config: agentConfig,
      sessions: this.sessions,
      models: this.models,
      registry: this.registry,
      scheduler: this.scheduler,
      events: this.events,
    })
    this.registry.register(createSubAgentTool({ service: subagents }))
    for (const teamTool of createTeamTools({ service: teams })) {
      this.registry.register(teamTool)
    }
    const agent = new MainAgent({ sessions: this.sessions, models: this.models, registry: this.registry, tools })
    try {
      const result = await agent.run({
        session: started,
        profile,
        prompt: input.prompt,
        config: agentConfig,
        signal: input.signal ?? new AbortController().signal,
        resolveQuestion: this.resolveQuestion,
      })
      this.sessions.sessions.updateStatus(session.id, result.status)
      return result
    } catch (error) {
      this.sessions.sessions.updateStatus(session.id, "failed")
      throw error
    } finally {
      await mcp.close()
      this.active.delete(session.id)
    }
  }

  private assertTeamPlanRunAllowed(sessionId: string): void {
    if (!this.database) return
    const teams = new TeamRepository(this.database.sqlite)
    const team = teams.getByMemberSession(sessionId)
    if (!team) return
    const member = teams.getMemberByNameOrSession(team.id, sessionId)
    if (!member?.planMode || member.planStatus === "approved") return
    throw new RuntimeError({
      code: "invalid_task",
      message: `Team member ${member.name} cannot run before plan approval`,
      recoverable: true,
      kind: "team",
    })
  }
}

export const createSessionRunService = (options: SessionRunServiceOptions): SessionRunService =>
  new SessionRunService(options)

function parseModel(value: string | undefined, config: Oc2Config): { providerId: string; modelId: string } {
  if (!value) return { providerId: config.model.provider, modelId: config.model.model }
  const [providerId, ...modelParts] = value.split("/")
  return { providerId: providerId || config.model.provider, modelId: modelParts.join("/") || config.model.model }
}

function applyRunSelections(config: Oc2Config, input: RunPromptInput): Oc2Config {
  const tools = { ...config.tools }
  for (const name of input.enabledTools ?? []) tools[name] = { ...tools[name], enabled: true }
  for (const name of input.disabledTools ?? []) tools[name] = { ...tools[name], enabled: false }

  const mcp = { ...config.mcp }
  for (const id of input.enabledMcp ?? []) {
    if (mcp[id]) mcp[id] = { ...mcp[id], enabled: true }
  }
  for (const id of input.disabledMcp ?? []) {
    if (mcp[id]) mcp[id] = { ...mcp[id], enabled: false }
  }

  return { ...config, tools, mcp }
}
