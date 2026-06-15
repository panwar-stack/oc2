import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { MainAgent, type MainAgentRunResult } from "../agent/agent"
import { resolveMainAgentProfile, type AgentProfile } from "../agent/profiles"
import { mainAgentSystemPrompt } from "../agent/prompts"
import { createBuiltinCommands } from "../commands/builtins"
import { createCommandRegistry } from "../commands/registry"
import { resolveCommandTemplate } from "../commands/resolver"
import type { CommandRegistry } from "../commands/types"
import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus, type RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import { redactText, redactValue } from "../logging/redaction"
import { createMcpService, createMcpToolConfigEntries } from "../mcp/mcp-service"
import type { McpClientFactory, McpHostHandlers } from "../mcp/client"
import { createModelService, type ModelService, type ModelServiceOptions } from "../model/model-service"
import { getShallowJsonObjectValidationError, type ModelInfo, type ShallowJsonObject } from "../model/provider"
import { openOc2Database, type Oc2Database } from "../persistence/db"
import { RepositoryMemoryRepository } from "../persistence/repositories/memory"
import type { SessionRecord } from "../persistence/repositories/sessions"
import { createTaskScheduler, type TaskScheduler } from "../scheduler/scheduler"
import { createSessionService, type SessionService } from "./session-service"
import { createBuiltInToolRegistry } from "../tools/builtins/index"
import { createToolExecutor } from "../tools/execution"
import type { ToolRegistry } from "../tools/registry"
import type { ToolDefinition } from "../tools/tool"
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
  readonly commands?: CommandRegistry
  readonly scheduler?: TaskScheduler
  readonly providers?: ModelServiceOptions["providers"]
  readonly mcpClientFactory?: McpClientFactory
  readonly resolveQuestion?: (input: unknown, signal: AbortSignal) => Promise<unknown>
}

export interface RunPromptInput {
  readonly prompt: string
  readonly sessionId?: string
  readonly model?: string
  readonly modelVariant?: string
  readonly modelVariantOptions?: ShallowJsonObject
  readonly agent?: string
  readonly enabledTools?: readonly string[]
  readonly disabledTools?: readonly string[]
  readonly enabledMcp?: readonly string[]
  readonly disabledMcp?: readonly string[]
  readonly roots?: readonly string[]
  readonly team?: boolean
  readonly timeoutMs?: number
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
}

export interface CommandInput {
  readonly name: string
  readonly arguments?: string
  readonly sessionId?: string
  readonly model?: string
  readonly modelVariant?: string
  readonly modelVariantOptions?: ShallowJsonObject
  readonly agent?: string
  readonly enabledTools?: readonly string[]
  readonly disabledTools?: readonly string[]
  readonly enabledMcp?: readonly string[]
  readonly disabledMcp?: readonly string[]
  readonly roots?: readonly string[]
  readonly team?: boolean
  readonly timeoutMs?: number
  readonly maxConcurrency?: number
  readonly signal?: AbortSignal
}

export interface ListedModelOption {
  readonly providerId: string
  readonly providerName: string
  readonly model: ModelInfo
}

export interface ListedModelOptionsResult {
  readonly options: readonly ListedModelOption[]
  readonly providerCount: number
  readonly failedProviderCount: number
  readonly errors: readonly string[]
}

/** Owns one-shot session runs and enforces a single active model loop per session. */
export class SessionRunService {
  readonly sessions: SessionService
  readonly database?: Oc2Database
  private readonly models: ModelService
  private readonly registry: ToolRegistry
  private readonly commands: CommandRegistry
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
    this.commands = options.commands ?? createCommandRegistry(createBuiltinCommands())
    this.models =
      options.models ??
      createModelService({ providers: options.providers, scheduler: this.scheduler, events: this.events })
    this.config = options.config
    this.cwd = options.cwd
    this.dataDir = options.dataDir ?? options.cwd
    this.mcpClientFactory = options.mcpClientFactory
    this.resolveQuestion = options.resolveQuestion
  }

  async command(input: CommandInput): Promise<MainAgentRunResult> {
    const command = this.commands.get(input.name)
    if (!command || command.source === "tui" || !command.template) {
      return this.commandFailure(
        input,
        new RuntimeError({
          code: "invalid_task",
          message: `Slash command not found: ${input.name}`,
          recoverable: true,
        }),
      )
    }

    return this.run({
      prompt: await resolveCommandTemplate(command, input.arguments ?? ""),
      sessionId: input.sessionId,
      model: command.model ?? input.model,
      modelVariant: command.model ? undefined : input.modelVariant,
      modelVariantOptions: command.model ? undefined : input.modelVariantOptions,
      agent: input.agent ?? command.agent,
      enabledTools: input.enabledTools,
      disabledTools: input.disabledTools,
      enabledMcp: input.enabledMcp,
      disabledMcp: input.disabledMcp,
      roots: input.roots,
      team: input.team,
      timeoutMs: input.timeoutMs,
      maxConcurrency: input.maxConcurrency,
      signal: input.signal,
    })
  }

  async listModelOptions(): Promise<ListedModelOptionsResult> {
    const providers = this.models.listProviders().toSorted(compareProviders)
    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const models = await this.models.listModels(provider.id)
        return { provider, models: models.toSorted(compareModels) }
      }),
    )

    const options: ListedModelOption[] = []
    const errors: string[] = []
    for (const result of settled) {
      if (result.status === "fulfilled") {
        for (const model of result.value.models) {
          options.push({ providerId: result.value.provider.id, providerName: result.value.provider.name, model })
        }
      } else {
        errors.push(redactText(result.reason instanceof Error ? result.reason.message : String(result.reason)))
      }
    }

    return { options, providerCount: providers.length, failedProviderCount: errors.length, errors }
  }

  private commandFailure(input: CommandInput, error: RuntimeError): MainAgentRunResult {
    const sessionId = input.sessionId ?? this.createFailedCommandSession(input).id
    if (this.sessions.resumeSession(sessionId)) this.sessions.sessions.updateStatus(sessionId, "failed")
    return { sessionId, text: "", toolCalls: [], errors: [error.toJSON()], status: "failed" }
  }

  private createFailedCommandSession(input: CommandInput) {
    const profile = resolveMainAgentProfile(this.config)
    const model = parseModel(input.model ?? profile.defaultModel, this.config)
    return this.sessions.createSession({
      title: `/${input.name}`,
      workspaceRoots: resolveSessionRoots(undefined, this.cwd),
      providerId: model.providerId,
      modelId: model.modelId,
      agentId: profile.id,
      status: "failed",
    })
  }

  async run(input: RunPromptInput): Promise<MainAgentRunResult> {
    const baseProfile = resolveRunAgentProfile(this.config, input.agent)
    const profile = input.timeoutMs ? { ...baseProfile, timeoutMs: input.timeoutMs } : baseProfile
    const model = parseModel(input.model ?? profile.defaultModel, this.config)
    validateModelVariantOptions(input.modelVariantOptions)
    let session = input.sessionId
      ? this.sessions.resumeSession(input.sessionId)
      : this.sessions.createSession({
          title: input.prompt.slice(0, 80),
          workspaceRoots: resolveSessionRoots(input.roots, this.cwd),
          providerId: model.providerId,
          modelId: model.modelId,
          agentId: profile.id,
          status: "idle",
          metadata: input.modelVariant ? { modelVariant: input.modelVariant } : undefined,
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
    if (session.status === "running") {
      throw new RuntimeError({
        code: "invalid_task",
        message: `A model run is already active for session ${session.id}`,
        recoverable: true,
        details: { reason: "run_already_active" },
      })
    }

    if (input.sessionId && input.model) {
      session = this.sessions.updateModelSelection({
        sessionId: session.id,
        providerId: model.providerId,
        modelId: model.modelId,
        variantId: input.modelVariant,
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
    const modelVariant = getPersistedModelVariant(started)
    const runConfig = applyRunSelections(this.config, input)
    const activeSamplingServers = new Set<string>()
    const hostHandlers: McpHostHandlers = {
      rootsList: async (_signal: AbortSignal) => {
        return session.workspaceRoots.map((root) => ({
          uri: pathToFileURL(root.path).href,
          name: root.label,
        }))
      },
      samplingCreateMessage: async (serverId: string, params: Record<string, unknown>, signal: AbortSignal) => {
        if (activeSamplingServers.has(serverId)) {
          return {
            model: "",
            stopReason: "refusal",
            role: "assistant",
            content: { type: "text", text: "Recursive MCP sampling rejected" },
          }
        }

        const samplingAction = `mcp.sampling:${serverId}`
        const samplingAllowed = (runConfig.mcp?.[serverId]?.toolPermissions ?? []).some(
          (rule) => rule.match === samplingAction && rule.decision === "allow",
        )
        if (!samplingAllowed) {
          return {
            model: "",
            stopReason: "refusal",
            role: "assistant",
            content: { type: "text", text: "Sampling permission not granted" },
          }
        }

        activeSamplingServers.add(serverId)
        try {
          const safeParams = redactValue(params) as Record<string, unknown>
          const messages = (safeParams.messages as Array<{ role: string; content: unknown }>) ?? []
          const modelMessages = messages.map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
            content: redactText(
              typeof m.content === "object" && m.content !== null
                ? (((m.content as Record<string, unknown>).text as string) ?? JSON.stringify(m.content))
                : String(m.content),
            ),
          }))

          const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : undefined

          const result = await this.models.collect(started.providerId, {
            sessionId: session.id,
            modelId: started.modelId,
            messages: modelMessages,
            tools: [],
            maxTokens,
            signal,
            providerOptions: { source: "mcp.sampling", serverId },
          })

          return {
            model: model.modelId,
            stopReason: "endTurn",
            role: "assistant",
            content: { type: "text", text: result.text },
          }
        } finally {
          activeSamplingServers.delete(serverId)
        }
      },
      elicitationCreate: async (_serverId: string, params: Record<string, unknown>, signal: AbortSignal) => {
        const message = typeof params.message === "string" ? params.message : String(params.message ?? "")
        const header = "MCP Server Request"
        const schema = params.requestedSchema as Record<string, unknown> | undefined
        const secretHints = collectSecretLikeSchemaHints(schema)
        const isSecretRequest = hasSecretLikeText(message) || secretHints.length > 0
        const fullHeader = isSecretRequest ? `${header} - SECURITY: This request may involve secrets` : header
        const question =
          secretHints.length > 0 ? `${message}\n\nSecret-looking fields: ${secretHints.join(", ")}` : message

        let answer: unknown
        const permissionId = crypto.randomUUID()
        this.events.publish({
          type: "permission.requested",
          payload: {
            permissionId,
            toolName: "mcp.elicitation",
            action: "question",
            resource: "user",
            sessionId: session.id,
            question: { question, header: fullHeader, options: [] },
          },
        })
        try {
          answer = this.resolveQuestion
            ? await this.resolveQuestion(
                {
                  question,
                  header: fullHeader,
                  options: [],
                },
                signal,
              )
            : undefined
        } catch {
          return { action: "cancel" }
        } finally {
          this.events.publish({
            type: "permission.resolved",
            payload: { permissionId, decision: "allow", toolName: "mcp.elicitation" },
          })
        }

        if (signal.aborted) {
          return { action: "cancel" }
        }
        if (answer === undefined) {
          return { action: "decline" }
        }

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
    this.registry.register(createSubAgentTool({ service: subagents }))
    const registeredTeamTools: { readonly name: string; readonly previous?: ToolDefinition }[] = []
    if (input.team) {
      const teams = createTeamService({
        config: agentConfig,
        sessions: this.sessions,
        models: this.models,
        registry: this.registry,
        scheduler: this.scheduler,
        events: this.events,
        memory: this.memory,
      })
      for (const teamTool of createTeamTools({ service: teams })) {
        registeredTeamTools.push({ name: teamTool.name, previous: this.registry.get(teamTool.name) })
        this.registry.register(teamTool)
      }
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
        modelVariant,
        modelVariantOptions: input.modelVariantOptions,
        resolveQuestion: this.resolveQuestion,
      })
      this.sessions.sessions.updateStatus(session.id, result.status)
      return result
    } catch (error) {
      this.sessions.sessions.updateStatus(session.id, "failed")
      throw error
    } finally {
      await mcp.close()
      for (const tool of registeredTeamTools) {
        if (tool.previous) this.registry.register(tool.previous)
        else this.registry.unregister(tool.name)
      }
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

function resolveRunAgentProfile(config: Pick<Oc2Config, "agents">, agentId?: string): AgentProfile {
  if (!agentId) return resolveMainAgentProfile(config)
  const configured = config.agents[agentId]
  if (!configured) return resolveMainAgentProfile(config)
  return {
    id: configured.id ?? agentId,
    name: configured.name ?? agentId,
    description: configured.description ?? "Command agent profile",
    mode: configured.mode ?? "all",
    systemPrompt: configured.systemPrompt ?? mainAgentSystemPrompt,
    defaultModel: configured.defaultModel,
    allowedTools: configured.allowedTools ?? [],
    maxIterations: configured.maxIterations ?? 20,
    timeoutMs: configured.timeoutMs,
  }
}

function parseModel(value: string | undefined, config: Oc2Config): { providerId: string; modelId: string } {
  if (!value) return { providerId: config.model.provider, modelId: config.model.model }
  const [providerId, ...modelParts] = value.split("/")
  return { providerId: providerId || config.model.provider, modelId: modelParts.join("/") || config.model.model }
}

function validateModelVariantOptions(value: ShallowJsonObject | undefined): void {
  if (value === undefined) return
  const error = getShallowJsonObjectValidationError(value)
  if (!error) return
  throw new RuntimeError({
    code: "invalid_task",
    message: `Invalid model variant runtime options: ${error}`,
    recoverable: true,
  })
}

function getPersistedModelVariant(session: SessionRecord): string | undefined {
  return typeof session.metadata.modelVariant === "string" ? session.metadata.modelVariant : undefined
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
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    return "value is not one of the allowed options"
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return "value does not match const"

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "expected object"
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
    const properties = schema.properties as Record<string, unknown> | undefined
    const record = value as Record<string, unknown>
    for (const key of required) {
      if (!(key in record)) return `missing required field: ${key}`
    }
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in record) {
          const propResult = validateAgainstSchema(record[key], propSchema as Record<string, unknown>)
          if (propResult) return `field "${key}": ${propResult}`
        }
      }
    }
    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) return `unexpected field: ${key}`
      }
    }
    return undefined
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return "expected array"
    const itemSchema = schema.items as Record<string, unknown> | undefined
    if (itemSchema) {
      for (let index = 0; index < value.length; index++) {
        const itemResult = validateAgainstSchema(value[index], itemSchema)
        if (itemResult) return `item ${index}: ${itemResult}`
      }
    }
    return undefined
  }
  return validateField(value, schema)
}

function validateField(value: unknown, schema: Record<string, unknown>): string | undefined {
  const type = schema.type as string | undefined
  if (type === "string" && typeof value !== "string") return "expected string"
  if (type === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      return `expected at least ${schema.minLength} characters`
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return `expected at most ${schema.maxLength} characters`
  }
  if (type === "number" && typeof value !== "number") return "expected number"
  if (type === "number" && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `expected >= ${schema.minimum}`
    if (typeof schema.maximum === "number" && value > schema.maximum) return `expected <= ${schema.maximum}`
  }
  if (type === "boolean" && typeof value !== "boolean") return "expected boolean"
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) return "expected integer"
  if (type === "integer" && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `expected >= ${schema.minimum}`
    if (typeof schema.maximum === "number" && value > schema.maximum) return `expected <= ${schema.maximum}`
  }
  return undefined
}

function compareProviders(
  a: { readonly id: string; readonly name: string },
  b: { readonly id: string; readonly name: string },
) {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

function compareModels(a: ModelInfo, b: ModelInfo) {
  return (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id)
}

function hasSecretLikeText(value: string): boolean {
  return ["password", "secret", "token", "api key", "apikey", "credential", "private key", "passphrase"].some((p) =>
    value.toLowerCase().includes(p),
  )
}

function collectSecretLikeSchemaHints(schema: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return []
  if (Array.isArray(schema))
    return schema.flatMap((value, index) => collectSecretLikeSchemaHints(value, `${path}[${index}]`))
  const hints: string[] = []
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    const nextPath = path ? `${path}.${key}` : key
    if (hasSecretLikeText(key)) hints.push(nextPath)
    if ((key === "description" || key === "title") && typeof value === "string" && hasSecretLikeText(value)) {
      hints.push(nextPath)
    }
    hints.push(...collectSecretLikeSchemaHints(value, nextPath))
  }
  return [...new Set(hints)]
}
