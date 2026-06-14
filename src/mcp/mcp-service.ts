import type { Oc2Config } from "../config/schema"
import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import { redactText, redactValue } from "../logging/redaction"
import type { McpSnapshotRepository } from "../persistence/repositories/mcp"
import type { TaskScheduler } from "../scheduler/scheduler"
import type { ToolRegistry } from "../tools/registry"
import {
  createMcpClient,
  McpAuthRequiredError,
  type McpClient,
  type McpClientFactory,
  type McpHostHandlers,
} from "./client"
import { listMcpServers, type ResolvedMcpServerConfig } from "./config"
import { requiresDeferredOAuth } from "./auth"
import { MCP_PROTOCOL_VERSION } from "./protocol"
import { materializeMcpTool } from "./tools"
import { createResourceListTool, createResourceReadTool, createPromptListTool, createPromptGetTool } from "./meta-tools"
import { createMcpStatus, type McpServerStatus, type McpToolInfo } from "./status"

export interface McpServiceOptions {
  readonly config: Pick<Oc2Config, "mcp" | "runtime">
  readonly registry: ToolRegistry
  readonly events?: RuntimeEventBus<unknown>
  readonly scheduler?: TaskScheduler
  readonly snapshots?: McpSnapshotRepository
  readonly clientFactory?: McpClientFactory
  readonly hostHandlers?: McpHostHandlers
}

export interface McpService {
  list(): readonly McpServerStatus[]
  startEnabled(signal?: AbortSignal): Promise<readonly McpServerStatus[]>
  test(serverId: string, signal?: AbortSignal): Promise<McpServerStatus>
  close(): Promise<void>
}

interface ServerState {
  readonly server: ResolvedMcpServerConfig
  client?: McpClient
  toolNames: string[]
  status: McpServerStatus
}

/** Builds tool config entries so discovered MCP tools reuse the normal permission service. */
export function createMcpToolConfigEntries(
  config: Pick<Oc2Config, "mcp">,
  statuses: readonly McpServerStatus[],
): Oc2Config["tools"] {
  const servers = new Map(listMcpServers(config).map((server) => [server.id, server]))
  const tools: Oc2Config["tools"] = {}
  for (const status of statuses) {
    const server = servers.get(status.serverId)
    if (!server) continue
    for (const name of status.tools) {
      tools[name] = { enabled: server.enabled, permissions: server.toolPermissions }
    }
  }
  return tools
}

/** Manages MCP server lifecycle, status events, and namespaced tool registration. */
export function createMcpService(options: McpServiceOptions): McpService {
  const states = new Map<string, ServerState>()
  for (const server of listMcpServers(options.config)) {
    states.set(server.id, {
      server,
      toolNames: [],
      status: createMcpStatus(server.id, server.enabled ? "disabled" : "disabled"),
    })
  }

  const setStatus = (state: ServerState, status: McpServerStatus) => {
    const redacted = redactValue(status) as McpServerStatus
    state.status = redacted
    options.snapshots?.append({ serverId: state.server.id, status: redacted })
    options.events?.publish({
      type: "mcp.status",
      payload: {
        serverId: state.server.id,
        status: redacted.status,
        error: redacted.error,
        toolCount: redacted.toolCount,
        tools: redacted.tools,
        authRequired: redacted.status === "auth_required",
      },
    })
  }

  const refreshTools = async (state: ServerState, client: McpClient, signal: AbortSignal) => {
    const tools = await client.listTools(signal)
    registerTools(options.registry, state, client, tools)
    let resourceCount: number | undefined
    let promptCount: number | undefined
    try {
      const resources = await client.listResources(signal)
      resourceCount = resources.length
      registerMetaTools(options.registry, state, client)
    } catch {
      resourceCount = undefined
    }
    try {
      const prompts = await client.listPrompts(signal)
      promptCount = prompts.length
    } catch {
      promptCount = undefined
    }
    setStatus(state, {
      serverId: state.server.id,
      status: "connected",
      toolCount: tools.length,
      tools: state.toolNames,
      resourceCount,
      promptCount,
    })
  }

  const start = async (serverId: string, signal: AbortSignal): Promise<McpServerStatus> => {
    const state = states.get(serverId)
    if (!state)
      throw new RuntimeError({ code: "invalid_task", message: `MCP server not found: ${serverId}`, recoverable: true })
    if (!state.server.enabled) {
      setStatus(state, createMcpStatus(serverId, "disabled"))
      return state.status
    }
    if (requiresDeferredOAuth(state.server)) {
      setStatus(state, createMcpStatus(serverId, "auth_required"))
      return state.status
    }

    setStatus(state, createMcpStatus(serverId, "starting"))
    try {
      const client = await (options.clientFactory ?? createMcpClient)(state.server)
      state.client = client
      if (options.hostHandlers) {
        client.setHostHandlers(options.hostHandlers)
      }
      client.onToolsChanged(() => {
        const refreshController = new AbortController()
        void refreshTools(state, client, refreshController.signal).catch((error) =>
          setStatus(state, failedStatus(serverId, error)),
        )
      })
      await withTimeout(state.server.startupTimeoutMs, signal, async (timeoutSignal) => {
        const capabilities: Record<string, unknown> = {}
        if (options.hostHandlers?.rootsList) capabilities.roots = { listChanged: true }
        if (options.hostHandlers?.samplingCreateMessage) capabilities.sampling = {}
        if (options.hostHandlers?.elicitationCreate) capabilities.elicitation = {}
        await client.initialize(
          { protocolVersion: MCP_PROTOCOL_VERSION, capabilities, clientInfo: { name: "oc2" } },
          timeoutSignal,
        )
        await refreshTools(state, client, timeoutSignal)
      })
      return state.status
    } catch (error) {
      if (error instanceof McpAuthRequiredError) {
        setStatus(state, {
          ...createMcpStatus(serverId, "auth_required"),
          authUrl: error.metadataUrl,
        })
        return state.status
      }
      setStatus(state, failedStatus(serverId, error))
      return state.status
    }
  }

  return {
    list() {
      return [...states.values()].map((state) => state.status)
    },
    async startEnabled(signal = new AbortController().signal) {
      const statuses: McpServerStatus[] = []
      for (const state of states.values()) {
        if (!state.server.enabled) {
          setStatus(state, createMcpStatus(state.server.id, "disabled"))
          statuses.push(state.status)
          continue
        }
        statuses.push(await start(state.server.id, signal))
      }
      return statuses
    },
    async test(serverId, signal = new AbortController().signal) {
      return start(serverId, signal)
    },
    async close() {
      for (const state of states.values()) {
        for (const name of state.toolNames) options.registry.unregister(name)
        state.toolNames = []
        await state.client?.close()
      }
    },
  }
}

function registerTools(registry: ToolRegistry, state: ServerState, client: McpClient, tools: readonly McpToolInfo[]) {
  for (const name of state.toolNames) registry.unregister(name)
  state.toolNames = []
  for (const tool of tools) {
    const definition = materializeMcpTool({
      serverId: state.server.id,
      tool,
      client,
      timeoutMs: state.server.startupTimeoutMs,
    })
    registry.register(definition)
    state.toolNames.push(definition.name)
  }
}

function registerMetaTools(registry: ToolRegistry, state: ServerState, client: McpClient) {
  const definitions = [
    createResourceListTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
    createResourceReadTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
    createPromptListTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
    createPromptGetTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
  ]
  for (const def of definitions) {
    registry.register(def)
    state.toolNames.push(def.name)
  }
}

function failedStatus(serverId: string, error: unknown): McpServerStatus {
  const runtime = new RuntimeError({
    code: "task_failed",
    message: error instanceof Error ? error.message : String(error),
    recoverable: true,
    kind: "mcp",
  }).toJSON()
  return {
    serverId,
    status: "failed",
    toolCount: 0,
    tools: [],
    error: { ...runtime, message: redactText(runtime.message) },
  }
}

async function withTimeout<T>(
  timeoutMs: number,
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent.reason)
  parent.addEventListener("abort", onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error("MCP startup timed out")), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timeout)
    parent.removeEventListener("abort", onAbort)
  }
}
