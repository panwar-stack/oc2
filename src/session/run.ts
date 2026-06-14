import { join, resolve } from "node:path"

import { MainAgent, type MainAgentRunResult } from "../agent/agent"
import { resolveMainAgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus, type RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import { createMcpService, createMcpToolConfigEntries } from "../mcp/mcp-service"
import type { McpClientFactory, McpHostHandlers } from "../mcp/client"
import { createModelService, type ModelService, type ModelServiceOptions } from "../model/model-service"
import { openOc2Database, type Oc2Database } from "../persistence/db"
import { RepositoryMemoryRepository } from "../persistence/repositories/memory"
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
  readonly roots?: readonly string[]
  readonly signal?: AbortSignal
}

/** Owns one-shot session runs and enforces a single active model loop per session. */
export class SessionRunService {
  readonly sessions: SessionService
  readonly database?: Oc2Database
  private readonly models: ModelService
  private readonly registry: ToolRegistry
  private readonly memory: RepositoryMemoryRepository
  private readonly scheduler: TaskScheduler
  private readonly events: RuntimeEventBus<unknown>
  private readonly config: Oc2Config
  private readonly cwd: string
  private readonly dataDir: string
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
    this.memory = new RepositoryMemoryRepository(this.database.sqlite)
    this.registry = options.registry ?? createBuiltInToolRegistry()
    this.models =
      options.models ??
      createModelService({ providers: options.providers, scheduler: this.scheduler, events: this.events })
    this.config = options.config
    this.cwd = options.cwd
    this.dataDir = options.dataDir ?? options.cwd
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
          workspaceRoots: resolveSessionRoots(input.roots, this.cwd),
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
    let samplingActive = false
    const hostHandlers: McpHostHandlers = {
      rootsList: async (_signal: AbortSignal) => {
        return session.workspaceRoots.map((root) => ({
          uri: root.path.startsWith("/") ? `file://${root.path}` : `file:///${root.path}`,
          name: root.label,
        }))
      },
      samplingCreateMessage: async (serverId: string, params: Record<string, unknown>, signal: AbortSignal) => {
        if (samplingActive) {
          return {
            model: "",
            stopReason: "refusal",
            role: "assistant",
            content: { type: "text", text: "Recursive MCP sampling rejected" },
          }
        }

        const samplingAction = `mcp.sampling:${serverId}`
        const samplingPermission = runConfig.mcp?.[serverId]?.toolPermissions?.find(
          (rule) => rule.match === samplingAction,
        )
        if (!samplingPermission || samplingPermission.decision !== "allow") {
          return {
            model: "",
            stopReason: "refusal",
            role: "assistant",
            content: { type: "text", text: "Sampling permission not granted" },
          }
        }

        samplingActive = true
        try {
          const messages = (params.messages as Array<{ role: string; content: unknown }>) ?? []
          const modelMessages = messages.map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
            content:
              typeof m.content === "object" && m.content !== null
                ? (((m.content as Record<string, unknown>).text as string) ?? JSON.stringify(m.content))
                : String(m.content),
          }))

          const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : undefined

          const result = await this.models.collect(model.providerId, {
            sessionId: session.id,
            modelId: model.modelId,
            messages: modelMessages,
            tools: [],
            maxTokens,
            signal,
          })

          return {
            model: model.modelId,
            stopReason: "endTurn",
            role: "assistant",
            content: { type: "text", text: result.text },
          }
        } finally {
          samplingActive = false
        }
      },
      elicitationCreate: async (_serverId: string, params: Record<string, unknown>, signal: AbortSignal) => {
        const message = typeof params.message === "string" ? params.message : String(params.message ?? "")
        const header = "MCP Server Request"
        const secretPatterns = ["password", "secret", "token", "api key", "credential", "private key", "passphrase"]
        const isSecretRequest = secretPatterns.some((p) => message.toLowerCase().includes(p))
        const fullHeader = isSecretRequest ? `${header} - SECURITY: This request may involve secrets` : header

        const answer = this.resolveQuestion
          ? await this.resolveQuestion(
              {
                question: message,
                header: fullHeader,
                options: [],
              },
              signal,
            )
          : undefined

        if (answer === undefined || signal.aborted) {
          return { action: "decline" }
        }

        const schema = params.requestedSchema as Record<string, unknown> | undefined
        if (schema && typeof schema === "object") {
          const validationError = validateAgainstSchema(answer, schema)
          if (validationError) {
            return {
              action: "decline",
              reason: `Schema validation failed: ${validationError}`,
            }
          }
        }

        return { action: "accept", content: answer }
      },
    }
    const mcp = createMcpService({
      config: runConfig,
      registry: this.registry,
      events: this.events,
      scheduler: this.scheduler,
      clientFactory: this.mcpClientFactory,
      hostHandlers,
      dataDir: this.dataDir,
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
      memory: this.memory,
    })
    const teams = createTeamService({
      config: agentConfig,
      sessions: this.sessions,
      models: this.models,
      registry: this.registry,
      scheduler: this.scheduler,
      events: this.events,
      memory: this.memory,
    })
    this.registry.register(createSubAgentTool({ service: subagents }))
    for (const teamTool of createTeamTools({ service: teams })) {
      this.registry.register(teamTool)
    }
    const agent = new MainAgent({
      sessions: this.sessions,
      models: this.models,
      registry: this.registry,
      tools,
      memory: this.memory,
    })
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

/** Converts CLI/API root paths into ordered absolute workspace roots for new sessions. */
function resolveSessionRoots(roots: readonly string[] | undefined, cwd: string) {
  const rootPaths = roots && roots.length > 0 ? roots : [cwd]
  return rootPaths.map((path) => ({ path: resolve(cwd, path), readonly: false }))
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

function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string | undefined {
  if (schema.type === "object" && typeof value === "object" && value !== null) {
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
    const properties = schema.properties as Record<string, unknown> | undefined
    for (const key of required) {
      if (!(key in (value as Record<string, unknown>))) return `missing required field: ${key}`
    }
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in (value as Record<string, unknown>)) {
          const propResult = validateField(
            (value as Record<string, unknown>)[key],
            propSchema as Record<string, unknown>,
          )
          if (propResult) return `field "${key}": ${propResult}`
        }
      }
    }
    return undefined
  }
  return validateField(value, schema)
}

function validateField(value: unknown, schema: Record<string, unknown>): string | undefined {
  const type = schema.type as string | undefined
  if (type === "string" && typeof value !== "string") return "expected string"
  if (type === "number" && typeof value !== "number") return "expected number"
  if (type === "boolean" && typeof value !== "boolean") return "expected boolean"
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return "expected integer"
  return undefined
}
