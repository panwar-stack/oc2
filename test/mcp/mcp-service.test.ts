import { expect, test } from "bun:test"

import {
  createMcpService,
  createMcpToolConfigEntries,
  createToolExecutor,
  createToolRegistry,
  defaultConfig,
  McpAuthRequiredError,
  type McpCallResult,
  type McpClient,
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
    clientFactory: () => fakeClient([tool], () => {
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
    async initialize() {},
    async listTools() {
      return tools
    },
    async callTool(name, input) {
      return call(name, input)
    },
    onToolsChanged() {},
    async close() {},
  }
}

function mutableFakeClient(tools: McpToolInfo[]) {
  let changed: (() => void) | undefined
  return {
    tools,
    triggerChanged() {
      changed?.()
    },
    async initialize() {},
    async listTools() {
      return this.tools
    },
    async callTool() {
      return { content: "ok" }
    },
    onToolsChanged(callback: () => void) {
      changed = callback
    },
    async close() {},
  } satisfies McpClient & { tools: McpToolInfo[]; triggerChanged(): void }
}
