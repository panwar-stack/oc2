import { z } from "zod"
import { RuntimeError } from "../events/events"
import { numberProperty, objectSchema, stringProperty } from "../tools/builtins/schema"
import { ToolExecutionError, type ToolContext, type ToolDefinition } from "../tools/tool"
import type { TeamService } from "./team-service"

export interface TeamToolOptions {
  readonly service: TeamService
}

const optionalTeamId = z.object({ teamId: z.string().min(1).optional() })
const createInput = z.object({ name: z.string().min(1), goal: z.string().min(1) })
const spawnInput = optionalTeamId.extend({
  name: z.string().min(1),
  agentId: z.string().min(1),
  rolePrompt: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  lifecycle: z.enum(["task", "daemon"]).optional(),
  daemonReportingCriteria: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
})
const sendInput = optionalTeamId.extend({ recipient: z.string().min(1), body: z.string().min(1) })
const broadcastInput = optionalTeamId.extend({ body: z.string().min(1) })
const getMessagesInput = optionalTeamId
const taskCreateInput = optionalTeamId.extend({
  description: z.string().min(1),
  assignee: z.string().min(1).optional(),
  dependencyIds: z.array(z.string().min(1)).optional(),
})
const taskClaimInput = z.object({ taskId: z.string().min(1), assignee: z.string().min(1) })
const taskUpdateInput = z.object({
  taskId: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
  assignee: z.string().min(1).optional(),
})
const taskListInput = optionalTeamId
const shutdownInput = optionalTeamId

/** Creates all PR #12 team tool definitions backed by one team service. */
export function createTeamTools(options: TeamToolOptions): readonly ToolDefinition[] {
  return [
    tool("team_create", "Create one active agent team for the current lead session.", createInput, {
      schema: objectSchema({ name: stringProperty("Team name"), goal: stringProperty("Team goal") }, ["name", "goal"]),
      action: "team.create",
      resource: () => "team",
      execute: (input, context) => options.service.create({ ...input, leadSessionId: requireSession(context, "team_create") }),
    }),
    tool("team_spawn", "Spawn a bounded teammate child session for a team assignment.", spawnInput, {
      schema: objectSchema(
        {
          teamId: stringProperty("Optional team id; defaults to active team"),
          name: stringProperty("Unique teammate name"),
          agentId: stringProperty("Configured subagent profile id"),
          rolePrompt: stringProperty("Assignment prompt"),
          dependsOn: { type: "array", items: { type: "string" } },
          lifecycle: { type: "string", enum: ["task", "daemon"] },
          daemonReportingCriteria: stringProperty("Required reporting criteria for daemon members"),
          timeoutMs: numberProperty("Optional teammate timeout in milliseconds"),
        },
        ["name", "agentId", "rolePrompt"],
      ),
      action: "team.spawn",
      resource: (input) => input.teamId ?? input.name,
      execute: (input, context) =>
        options.service.spawn({
          ...input,
          leadSessionId: requireSession(context, "team_spawn"),
          dependsOn: input.dependsOn,
          signal: context.signal,
        }),
    }),
    tool("team_send_message", "Send a mailbox message to a teammate or lead.", sendInput, {
      schema: objectSchema(
        { teamId: stringProperty("Optional team id"), recipient: stringProperty("Recipient name, session id, or lead"), body: stringProperty("Message body") },
        ["recipient", "body"],
      ),
      action: "team.message.send",
      resource: (input) => input.recipient,
      execute: (input, context) =>
        options.service.sendMessage({
          sessionId: requireSession(context, "team_send_message"),
          senderSessionId: requireSession(context, "team_send_message"),
          teamId: input.teamId,
          recipients: [input.recipient],
          body: input.body,
        }),
    }),
    tool("team_broadcast", "Broadcast a mailbox message to all team participants except the sender.", broadcastInput, {
      schema: objectSchema({ teamId: stringProperty("Optional team id"), body: stringProperty("Message body") }, ["body"]),
      action: "team.message.broadcast",
      resource: (input) => input.teamId ?? "team",
      execute: (input, context) =>
        options.service.broadcast({
          sessionId: requireSession(context, "team_broadcast"),
          senderSessionId: requireSession(context, "team_broadcast"),
          teamId: input.teamId,
          body: input.body,
        }),
    }),
    tool("team_get_messages", "Deliver pending mailbox messages for the current session.", getMessagesInput, {
      schema: objectSchema({ teamId: stringProperty("Optional team id") }),
      action: "team.message.get",
      resource: (input) => input.teamId ?? "team",
      execute: (input, context) =>
        options.service.getMessages({
          sessionId: requireSession(context, "team_get_messages"),
          teamId: input.teamId,
        }),
    }),
    tool("team_task_create", "Create a shared team task with optional dependencies.", taskCreateInput, {
      schema: objectSchema(
        {
          teamId: stringProperty("Optional team id"),
          description: stringProperty("Task description"),
          assignee: stringProperty("Optional assignee"),
          dependencyIds: { type: "array", items: { type: "string" } },
        },
        ["description"],
      ),
      action: "team.task.create",
      resource: (input) => input.teamId ?? "team",
      execute: (input, context) => options.service.createTask({ ...input, sessionId: requireSession(context, "team_task_create") }),
    }),
    tool("team_task_claim", "Transactionally claim a pending shared team task.", taskClaimInput, {
      schema: objectSchema({ taskId: stringProperty("Task id"), assignee: stringProperty("Claiming member") }, ["taskId", "assignee"]),
      action: "team.task.claim",
      resource: (input) => input.taskId,
      execute: (input, context) => options.service.claimTask({ ...input, sessionId: requireSession(context, "team_task_claim") }),
    }),
    tool("team_task_update", "Update a shared team task status or assignee.", taskUpdateInput, {
      schema: objectSchema(
        {
          taskId: stringProperty("Task id"),
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
          assignee: stringProperty("Optional assignee"),
        },
        ["taskId"],
      ),
      action: "team.task.update",
      resource: (input) => input.taskId,
      execute: (input, context) => options.service.updateTask({ ...input, sessionId: requireSession(context, "team_task_update") }),
    }),
    tool("team_task_list", "List shared team tasks for the active team.", taskListInput, {
      schema: objectSchema({ teamId: stringProperty("Optional team id") }),
      action: "team.task.list",
      resource: (input) => input.teamId ?? "team",
      execute: (input, context) => options.service.listTasks({ ...input, sessionId: requireSession(context, "team_task_list") }),
    }),
    tool("team_shutdown", "Shutdown the active team and cancel active or daemon members.", shutdownInput, {
      schema: objectSchema({ teamId: stringProperty("Optional team id") }),
      action: "team.shutdown",
      resource: (input) => input.teamId ?? "team",
      execute: (input, context) => options.service.shutdown({ ...input, leadSessionId: requireSession(context, "team_shutdown") }),
    }),
  ]
}

function tool<TInput, TOutput>(
  name: string,
  description: string,
  inputSchema: z.ZodType<TInput>,
  options: {
    readonly schema: Record<string, unknown>
    readonly action: string
    readonly resource: (input: TInput, context: ToolContext) => string
    execute(input: TInput, context: ToolContext): Promise<TOutput> | TOutput
  },
): ToolDefinition<TInput, TOutput> {
  return {
    name,
    description,
    inputSchema,
    modelInputSchema: options.schema,
    permission: { action: options.action, resource: options.resource },
    async execute(input, context) {
      try {
        return await options.execute(input, context)
      } catch (error) {
        if (error instanceof RuntimeError) {
          throw new ToolExecutionError({ code: "team_failed", message: error.message, runtimeError: error.toJSON() })
        }
        throw error
      }
    },
  }
}

function requireSession(context: ToolContext, toolName: string): string {
  if (!context.sessionId) throw new ToolExecutionError({ code: "missing_session", message: `${toolName} requires a session` })
  return context.sessionId
}
