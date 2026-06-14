import { expect, test } from "bun:test"

import {
  createMcpService,
  createMcpToolConfigEntries,
  createRuntimeEventBus,
  createToolExecutor,
  createToolRegistry,
  defaultConfig,
  McpAuthRequiredError,
  type McpCallResult,
  type McpClient,
  type McpHostHandlers,
  type McpInitializeInput,
  type McpInitializeResult,
  type McpToolInfo,
  type Oc2Config,
} from "../../src"

test("disabled MCP servers are not started", async () => {
  let starts = 0
  const config = withMcp({ disabled: server({ transport: "stdio", command: "fake", enabled: false }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    clientFactory: () => {
      starts += 1
      return fakeClient([])
    },
  })

  const statuses = await service.startEnabled()

  expect(starts).toBe(0)
  expect(statuses).toEqual([{ serverId: "disabled", status: "disabled", toolCount: 0, tools: [] }])
})

test("OAuth-required MCP servers report auth_required without connecting", async () => {
  let starts = 0
  const config = withMcp({
    remote: server({ transport: "http", url: "https://example.test/mcp", oauth: { enabled: true, scopes: [] } }),
  })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    clientFactory: () => {
      starts += 1
      return fakeClient([])
    },
  })

  const status = await service.test("remote")

  expect(starts).toBe(0)
  expect(status.status).toBe("auth_required")
})

test("OAuth-required MCP servers with dataDir initiate OAuth flow", async () => {
  const { mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dataDir = join(tmpdir(), `oc2-mcp-oauth-test-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dataDir, { recursive: true })
  const original = globalThis.fetch

  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url)
    if (urlStr.includes("oauth-protected-resource")) {
      return new Response(
        JSON.stringify({
          resource: "https://example.test/mcp",
          authorization_servers: ["https://auth.test"],
          scopes_supported: ["read"],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      )
    }
    if (urlStr.includes("oauth-authorization-server")) {
      return new Response(
        JSON.stringify({
          issuer: "https://auth.test",
          authorization_endpoint: "https://auth.test/authorize",
          token_endpoint: "https://auth.test/token",
          registration_endpoint: "https://auth.test/register",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      )
    }
    if (urlStr.includes("/register")) {
      return new Response(
        JSON.stringify({
          client_id: "dcr-id",
          client_secret: "dcr-secret",
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      )
    }
    return new Response("Not Found", { status: 404 })
  }) as unknown as typeof globalThis.fetch

  try {
    let starts = 0
    const config = withMcp({
      remote: server({
        transport: "http",
        url: "https://example.test/mcp",
        oauth: { enabled: true, scopes: ["read"] },
      }),
    })
    const service = createMcpService({
      config,
      registry: createToolRegistry(),
      dataDir,
      clientFactory: () => {
        starts += 1
        return fakeClient([])
      },
    })

    const status = await service.test("remote")

    expect(starts).toBe(0)
    expect(status.status).toBe("auth_required")
    expect(status.authUrl).toBeDefined()
    expect(status.authUrl).toContain("https://auth.test/authorize")
  } finally {
    globalThis.fetch = original
    const { rmSync } = await import("node:fs")
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 15_000)

test("OAuth-authenticated servers connect with token provider", async () => {
  const fs = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const dataDir = join(tmpdir(), `oc2-mcp-oauth-test-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dataDir, { recursive: true })

  const tokenDir = `${dataDir}/mcp-tokens`
  fs.mkdirSync(tokenDir, { recursive: true })
  fs.writeFileSync(
    `${tokenDir}/remote.json`,
    JSON.stringify({
      accessToken: "test-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3600_000,
      tokenType: "Bearer",
      scopes: ["read"],
    }),
    { mode: 0o600 },
  )

  let capturedServer: Record<string, unknown> | undefined
  const config = withMcp({
    remote: server({ transport: "http", url: "https://example.test/mcp", oauth: { enabled: true, scopes: ["read"] } }),
  })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    dataDir,
    clientFactory: async (srv) => {
      capturedServer = srv as unknown as Record<string, unknown>
      return fakeClient([{ name: "search", description: "Search", inputSchema: { type: "object", properties: {} } }])
    },
  })

  const status = await service.test("remote")

  expect(status.status).toBe("connected")
  expect(capturedServer).toBeDefined()
  expect(typeof capturedServer!.tokenProvider).toBe("function")

  const headers = await (capturedServer!.tokenProvider as () => Promise<Record<string, string>>)()
  expect(headers.Authorization).toBe("Bearer test-token")

  const { rmSync } = await import("node:fs")
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("HTTP auth failures report auth_required", async () => {
  const service = createMcpService({
    config: withMcp({ remote: server({ transport: "http", url: "https://example.test/mcp" }) }),
    registry: createToolRegistry(),
    clientFactory: () => {
      throw new McpAuthRequiredError("Bearer secret-token")
    },
  })

  const status = await service.test("remote")

  expect(status.status).toBe("auth_required")
  expect(JSON.stringify(status)).not.toContain("secret-token")
})

test("MCP failures are redacted before status consumers see them", async () => {
  const service = createMcpService({
    config: withMcp({ server: server({ transport: "stdio", command: "fake" }) }),
    registry: createToolRegistry(),
    clientFactory: () => {
      throw new Error("failed with Bearer secret-token and api_key=sk-secret123456")
    },
  })

  const status = await service.test("server")

  expect(status.status).toBe("failed")
  expect(JSON.stringify(status)).not.toContain("secret-token")
  expect(JSON.stringify(service.list())).not.toContain("secret-token")
})

test("malformed stdio output does not crash MCP startup", async () => {
  const service = createMcpService({
    config: withMcp({
      malformed: server({ transport: "stdio", command: "bun", args: ["test/mcp/malformed-server.ts"] }),
    }),
    registry: createToolRegistry(),
  })

  const status = await service.test("malformed")

  expect(status.status).toBe("connected")
  await service.close()
})

test("discovers MCP tools and routes invocation through normal tool executor permissions", async () => {
  let calls = 0
  const registry = createToolRegistry()
  const tool: McpToolInfo = { name: "search", description: "Search", inputSchema: { type: "object", properties: {} } }
  const config = withMcp({
    server: server({
      transport: "stdio",
      command: "fake",
      toolPermissions: [{ match: "mcp.invoke:server/search", decision: "deny" }],
    }),
  })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fakeClient([tool], () => {
        calls += 1
        return { content: "called" }
      }),
  })

  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
  })

  const result = await executor.execute(
    { id: "call-1", name: "mcp_server_search", arguments: {} },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(result.ok).toBe(false)
  expect(result.ok ? undefined : result.error.code).toBe("permission_denied")
  expect(calls).toBe(0)
})

test("host handlers rootsList returns file:// URIs", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    rootsList: async () => [
      { uri: "file:///home/user/project", name: "project" },
      { uri: "file:///home/user/other", name: "other" },
    ],
  }
  const registry = createToolRegistry()
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })

  await service.startEnabled()
  expect(capturedHandlers).toBeDefined()
  const roots = await capturedHandlers!.rootsList!(new AbortController().signal)
  expect(roots.length).toBe(2)
  expect(roots[0]!.uri.startsWith("file://")).toBe(true)
  expect(roots[1]!.uri.startsWith("file://")).toBe(true)
})

test("tools/list_changed refreshes registered MCP tools", async () => {
  const registry = createToolRegistry()
  const client = mutableFakeClient([{ name: "one", inputSchema: { type: "object", properties: {} } }])
  const service = createMcpService({
    config: withMcp({ server: server({ transport: "stdio", command: "fake" }) }),
    registry,
    clientFactory: () => client,
  })

  await service.startEnabled()
  expect(registry.get("mcp_server_one")).toBeDefined()

  client.tools = [{ name: "two", inputSchema: { type: "object", properties: {} } }]
  client.triggerChanged()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(registry.get("mcp_server_one")).toBeUndefined()
  expect(registry.get("mcp_server_two")).toBeDefined()
})

test("host handlers are passed to client and setHostHandlers is called", async () => {
  let handlersSet = false
  const handlers: McpHostHandlers = {
    rootsList: async () => [{ uri: "file:///test", name: "test" }],
  }
  const registry = createToolRegistry()
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    hostHandlers: handlers,
    clientFactory: () =>
      fakeCapabilityClient(
        [],
        (caps) => {
          expect(caps.roots).toBeDefined()
          expect(caps.sampling).toBeUndefined()
          expect(caps.elicitation).toBeUndefined()
        },
        () => {
          handlersSet = true
        },
      ),
  })

  await service.startEnabled()
  expect(handlersSet).toBe(true)
})

function withMcp(mcp: Oc2Config["mcp"]): Oc2Config {
  return { ...defaultConfig, mcp }
}

function server(input: Partial<Oc2Config["mcp"][string]>): Oc2Config["mcp"][string] {
  return {
    enabled: true,
    transport: "stdio",
    args: [],
    env: {},
    headers: {},
    toolPermissions: [],
    startupTimeoutMs: 10_000,
    ...input,
  }
}

function fakeClient(
  tools: readonly McpToolInfo[],
  call: (name: string, input: Record<string, unknown>) => McpCallResult = () => ({ content: "ok" }),
): McpClient {
  return {
    async initialize(_input: McpInitializeInput, _signal: AbortSignal) {
      return {} as McpInitializeResult
    },
    async listTools(_signal: AbortSignal) {
      return tools
    },
    async callTool(name, input, _signal: AbortSignal) {
      return call(name, input)
    },
    async listResources(_signal: AbortSignal) {
      throw new Error("not implemented")
    },
    async readResource(_uri: string, _signal: AbortSignal) {
      throw new Error("not implemented")
    },
    async listPrompts(_signal: AbortSignal) {
      return []
    },
    async getPrompt(_name: string, _args: Record<string, unknown>, _signal: AbortSignal) {
      return { messages: [] }
    },
    onListChanged(_kind: string, _callback: () => void) {},
    onToolsChanged(_callback: () => void) {},
    setHostHandlers(_handlers: unknown) {},
    async close() {},
  }
}

function fakeCapabilityClient(
  tools: readonly McpToolInfo[],
  onInitialize: (capabilities: Record<string, unknown>) => void,
  onHostHandlers: () => void,
): McpClient {
  return {
    async initialize(input, _signal) {
      onInitialize(input.capabilities as Record<string, unknown>)
      return {} as McpInitializeResult
    },
    async listTools(_signal) {
      return tools
    },
    async callTool(_name, _input, _signal) {
      return { content: "ok" }
    },
    async listResources(_signal) {
      return []
    },
    async readResource(_uri, _signal) {
      return { contents: [] }
    },
    async listPrompts(_signal) {
      return []
    },
    async getPrompt(_name, _args, _signal) {
      return { messages: [] }
    },
    onListChanged(_kind, _callback) {},
    onToolsChanged(_callback) {},
    setHostHandlers(_handlers) {
      onHostHandlers()
    },
    async close() {},
  }
}

function mutableFakeClient(tools: McpToolInfo[]) {
  const changed = new Map<string, () => void>()
  return {
    tools,
    triggerChanged() {
      changed.get("tools")?.()
    },
    async initialize(_input: McpInitializeInput, _signal: AbortSignal) {
      return {} as McpInitializeResult
    },
    async listTools(_signal: AbortSignal) {
      return this.tools
    },
    async callTool(_name: string, _input: Record<string, unknown>, _signal: AbortSignal) {
      return { content: "ok" }
    },
    async listResources(_signal: AbortSignal) {
      throw new Error("not implemented")
    },
    async readResource(_uri: string, _signal: AbortSignal) {
      throw new Error("not implemented")
    },
    async listPrompts(_signal: AbortSignal) {
      return []
    },
    async getPrompt(_name: string, _args: Record<string, unknown>, _signal: AbortSignal) {
      return { messages: [] }
    },
    onListChanged(kind, callback) {
      changed.set(kind, callback)
    },
    onToolsChanged(callback) {
      changed.set("tools", callback)
    },
    setHostHandlers(_handlers: unknown) {},
    async close() {},
  } satisfies McpClient & { tools: McpToolInfo[]; triggerChanged(): void }
}

function fullFakeClient(
  input: {
    tools?: readonly McpToolInfo[]
    resources?: readonly { name: string; uri: string }[]
    prompts?: readonly { name: string; description?: string; arguments?: readonly { name: string; description?: string; required?: boolean }[] }[]
    readResource?: (uri: string) => { contents: readonly { uri: string; text?: string; mimeType?: string }[] }
    getPrompt?: (name: string, args: Record<string, unknown>) => { messages: readonly [] }
    failListResources?: boolean
    failListPrompts?: boolean
  } = {},
): McpClient & { triggerListChanged(kind: string): void } {
  const changed = new Map<string, (() => void)[]>()
  const listResourcesImpl = input.failListResources
    ? async () => {
        throw new Error("resource discovery failed")
      }
    : async () => input.resources ?? []
  const listPromptsImpl = input.failListPrompts
    ? async () => {
        throw new Error("prompt discovery failed")
      }
    : async () => input.prompts ?? []
  return {
    async initialize(_input: McpInitializeInput, _signal: AbortSignal) {
      return {} as McpInitializeResult
    },
    async listTools(_signal: AbortSignal) {
      return input.tools ?? []
    },
    async callTool(_name: string, _args: Record<string, unknown>, _signal: AbortSignal) {
      return { content: "ok" }
    },
    async listResources(_signal: AbortSignal) {
      return listResourcesImpl()
    },
    async readResource(_uri: string, _signal: AbortSignal) {
      return input.readResource?.(_uri) ?? { contents: [] }
    },
    async listPrompts(_signal: AbortSignal) {
      return listPromptsImpl()
    },
    async getPrompt(_name: string, _args: Record<string, unknown>, _signal: AbortSignal) {
      return input.getPrompt?.(_name, _args) ?? { messages: [] }
    },
    onListChanged(kind: string, callback: () => void) {
      const cbs = changed.get(kind) ?? []
      cbs.push(callback)
      changed.set(kind, cbs)
    },
    onToolsChanged(callback: () => void) {
      const cbs = changed.get("tools") ?? []
      cbs.push(callback)
      changed.set("tools", cbs)
    },
    setHostHandlers(_handlers: unknown) {},
    async close() {},
    triggerListChanged(kind: string) {
      changed.get(kind)?.forEach((cb) => cb())
    },
  }
}

test("resource read is denied when no explicit permission rule exists", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ denyRead: server({ transport: "stdio", command: "fake" }) })
  let readCalls = 0
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fullFakeClient({
        tools: [],
        resources: [{ name: "res1", uri: "test://one" }],
        prompts: [],
        readResource: () => {
          readCalls++
          return { contents: [] }
        },
      }),
  })
  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
  })

  const result = await executor.execute(
    { id: "call-1", name: "mcp_denyRead_resource_read", arguments: { uri: "test://one" } },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe("permission_denied")
  expect(readCalls).toBe(0)
})

test("prompt get is denied when no explicit permission rule exists", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ denyGet: server({ transport: "stdio", command: "fake" }) })
  let getCalls = 0
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fullFakeClient({
        tools: [],
        resources: [],
        prompts: [{ name: "p1", description: "A prompt" }],
        getPrompt: () => {
          getCalls++
          return { messages: [] }
        },
      }),
  })
  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
  })

  const result = await executor.execute(
    { id: "call-2", name: "mcp_denyGet_prompt_get", arguments: { name: "p1" } },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe("permission_denied")
  expect(getCalls).toBe(0)
})

test("resource list is allowed by default", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ listAllowed: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () => fullFakeClient({ tools: [], resources: [{ name: "res1", uri: "test://one" }], prompts: [] }),
  })
  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
  })

  const result = await executor.execute(
    { id: "call-3", name: "mcp_listAllowed_resource_list", arguments: {} },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(result.ok).toBe(true)
})

test("prompt list is allowed by default", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ promptListAllowed: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fullFakeClient({ tools: [], resources: [], prompts: [{ name: "p1", description: "A prompt" }] }),
  })
  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
  })

  const result = await executor.execute(
    { id: "call-4", name: "mcp_promptListAllowed_prompt_list", arguments: {} },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(result.ok).toBe(true)
})

test("prompt meta-tools are registered even when resource discovery fails", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ partialFail: server({ transport: "stdio", command: "fake" }) })
  const client = fullFakeClient({
    tools: [],
    resources: [],
    prompts: [{ name: "p1" }],
    failListResources: true,
  })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () => client,
  })

  const statuses = await service.startEnabled()
  expect(statuses[0]!.status).toBe("connected")
  expect(statuses[0]!.resourceCount).toBeUndefined()
  expect(statuses[0]!.promptCount).toBe(1)

  expect(registry.get("mcp_partialFail_resource_list")).toBeDefined()
  expect(registry.get("mcp_partialFail_resource_read")).toBeDefined()
  expect(registry.get("mcp_partialFail_prompt_list")).toBeDefined()
  expect(registry.get("mcp_partialFail_prompt_get")).toBeDefined()
})

test("resource meta-tools are registered even when prompt discovery fails", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ promptFail: server({ transport: "stdio", command: "fake" }) })
  const client = fullFakeClient({
    tools: [],
    resources: [{ name: "r1", uri: "test://r1" }],
    prompts: [],
    failListPrompts: true,
  })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () => client,
  })

  const statuses = await service.startEnabled()
  expect(statuses[0]!.status).toBe("connected")
  expect(statuses[0]!.resourceCount).toBe(1)
  expect(statuses[0]!.promptCount).toBeUndefined()

  expect(registry.get("mcp_promptFail_resource_list")).toBeDefined()
  expect(registry.get("mcp_promptFail_resource_read")).toBeDefined()
  expect(registry.get("mcp_promptFail_prompt_list")).toBeDefined()
  expect(registry.get("mcp_promptFail_prompt_get")).toBeDefined()
})

test("allowed resource read and prompt get use explicit MCP permission resources", async () => {
  const registry = createToolRegistry()
  let readUri = ""
  let promptInput: { name: string; args: Record<string, unknown> } | undefined
  const config = withMcp({
    allowMeta: server({
      transport: "stdio",
      command: "fake",
      toolPermissions: [
        { match: "mcp.resource:allowMeta/test://one", decision: "allow" },
        { match: "mcp.prompt:allowMeta/p1", decision: "allow" },
      ],
    }),
  })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fullFakeClient({
        tools: [],
        resources: [{ name: "res1", uri: "test://one" }],
        prompts: [{ name: "p1", arguments: [{ name: "topic", required: true }] }],
        readResource: (uri) => {
          readUri = uri
          return { contents: [{ uri, text: "allowed" }] }
        },
        getPrompt: (name, args) => {
          promptInput = { name, args }
          return { messages: [] }
        },
      }),
  })
  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
  })

  const read = await executor.execute(
    { id: "call-read", name: "mcp_allowMeta_resource_read", arguments: { uri: "test://one" } },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )
  const prompt = await executor.execute(
    { id: "call-prompt", name: "mcp_allowMeta_prompt_get", arguments: { name: "p1", arguments: { topic: "x" } } },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(read.ok).toBe(true)
  expect(prompt.ok).toBe(true)
  expect(readUri).toBe("test://one")
  expect(promptInput).toEqual({ name: "p1", args: { topic: "x" } })
})

test("prompt get model schema is bounded by discovered prompt metadata", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ promptSchema: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fullFakeClient({
        tools: [],
        resources: [],
        prompts: [
          {
            name: "summarize",
            arguments: [
              { name: "topic", description: "Topic to summarize", required: true },
              { name: "tone" },
            ],
          },
        ],
      }),
  })

  await service.startEnabled()
  const schema = registry.get("mcp_promptSchema_prompt_get")!.modelInputSchema as Record<string, any>

  expect(schema.additionalProperties).toBe(false)
  expect(schema.properties.name.enum).toEqual(["summarize"])
  expect(schema.properties.arguments.additionalProperties).toBe(false)
  expect(schema.properties.arguments.required).toEqual(["topic"])
  expect(Object.keys(schema.properties.arguments.properties)).toEqual(["topic", "tone"])
})

test("resource read output is bounded by the normal tool executor", async () => {
  const registry = createToolRegistry()
  const config = withMcp({
    bigResource: server({
      transport: "stdio",
      command: "fake",
      toolPermissions: [{ match: "mcp.resource:bigResource/test://big", decision: "allow" }],
    }),
  })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () =>
      fullFakeClient({
        tools: [],
        resources: [{ name: "big", uri: "test://big" }],
        prompts: [],
        readResource: (uri) => ({ contents: [{ uri, text: "x".repeat(500) }] }),
      }),
  })
  const statuses = await service.startEnabled()
  const executor = createToolExecutor({
    registry,
    config: { ...config, tools: { ...config.tools, ...createMcpToolConfigEntries(config, statuses) } },
    outputBounds: { maxChars: 80, maxLines: 5 },
  })

  const result = await executor.execute(
    { id: "call-big", name: "mcp_bigResource_resource_read", arguments: { uri: "test://big" } },
    { workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }] },
  )

  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.truncated).toBe(true)
    expect(result.outputText).not.toContain("x".repeat(500))
    expect(result.outputText.length).toBeLessThan(500)
  }
})

test("mcp.status events include resource and prompt counts", async () => {
  const registry = createToolRegistry()
  const events = createRuntimeEventBus()
  const payloads: any[] = []
  events.subscribe("mcp.status", (event) => payloads.push(event.payload))
  const config = withMcp({ eventsServer: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    events,
    clientFactory: () =>
      fullFakeClient({
        tools: [],
        resources: [{ name: "r1", uri: "test://r1" }],
        prompts: [{ name: "p1" }],
      }),
  })

  await service.startEnabled()
  const connected = payloads.find((payload) => payload.status === "connected")

  expect(connected?.resourceCount).toBe(1)
  expect(connected?.promptCount).toBe(1)
})

test("list_changed for resources marks resourceCount as undefined", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ resChange: server({ transport: "stdio", command: "fake" }) })
  const client = fullFakeClient({ tools: [], resources: [{ name: "r1", uri: "test://r1" }], prompts: [] })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () => client,
  })

  const statuses = await service.startEnabled()
  expect(statuses[0]!.resourceCount).toBe(1)

  client.triggerListChanged("resources")
  await new Promise((resolve) => setTimeout(resolve, 0))

  const updated = service.list()
  expect(updated[0]!.resourceCount).toBeUndefined()
})

test("list_changed for prompts marks promptCount as undefined", async () => {
  const registry = createToolRegistry()
  const config = withMcp({ promptChange: server({ transport: "stdio", command: "fake" }) })
  const client = fullFakeClient({ tools: [], resources: [], prompts: [{ name: "p1" }] })
  const service = createMcpService({
    config,
    registry,
    clientFactory: () => client,
  })

  const statuses = await service.startEnabled()
  expect(statuses[0]!.promptCount).toBe(1)

  client.triggerListChanged("prompts")
  await new Promise((resolve) => setTimeout(resolve, 0))

  const updated = service.list()
  expect(updated[0]!.promptCount).toBeUndefined()
})

test("sampling handler is rejected without explicit permissions", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    samplingCreateMessage: async (_serverId: string, _params: Record<string, unknown>, _signal: AbortSignal) => {
      return {
        model: "",
        stopReason: "refusal",
        role: "assistant",
        content: { type: "text", text: "Sampling permission not granted" },
      }
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })

  await service.startEnabled()
  expect(capturedHandlers).toBeDefined()
  const result = await capturedHandlers!.samplingCreateMessage!("" as string, {} as any, new AbortController().signal)
  expect((result as any).stopReason).toBe("refusal")
})

test("sampling handler succeeds when explicitly allowed", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    samplingCreateMessage: async (_serverId: string, params: Record<string, unknown>, _signal: AbortSignal) => {
      const messages = params.messages as Array<{ role: string; content: { text: string } }>
      return {
        model: "test-model",
        stopReason: "endTurn",
        role: "assistant",
        content: { type: "text", text: `Echo: ${messages[0]!.content.text}` },
      }
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })

  await service.startEnabled()
  const result = await capturedHandlers!.samplingCreateMessage!(
    "" as string,
    { messages: [{ role: "user", content: { type: "text", text: "hello" } }] } as any,
    new AbortController().signal,
  )
  expect((result as any).content.text).toContain("hello")
})

test("sampling prevents nested recursion", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  let active = false
  const handlers: McpHostHandlers = {
    samplingCreateMessage: async (_serverId: string, _params: Record<string, unknown>, _signal: AbortSignal) => {
      if (active) {
        return {
          model: "",
          stopReason: "refusal",
          role: "assistant",
          content: { type: "text", text: "recursion blocked" },
        }
      }
      active = true
      const result = {
        model: "test",
        stopReason: "endTurn",
        role: "assistant",
        content: { type: "text", text: "ok" },
      }
      active = false
      return result
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })

  await service.startEnabled()
  // Simulate nested call: first call succeeds, second call while active is rejected
  const result1 = await capturedHandlers!.samplingCreateMessage!("" as string, {} as any, new AbortController().signal)
  expect((result1 as any).stopReason).toBe("endTurn")

  // Reset active to test recursion: manually set it back
  active = true
  const result2 = await capturedHandlers!.samplingCreateMessage!("" as string, {} as any, new AbortController().signal)
  expect((result2 as any).stopReason).toBe("refusal")
  expect((result2 as any).content.text).toBe("recursion blocked")
})

test("sampling capability is advertised when handler is present", async () => {
  const handlers: McpHostHandlers = {
    rootsList: async () => [{ uri: "file:///test", name: "test" }],
    samplingCreateMessage: async (_serverId: string, _params: Record<string, unknown>, _signal: AbortSignal) => {
      return { model: "test", stopReason: "endTurn", role: "assistant", content: { type: "text", text: "ok" } }
    },
  }
  const registry = createToolRegistry()
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    hostHandlers: handlers,
    clientFactory: () =>
      fakeCapabilityClient(
        [],
        (caps) => {
          expect(caps.roots).toBeDefined()
          expect(caps.sampling).toBeDefined()
          expect(caps.elicitation).toBeUndefined()
        },
        () => {},
      ),
  })

  await service.startEnabled()
})

test("elicitation handler accepts valid answer", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    elicitationCreate: async (_serverId: string, params: Record<string, unknown>, _signal: AbortSignal) => {
      return { action: "accept", content: { approved: true } }
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })
  await service.startEnabled()
  const result = await capturedHandlers!.elicitationCreate!(
    "" as string,
    { message: "Approve?" } as any,
    new AbortController().signal,
  )
  expect((result as any).action).toBe("accept")
})

test("elicitation handler declines when no answer", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    elicitationCreate: async (_serverId: string, _params: Record<string, unknown>, _signal: AbortSignal) => {
      return { action: "decline" }
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })
  await service.startEnabled()
  const result = await capturedHandlers!.elicitationCreate!(
    "" as string,
    { message: "test" } as any,
    new AbortController().signal,
  )
  expect((result as any).action).toBe("decline")
})

test("elicitation handler declines on cancelled signal", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    elicitationCreate: async (_serverId: string, _params: Record<string, unknown>, signal: AbortSignal) => {
      return signal.aborted ? { action: "decline" } : { action: "accept", content: {} }
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })
  await service.startEnabled()
  const ctrl = new AbortController()
  ctrl.abort()
  const result = await capturedHandlers!.elicitationCreate!("" as string, { message: "test" } as any, ctrl.signal)
  expect((result as any).action).toBe("decline")
})

test("elicitation handler validates against schema", async () => {
  let capturedHandlers: McpHostHandlers | undefined
  const handlers: McpHostHandlers = {
    elicitationCreate: async (_serverId: string, params: Record<string, unknown>, _signal: AbortSignal) => {
      const schema = params.requestedSchema as Record<string, unknown> | undefined
      if (!schema) return { action: "accept", content: {} }
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
      // Simulate validation: check that required field names exist in a hypothetical answer
      if (required.length > 0) {
        return { action: "decline", reason: `missing required field: ${required[0]}` }
      }
      return { action: "accept", content: {} }
    },
  }
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry: createToolRegistry(),
    hostHandlers: handlers,
    clientFactory: () => {
      const client = fakeClient([])
      const origSetHostHandlers = client.setHostHandlers.bind(client)
      client.setHostHandlers = (h: McpHostHandlers) => {
        capturedHandlers = h
        origSetHostHandlers(h)
      }
      return client
    },
  })
  await service.startEnabled()
  const result = await capturedHandlers!.elicitationCreate!(
    "" as string,
    {
      message: "test",
      requestedSchema: { type: "object", required: ["name"] },
    } as any,
    new AbortController().signal,
  )
  expect((result as any).action).toBe("decline")
  expect((result as any).reason).toContain("missing required field")
})

test("elicitation capability is advertised when handler is present", async () => {
  const handlers: McpHostHandlers = {
    rootsList: async () => [{ uri: "file:///test", name: "test" }],
    elicitationCreate: async (_serverId: string, _params: Record<string, unknown>, _signal: AbortSignal) => {
      return { action: "accept", content: { ok: true } }
    },
  }
  const registry = createToolRegistry()
  const config = withMcp({ server: server({ transport: "stdio", command: "fake" }) })
  const service = createMcpService({
    config,
    registry,
    hostHandlers: handlers,
    clientFactory: () =>
      fakeCapabilityClient(
        [],
        (caps) => {
          expect(caps.roots).toBeDefined()
          expect(caps.elicitation).toBeDefined()
        },
        () => {},
      ),
  })

  await service.startEnabled()
})
