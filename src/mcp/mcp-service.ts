import type { Oc2Config } from "../config/schema"
import type { RuntimeEventBus } from "../events/event-bus"
import { RuntimeError } from "../events/events"
import { REDACTED, redactText, redactValue } from "../logging/redaction"
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
import { createOAuthManager, type OAuthManager } from "./auth-manager"
import { MCP_PROTOCOL_VERSION, type McpPromptInfo } from "./protocol"
import { materializeMcpTool } from "./tools"
import { createResourceListTool, createResourceReadTool, createPromptListTool, createPromptGetTool } from "./meta-tools"
import { createMcpStatus, type McpAuthStateName, type McpServerStatus, type McpToolInfo } from "./status"

export interface McpServiceOptions {
  readonly config: Pick<Oc2Config, "mcp" | "runtime">
  readonly registry: ToolRegistry
  readonly dataDir?: string
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
  oauth?: OAuthManager
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
    const eventSafe = redactMcpStatusForEvents(redacted)
    options.snapshots?.append({ serverId: state.server.id, status: eventSafe })
    options.events?.publish({
      type: "mcp.status",
      payload: {
        serverId: state.server.id,
        status: eventSafe.status,
        error: eventSafe.error,
        toolCount: eventSafe.toolCount,
        tools: eventSafe.tools,
        resourceCount: eventSafe.resourceCount,
        promptCount: eventSafe.promptCount,
        authUrl: eventSafe.authUrl,
        authState: eventSafe.authState,
        authRequired:
          eventSafe.status === "auth_required" ||
          eventSafe.authState === "auth_required" ||
          eventSafe.authState === "callback_pending" ||
          eventSafe.authState === "refresh_failed",
      },
    })
  }

  const refreshTools = async (state: ServerState, client: McpClient, signal: AbortSignal, authState?: McpAuthStateName) => {
    const tools = await client.listTools(signal)
    registerTools(options.registry, state, client, tools)
    let resourceCount: number | undefined
    let promptCount: number | undefined
    let prompts: readonly McpPromptInfo[] | undefined
    try {
      const resources = await client.listResources(signal)
      resourceCount = resources.length
    } catch {
      resourceCount = undefined
    }
    try {
      prompts = await client.listPrompts(signal)
      promptCount = prompts.length
    } catch {
      promptCount = undefined
    }
    registerMetaTools(options.registry, state, client, prompts)
    setStatus(state, {
      serverId: state.server.id,
      status: "connected",
      toolCount: tools.length,
      tools: state.toolNames,
      resourceCount,
      promptCount,
      authState,
    })
  }

  const wireListChanged = (state: ServerState, client: McpClient) => {
    client.onToolsChanged(() => {
      const refreshController = new AbortController()
      void refreshTools(state, client, refreshController.signal, state.status.authState).catch((error) =>
        setStatus(state, failedStatus(state.server.id, error)),
      )
    })
    client.onListChanged("resources", () => {
      setStatus(state, { ...state.status, resourceCount: undefined })
    })
    client.onListChanged("prompts", () => {
      setStatus(state, { ...state.status, promptCount: undefined })
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
      if (options.dataDir) {
        const oauth = getOAuthManager(state)
        const oauthStatus = await oauth.initFlow(signal)
        if (oauthStatus.state === "authenticated") {
          // OAuth is already authenticated - create client with token provider
          await connect(state, signal, oauth, "authenticated")
          return state.status
        }
        if (oauthStatus.state === "callback_pending") {
          setStatus(state, {
            ...createMcpStatus(serverId, "auth_required"),
            authUrl: oauthStatus.authUrl,
            authState: "callback_pending",
          })
          return state.status
        }
        if (oauthStatus.state === "refresh_failed") {
          setStatus(state, { ...createMcpStatus(serverId, "auth_required"), authState: "refresh_failed" })
          return state.status
        }
        setStatus(state, { ...createMcpStatus(serverId, "auth_required"), authState: "auth_required" })
        return state.status
      }
      setStatus(state, { ...createMcpStatus(serverId, "auth_required"), authState: "auth_required" })
      return state.status
    }

    setStatus(state, createMcpStatus(serverId, "starting"))
    try {
      const oauth = state.server.oauth?.enabled && options.dataDir ? getOAuthManager(state) : undefined
      await connect(state, signal, oauth, oauth ? "authenticated" : undefined)
      return state.status
    } catch (error) {
      if (error instanceof McpAuthRequiredError) {
        if (state.server.oauth?.enabled && options.dataDir) {
          const oauth = getOAuthManager(state)
          const oauthStatus = await oauth.initFlow(signal, error.metadataUrl)
          if (oauthStatus.state === "callback_pending") {
            setStatus(state, {
              ...createMcpStatus(serverId, "auth_required"),
              authUrl: oauthStatus.authUrl,
              authState: "callback_pending",
            })
            return state.status
          }
        }
        setStatus(state, {
          ...createMcpStatus(serverId, "auth_required"),
          authUrl: error.metadataUrl,
          authState: "auth_required",
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
        await state.oauth?.close()
      }
    },
  }

  function getOAuthManager(state: ServerState): OAuthManager {
    if (!options.dataDir) throw new Error("OAuth requires dataDir")
    state.oauth ??= createOAuthManager(state.server, options.dataDir)
    return state.oauth
  }

  async function connect(
    state: ServerState,
    signal: AbortSignal,
    oauth?: OAuthManager,
    authState?: McpAuthStateName,
  ): Promise<void> {
    const serverWithToken: ResolvedMcpServerConfig | undefined = oauth
      ? {
          ...state.server,
          tokenProvider: async (forceRefresh = false) => {
            try {
              if (forceRefresh) await oauth.refreshIfNeeded()
              return await oauth.getAuthHeaders()
            } catch {
              return {}
            }
          },
        }
      : undefined
    const client = await (options.clientFactory ?? createMcpClient)(serverWithToken ?? state.server)
    state.client = client
    if (options.hostHandlers) {
      client.setHostHandlers(options.hostHandlers)
    }
    wireListChanged(state, client)
    await withTimeout(state.server.startupTimeoutMs, signal, async (timeoutSignal) => {
      const capabilities: Record<string, unknown> = {}
      if (options.hostHandlers?.rootsList) capabilities.roots = { listChanged: true }
      if (options.hostHandlers?.samplingCreateMessage) capabilities.sampling = {}
      if (options.hostHandlers?.elicitationCreate) capabilities.elicitation = {}
      await client.initialize(
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities, clientInfo: { name: "oc2" } },
        timeoutSignal,
      )
      await refreshTools(state, client, timeoutSignal, authState)
    })
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

function registerMetaTools(
  registry: ToolRegistry,
  state: ServerState,
  client: McpClient,
  prompts?: readonly McpPromptInfo[],
) {
  const definitions = [
    createResourceListTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
    createResourceReadTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
    createPromptListTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs }),
    createPromptGetTool({ serverId: state.server.id, client, timeoutMs: state.server.startupTimeoutMs, prompts }),
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

function redactMcpStatusForEvents(status: McpServerStatus): McpServerStatus {
  return status.authUrl ? { ...status, authUrl: redactOAuthUrl(status.authUrl) } : status
}

function redactOAuthUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of ["state", "code", "code_challenge", "code_verifier"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, REDACTED)
    }
    return url.toString()
  } catch {
    return redactText(value).replace(/([?&](?:state|code|code_challenge|code_verifier)=)[^&\s]+/gi, `$1${REDACTED}`)
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
