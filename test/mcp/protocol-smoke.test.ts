import { expect, test } from "bun:test"

import { createMcpClient, MCP_PROTOCOL_VERSION, type McpClient, type ResolvedMcpServerConfig } from "../../src"

function stdioServer(): ResolvedMcpServerConfig {
  return {
    id: "fake",
    enabled: true,
    transport: "stdio",
    command: "bun",
    args: ["test/mcp/fake-server.ts"],
    env: {},
    headers: {},
    toolPermissions: [],
    startupTimeoutMs: 10_000,
  }
}

test("initialize returns typed result with server capabilities", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    const result = await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(result.capabilities).toBeDefined()
    expect(result.capabilities.tools).toBeDefined()
    expect(result.capabilities.tools?.listChanged).toBe(true)
    expect(result.serverInfo?.name).toBeDefined()
  } finally {
    await client.close()
  }
}, 15_000)

test("tools/list returns normalized McpToolInfo array", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    const tools = await client.listTools(controller.signal)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools[0]?.name).toBeDefined()
  } finally {
    await client.close()
  }
}, 15_000)

test("tools/call returns structured result", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    const result = await client.callTool("echo", { message: "hello" }, controller.signal)
    expect(result).toBeDefined()
    expect(result.isError).toBeFalsy()
  } finally {
    await client.close()
  }
}, 15_000)

test("onListChanged receives tools list_changed notification", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    let toolsChanged = false
    client.onListChanged("tools", () => {
      toolsChanged = true
    })
    await client.callTool("trigger_change", {}, controller.signal)
    await Bun.sleep(100)
    expect(toolsChanged).toBe(true)
  } finally {
    await client.close()
  }
}, 15_000)

test("onListChanged receives resources list_changed notification", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    let resourcesChanged = false
    client.onListChanged("resources", () => {
      resourcesChanged = true
    })
    await client.callTool("trigger_change", {}, controller.signal)
    await Bun.sleep(100)
    expect(resourcesChanged).toBe(true)
  } finally {
    await client.close()
  }
}, 15_000)

test("onListChanged receives prompts list_changed notification", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    let promptsChanged = false
    client.onListChanged("prompts", () => {
      promptsChanged = true
    })
    await client.callTool("trigger_change", {}, controller.signal)
    await Bun.sleep(100)
    expect(promptsChanged).toBe(true)
  } finally {
    await client.close()
  }
}, 15_000)

test("onToolsChanged backward compat delegates to onListChanged tools", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    let legacyChanged = false
    client.onToolsChanged(() => {
      legacyChanged = true
    })
    await client.callTool("trigger_change", {}, controller.signal)
    await Bun.sleep(100)
    expect(legacyChanged).toBe(true)
  } finally {
    await client.close()
  }
}, 15_000)

test("request cancellation via AbortSignal", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    const abortController = new AbortController()
    abortController.abort(new Error("test cancellation"))
    await expect(client.callTool("echo", { message: "hello" }, abortController.signal)).rejects.toThrow()
  } finally {
    await client.close()
  }
}, 15_000)

test("new methods throw not implemented until PR 2", async () => {
  const client = (await createMcpClient(stdioServer())) as McpClient
  const controller = new AbortController()
  try {
    await client.initialize(
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oc2-smoke" } },
      controller.signal,
    )
    await expect(client.listResources(controller.signal)).rejects.toThrow("not implemented")
    await expect(client.readResource("fake", controller.signal)).rejects.toThrow("not implemented")
    await expect(client.listPrompts(controller.signal)).rejects.toThrow("not implemented")
    await expect(client.getPrompt("fake", {}, controller.signal)).rejects.toThrow("not implemented")
  } finally {
    await client.close()
  }
}, 15_000)
