import type { Oc2Config } from "../config/schema"
import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import type { TaskScheduler } from "../scheduler/scheduler"
import { boundToolOutput, type OutputBounds } from "./output"
import {
  assertToolPermission,
  createToolPermissionService,
  findDecision,
  type ToolPermissionService,
} from "./permissions"
import { ToolExecutionError, toolError, type ToolCall, type ToolContext, type ToolExecutionResult } from "./tool"
import type { ToolRegistry } from "./registry"

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry
  readonly scheduler?: TaskScheduler
  readonly events?: RuntimeEventBus<unknown>
  readonly config?: Pick<Oc2Config, "tools" | "runtime">
  readonly permissions?: ToolPermissionService
  readonly outputBounds?: OutputBounds
}

export interface ToolExecutor {
  execute(
    call: ToolCall,
    context: Omit<ToolContext, "callId" | "signal" | "sessionId"> & {
      readonly signal?: AbortSignal
      readonly sessionId?: string
    },
  ): Promise<ToolExecutionResult>
}

const createRuntimeErrorShape = (error: ToolExecutionError) =>
  new RuntimeError({
    code: "task_failed",
    message: error.message,
    recoverable: error.recoverable,
    details: error.details,
    kind: "tool",
  }).toJSON()

/** Coordinates validation, permissions, scheduling, execution, output bounding, and lifecycle events for tool calls. */
export const createToolExecutor = (options: ToolExecutorOptions): ToolExecutor => {
  const defaultTimeoutMs = options.config?.runtime.defaultTimeoutMs

  const runTool = async (call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> => {
    const tool = options.registry.get(call.name)
    if (!tool) return options.registry.unknown(call)
    if (options.config?.tools[tool.name]?.enabled === false) {
      return toolError(
        call,
        new ToolExecutionError({ code: "tool_disabled", message: `Tool is disabled: ${tool.name}` }),
      )
    }

    const parsed = tool.inputSchema.safeParse(call.arguments)
    if (!parsed.success) {
      return toolError(
        call,
        new ToolExecutionError({
          code: "validation_failed",
          message: "Tool input validation failed",
          details: { issues: parsed.error.issues },
        }),
      )
    }

    if (tool.permission) {
      const request = {
        toolName: tool.name,
        action: tool.permission.action,
        resource: tool.permission.resource(parsed.data, context),
        callId: call.id,
        sessionId: call.sessionId,
      }
      try {
        const configRules = options.config?.tools[tool.name]?.permissions ?? []
        await assertToolPermission(
          createToolPermissionService({
            events: options.events,
            rules: configRules,
            resolver: options.permissions
              ? async (permissionRequest, signal) => options.permissions?.decide(permissionRequest, signal) ?? "deny"
              : undefined,
          }),
          request,
          context.signal,
        )
        // Configured ask rules use the injected permission service as the interactive resolver above.
        if (options.permissions && findDecision(configRules, request) !== "ask")
          await assertToolPermission(options.permissions, request, context.signal)
      } catch (error) {
        return toolError(
          call,
          error instanceof ToolExecutionError
            ? error
            : new ToolExecutionError({ code: "permission_failed", message: String(error) }),
        )
      }
    }

    try {
      const output = await tool.execute(parsed.data, context)
      const bounded = boundToolOutput(output, options.outputBounds)
      return {
        ok: true,
        callId: call.id,
        toolName: call.name,
        output: bounded.value,
        outputText: bounded.text,
        truncated: bounded.truncated,
      }
    } catch (error) {
      if (error instanceof ToolExecutionError) return toolError(call, error)
      return toolError(
        call,
        new ToolExecutionError({
          code: "tool_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        }),
      )
    }
  }

  return {
    async execute(call, context) {
      const tool = options.registry.get(call.name)
      const parentSignal = context.signal ?? new AbortController().signal
      const run = (signal: AbortSignal) =>
        runTool(call, { ...context, callId: call.id, sessionId: call.sessionId ?? context.sessionId, signal })

      if (!options.scheduler) {
        options.events?.publish({
          type: "tool.started",
          payload: { sessionId: call.sessionId ?? context.sessionId, toolName: call.name },
        })
        const result = await run(parentSignal)
        publishCompletion(options.events, result, call.sessionId ?? context.sessionId)
        return result
      }

      const handle = options.scheduler.schedule({
        id: call.id,
        kind: "tool",
        parent: parentSignal,
        timeoutMs: tool?.timeoutMs ?? defaultTimeoutMs,
        run: ({ signal }) => {
          options.events?.publish({
            type: "tool.started",
            payload: { sessionId: call.sessionId ?? context.sessionId, taskId: call.id, toolName: call.name },
          })
          return run(signal)
        },
      })
      const scheduled = await handle.result
      if (scheduled.error) {
        const error = {
          name: "ToolExecutionError" as const,
          code: scheduled.error.code,
          message: scheduled.error.message,
          recoverable: scheduled.error.recoverable,
          runtimeError: scheduled.error.toJSON(),
        }
        const result = toolError(call, error, scheduled.task.id)
        options.events?.publish({
          type: "tool.failed",
          payload: {
            sessionId: call.sessionId ?? context.sessionId,
            taskId: scheduled.task.id,
            toolName: call.name,
            error: scheduled.error.toJSON(),
          },
        })
        return result
      }

      const result =
        scheduled.value ??
        toolError(
          call,
          new ToolExecutionError({ code: "missing_result", message: "Tool task completed without a result" }),
          scheduled.task.id,
        )
      publishCompletion(options.events, result, call.sessionId ?? context.sessionId, scheduled.task.id)
      return result.ok ? { ...result, taskId: scheduled.task.id } : { ...result, taskId: scheduled.task.id }
    },
  }
}

/** Emits the public completion event shape for both direct and scheduled tool executions. */
const publishCompletion = (
  events: RuntimeEventBus<unknown> | undefined,
  result: ToolExecutionResult,
  sessionId?: string,
  taskId?: string,
) => {
  if (result.ok) {
    events?.publish({ type: "tool.completed", payload: { sessionId, taskId, toolName: result.toolName } })
    return
  }
  events?.publish({
    type: "tool.failed",
    payload: {
      sessionId,
      taskId,
      toolName: result.toolName,
      error: result.error.runtimeError ?? createRuntimeErrorShape(new ToolExecutionError(result.error)),
    },
  })
}
