import { MainAgent, type MainAgentRunResult } from "../agent/agent"
import { resolveSubAgentProfile, type AgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError, type RuntimeErrorShape } from "../events/events"
import type { ModelService } from "../model/model-service"
import type { RepositoryMemoryRepository } from "../persistence/repositories/memory"
import type { SessionRecord } from "../persistence/repositories/sessions"
import type { TaskScheduler } from "../scheduler/scheduler"
import { createToolExecutor, type ToolExecutor } from "../tools/execution"
import type { ToolPermissionService } from "../tools/permissions"
import type { ToolRegistry } from "../tools/registry"
import { deriveSubAgentConfig } from "./permissions"

export interface CreateSubAgentInput {
  readonly agentId: string
  readonly prompt: string
  readonly description?: string
  readonly context?: string
  readonly timeoutMs?: number
  readonly background?: boolean
}

export interface RunSubAgentInput extends CreateSubAgentInput {
  readonly parentSessionId: string
  readonly signal?: AbortSignal
}

export interface SubAgentRunResult {
  readonly subagentId: string
  readonly sessionId: string
  readonly parentSessionId: string
  readonly agentId: string
  readonly taskId?: string
  readonly background: boolean
  readonly status: MainAgentRunResult["status"] | "running"
  readonly text: string
  readonly toolCalls: MainAgentRunResult["toolCalls"]
  readonly errors: readonly RuntimeErrorShape[]
}

export interface SubAgentServiceOptions {
  readonly config: Oc2Config
  readonly sessions: import("../session/session-service").SessionService
  readonly models: ModelService
  readonly registry: ToolRegistry
  readonly scheduler: TaskScheduler
  readonly events?: RuntimeEventBus<unknown>
  readonly memory?: RepositoryMemoryRepository
  readonly permissions?: ToolPermissionService
  readonly allowBackground?: boolean
}

/** Creates child sessions and runs subagent model loops with bounded scheduling. */
export class SubAgentService {
  constructor(private readonly options: SubAgentServiceOptions) {}

  async run(input: RunSubAgentInput): Promise<SubAgentRunResult> {
    const parent = this.options.sessions.resumeSession(input.parentSessionId)
    if (!parent) throw invalidSubAgent(`Parent session not found: ${input.parentSessionId}`)
    if (input.background && !this.options.allowBackground) {
      throw invalidSubAgent("Background subagents require explicit service configuration")
    }
    if (input.signal?.aborted) throw cancelledSubAgent(input.signal.reason)

    const profile = resolveSubAgentProfile(this.options.config, input.agentId)
    if (!profile) throw invalidSubAgent(`Subagent profile not found or not subagent-enabled: ${input.agentId}`)

    const childConfig = deriveSubAgentConfig(this.options.config, profile)
    const child = this.createChildSession(parent, profile, input, childConfig)
    const subagentId = crypto.randomUUID()
    const timeoutMs = input.timeoutMs ?? profile.timeoutMs ?? this.options.config.runtime.defaultTimeoutMs
    const handle = this.options.scheduler.schedule<SubAgentRunResult>({
      kind: "subagent",
      parent: input.signal,
      timeoutMs,
      run: async ({ signal, taskId }) => {
        this.options.events?.publish({ type: "subagent.updated", payload: { subagentId, status: "running", taskId } })
        const started = this.options.sessions.sessions.tryStartRun(child.id)
        if (!started) throw invalidSubAgent(`Child session is already running: ${child.id}`)
        try {
          const result = await this.createAgent(childConfig).run({
            session: started,
            profile,
            prompt: buildChildPrompt(input),
            config: childConfig,
            signal,
          })
          this.options.sessions.sessions.updateStatus(child.id, result.status)
          this.options.events?.publish({
            type: "subagent.updated",
            payload: { subagentId, status: result.status, taskId },
          })
          return toSubAgentResult(input, subagentId, child.id, false, result, taskId)
        } catch (error) {
          this.options.sessions.sessions.updateStatus(child.id, "failed")
          throw error
        }
      },
    })

    if (input.background) {
      this.observeBackground(handle.result, child.id, subagentId)
      if (handle.snapshot().status === "failed" || handle.snapshot().status === "cancelled") {
        const scheduled = await handle.result
        const error = scheduled.error ?? invalidSubAgent("Subagent background task failed before it started")
        return failedSubAgentResult(input, subagentId, child.id, profile.id, scheduled.task.id, error)
      }
      return {
        subagentId,
        sessionId: child.id,
        parentSessionId: input.parentSessionId,
        agentId: profile.id,
        taskId: handle.id,
        background: true,
        status: "running",
        text: "",
        toolCalls: [],
        errors: [],
      }
    }

    return handle.result.then((scheduled) => {
      if (scheduled.value) return scheduled.value
      const error = scheduled.error ?? invalidSubAgent("Subagent task completed without a result")
      this.options.sessions.sessions.updateStatus(child.id, "failed")
      this.options.events?.publish({
        type: "subagent.updated",
        payload: { subagentId, status: error.code, taskId: scheduled.task.id },
      })
      return failedSubAgentResult(input, subagentId, child.id, profile.id, scheduled.task.id, error)
    })
  }

  private observeBackground(
    result: Promise<import("../scheduler/task").SchedulerTaskResult<SubAgentRunResult>>,
    childSessionId: string,
    subagentId: string,
  ): void {
    result.then((scheduled) => {
      try {
        const status = scheduled.value?.status ?? (scheduled.error ? "failed" : "completed")
        this.options.sessions.sessions.updateStatus(childSessionId, status === "running" ? "idle" : status)
        this.options.events?.publish({
          type: "subagent.updated",
          payload: { subagentId, status: scheduled.error?.code ?? status, taskId: scheduled.task.id },
        })
      } catch (error) {
        this.options.events?.publish({
          type: "error",
          payload: {
            error: new RuntimeError({
              code: "task_failed",
              message: error instanceof Error ? error.message : String(error),
              recoverable: true,
              kind: "subagent",
              taskId: scheduled.task.id,
            }).toJSON(),
          },
        })
      }
    })
  }

  private createChildSession(
    parent: SessionRecord,
    profile: AgentProfile,
    input: CreateSubAgentInput,
    config: Oc2Config,
  ): SessionRecord {
    const model = parseModel(profile.defaultModel, config)
    return this.options.sessions.createSession({
      title: input.description ?? input.prompt.slice(0, 80),
      parentSessionId: parent.id,
      workspaceRoots: parent.workspaceRoots,
      providerId: model.providerId,
      modelId: model.modelId,
      agentId: profile.id,
      status: "idle",
    })
  }

  private createAgent(config: Oc2Config): MainAgent {
    const tools: ToolExecutor = createToolExecutor({
      registry: this.options.registry,
      scheduler: this.options.scheduler,
      events: this.options.events,
      config,
      permissions: this.options.permissions,
    })
    return new MainAgent({
      sessions: this.options.sessions,
      models: this.options.models,
      registry: this.options.registry,
      tools,
      memory: this.options.memory,
    })
  }
}

export const createSubAgentService = (options: SubAgentServiceOptions): SubAgentService => new SubAgentService(options)

function buildChildPrompt(input: CreateSubAgentInput): string {
  if (!input.context) return input.prompt
  return `Context:\n${input.context}\n\nTask:\n${input.prompt}`
}

function parseModel(value: string | undefined, config: Oc2Config): { providerId: string; modelId: string } {
  if (!value) return { providerId: config.model.provider, modelId: config.model.model }
  const [providerId, ...modelParts] = value.split("/")
  return { providerId: providerId || config.model.provider, modelId: modelParts.join("/") || config.model.model }
}

function toSubAgentResult(
  input: RunSubAgentInput,
  subagentId: string,
  sessionId: string,
  background: boolean,
  result: MainAgentRunResult,
  taskId?: string,
): SubAgentRunResult {
  return {
    subagentId,
    sessionId,
    parentSessionId: input.parentSessionId,
    agentId: input.agentId,
    taskId,
    background,
    status: result.status,
    text: result.text,
    toolCalls: result.toolCalls,
    errors: result.errors,
  }
}

function invalidSubAgent(message: string): RuntimeError {
  return new RuntimeError({ code: "invalid_task", message, recoverable: true, kind: "subagent" })
}

function cancelledSubAgent(reason: unknown): RuntimeError {
  return new RuntimeError({
    code: "cancelled",
    message: typeof reason === "string" ? reason : "Parent task was cancelled",
    recoverable: true,
    kind: "subagent",
  })
}

function failedSubAgentResult(
  input: RunSubAgentInput,
  subagentId: string,
  sessionId: string,
  agentId: string,
  taskId: string | undefined,
  error: RuntimeError,
): SubAgentRunResult {
  return {
    subagentId,
    sessionId,
    parentSessionId: input.parentSessionId,
    agentId,
    taskId,
    background: input.background ?? false,
    status: "failed",
    text: "",
    toolCalls: [],
    errors: [error.toJSON()],
  }
}
