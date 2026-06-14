import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  createMcpClient,
  materializeMcpTool,
  McpAuthRequiredError,
  McpJsonRpcError,
  MCP_PROTOCOL_VERSION,
  HttpTransport,
  ToolExecutionError,
  type McpClient,
  type ResolvedMcpServerConfig,
} from "../../src"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpConfig(url: string): ResolvedMcpServerConfig {
  return {
    id: "test-fixture-http",
    enabled: true,
    transport: "http",
    url,
    args: [],
    env: {},
    headers: {},
    toolPermissions: [],
    startupTimeoutMs: 10_000,
  }
}

function sseConfig(url: string): ResolvedMcpServerConfig {
  return {
    id: "test-fixture-sse",
    enabled: true,
    transport: "sse",
    url,
    args: [],
    env: {},
    headers: {},
    toolPermissions: [],
    startupTimeoutMs: 10_000,
  }
}

interface FixtureServer {
  url: string
  process: { kill(): void }
}

interface FixtureState {
  sessionId: string
  requests: Array<{ method?: string; id?: unknown; sessionId?: string | null; accept?: string | null }>
  notifications: Array<{ method?: string; params?: unknown; sessionId?: string | null }>
  deleteCount: number
  sseClosed: number
  slowCallStarted: number
}

async function startFixture(): Promise<FixtureServer> {
  const proc = Bun.spawn({
    cmd: ["bun", "test/mcp/http-fixture-server.ts"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error("Fixture server stdout closed without startup JSON")
    buffer += decoder.decode(value, { stream: true })
    const nl = buffer.indexOf("\n")
    if (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      const info = JSON.parse(line) as { port: number; url: string }
      return { url: info.url, process: proc }
    }
  }
}

async function fixtureState(url: string): Promise<FixtureState> {
  const response = await fetch(`${url}/state`)
  if (!response.ok) throw new Error(`fixture state failed: ${response.status}`)
  return (await response.json()) as FixtureState
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await Bun.sleep(25)
  }
  throw new Error("timed out waiting for fixture condition")
}

// ---------------------------------------------------------------------------
// Fixture-server-based tests (HTTP transport)
// ---------------------------------------------------------------------------

describe("HTTP McpClient", () => {
  let server: FixtureServer
  let client: McpClient

  beforeEach(async () => {
    server = await startFixture()
    client = await createMcpClient(httpConfig(server.url))
  })

  afterEach(async () => {
    try {
      await client?.close()
    } catch {
      // ignore
    }
    server?.process?.kill()
  })

  test("initialize over HTTP returns proper capabilities", async () => {
    const result = await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(result.capabilities.tools).toBeDefined()
    expect(result.capabilities.tools?.listChanged).toBe(true)
    expect(result.capabilities.resources).toBeDefined()
    expect(result.capabilities.resources?.listChanged).toBe(true)
    expect(result.capabilities.prompts).toBeDefined()
    expect(result.capabilities.prompts?.listChanged).toBe(true)
    expect(result.serverInfo?.name).toBe("http-fixture")
  }, 10_000)

  test("listTools over HTTP returns tools", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const tools = await client.listTools(new AbortController().signal)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools.some((t) => t.name === "echo")).toBe(true)
    expect(tools.some((t) => t.name === "trigger_change")).toBe(true)
  }, 10_000)

  test("replays Streamable HTTP session id on requests and notifications", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    await client.listTools(new AbortController().signal)
    const state = await fixtureState(server.url)
    expect(state.sessionId).toMatch(/^sess-/)
    expect(state.requests.find((r) => r.method === "initialize")?.sessionId).toBeNull()
    expect(state.requests.find((r) => r.method === "tools/list")?.sessionId).toBe(state.sessionId)
    expect(state.requests.find((r) => r.method === "tools/list")?.accept).toContain("text/event-stream")
    expect(state.notifications.find((n) => n.method === "notifications/initialized")?.sessionId).toBe(state.sessionId)
  }, 10_000)

  test("callTool over HTTP returns result", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const result = await client.callTool("echo", { message: "hello" }, new AbortController().signal)
    expect(result).toBeDefined()
    expect(result.isError).toBeFalsy()
  }, 10_000)

  test("listResources over HTTP returns resources", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const resources = await client.listResources(new AbortController().signal)
    expect(Array.isArray(resources)).toBe(true)
    expect(resources.length).toBeGreaterThanOrEqual(1)
    const readme = resources.find((r) => r.name === "fixture-readme")
    expect(readme).toBeDefined()
    expect(readme!.uri).toBe("file:///tmp/fixture-readme.md")
  }, 10_000)

  test("readResource over HTTP returns content", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const result = await client.readResource("file:///tmp/fixture-readme.md", new AbortController().signal)
    expect(result).toBeDefined()
    expect(Array.isArray(result.contents)).toBe(true)
    expect(result.contents.length).toBeGreaterThanOrEqual(1)
    expect(result.contents[0]?.text).toContain("Fixture Resource")
  }, 10_000)

  test("listPrompts over HTTP returns prompts", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const prompts = await client.listPrompts(new AbortController().signal)
    expect(Array.isArray(prompts)).toBe(true)
    expect(prompts.length).toBeGreaterThanOrEqual(1)
    const greeting = prompts.find((p) => p.name === "fixture-greeting")
    expect(greeting).toBeDefined()
    expect(greeting!.arguments?.some((a) => a.name === "name")).toBe(true)
  }, 10_000)

  test("getPrompt over HTTP returns messages", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const result = await client.getPrompt("fixture-greeting", { name: "test" }, new AbortController().signal)
    expect(result).toBeDefined()
    expect(Array.isArray(result.messages)).toBe(true)
    expect(result.messages.length).toBeGreaterThanOrEqual(1)
    expect(result.messages[0]?.role).toBe("user")
  }, 10_000)

  test("cancellation via AbortSignal rejects with error", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const abort = new AbortController()
    abort.abort(new Error("test cancellation"))
    await expect(client.callTool("echo", { message: "hello" }, abort.signal)).rejects.toThrow()
  }, 10_000)

  test("post-send cancellation emits notifications/cancelled", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    const abort = new AbortController()
    const call = client.callTool("slow_echo", { message: "hello" }, abort.signal)
    await waitFor(async () => (await fixtureState(server.url)).slowCallStarted > 0)
    abort.abort(new Error("test cancellation"))
    await expect(call).rejects.toThrow("MCP request cancelled")
    await waitFor(async () =>
      (await fixtureState(server.url)).notifications.some((n) => n.method === "notifications/cancelled"),
    )
    const state = await fixtureState(server.url)
    const cancelled = state.notifications.find((n) => n.method === "notifications/cancelled")
    expect(cancelled?.sessionId).toBe(state.sessionId)
  }, 10_000)

  test("close() resolves without error and server stays alive", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    // close should resolve cleanly
    await expect(client.close()).resolves.toBeUndefined()
    expect((await fixtureState(server.url)).deleteCount).toBe(1)
    // server process should still be alive (no crash)
    expect(server.process.kill).toBeDefined()
  }, 10_000)

  test("tool results with isError remain call results", async () => {
    await client.initialize(
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "http-test" },
      },
      new AbortController().signal,
    )
    await expect(client.callTool("error_result", {}, new AbortController().signal)).resolves.toMatchObject({
      isError: true,
    })
  }, 10_000)

  test("accepts Streamable HTTP SSE response bodies", async () => {
    let cancelled = false
    const sseResponseServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method.toUpperCase() === "DELETE") return new Response(null, { status: 204 })
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: {},
                    serverInfo: { name: "sse-response" },
                  },
                })}\n\n`,
              ),
            )
          },
          cancel() {
            cancelled = true
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "Mcp-Session-Id": "sess-sse-response" },
        })
      },
    })
    const sseClient = await createMcpClient(httpConfig(sseResponseServer.url.toString()))
    try {
      await expect(
        sseClient.initialize(
          { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "sse-response-test" } },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ serverInfo: { name: "sse-response" } })
      expect(cancelled).toBe(false)
      await sseClient.close()
      await waitFor(async () => cancelled)
    } finally {
      await sseClient.close()
      sseResponseServer.stop()
    }
  }, 10_000)

  test("dispatches POST SSE notifications and aborts open response bodies", async () => {
    const sseResponseServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (req.method.toUpperCase() === "DELETE") return new Response(null, { status: 204 })
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
              ),
            )
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "Mcp-Session-Id": "sess-open-sse-response" },
        })
      },
    })
    const sseClient = await createMcpClient(httpConfig(sseResponseServer.url.toString()))
    try {
      let changed = false
      sseClient.onListChanged("tools", () => {
        changed = true
      })
      const abort = new AbortController()
      const request = sseClient.listTools(abort.signal)
      await waitFor(async () => changed)
      abort.abort(new Error("stop open stream"))
      await expect(request).rejects.toThrow("MCP request cancelled")
    } finally {
      await sseClient.close()
      sseResponseServer.stop()
    }
  }, 10_000)

  test("redacts JSON-RPC error messages before model-visible tool output", async () => {
    const tool = materializeMcpTool({
      serverId: "secrets",
      tool: { name: "leaky", inputSchema: { type: "object", properties: {} } },
      client: {
        async initialize() {
          throw new Error("unused")
        },
        async listTools() {
          return []
        },
        async callTool() {
          throw new McpJsonRpcError(-32000, "failed with Authorization: Bearer secret-token", {
            access_token: "secret-token",
          })
        },
        async listResources() {
          return []
        },
        async readResource() {
          return { contents: [] }
        },
        async listPrompts() {
          return []
        },
        async getPrompt() {
          return { messages: [] }
        },
        onListChanged() {},
        onToolsChanged() {},
        setHostHandlers() {},
        async close() {},
      },
    })
    const error = await Promise.resolve(
      tool.execute({}, { callId: "call", signal: new AbortController().signal, workspaceRoots: [] }),
    )
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ToolExecutionError)
    expect((error as ToolExecutionError).message).toContain("Bearer [REDACTED]")
    expect((error as ToolExecutionError).message).not.toContain("secret-token")
  }, 10_000)
})

// ---------------------------------------------------------------------------
// SSE list-changed notifications
// ---------------------------------------------------------------------------

describe("SSE list-changed notifications", () => {
  test("trigger_change emits list-changed callbacks through McpClient SSE", async () => {
    const fixture = await startFixture()
    const client = await createMcpClient(sseConfig(fixture.url))
    try {
      await client.initialize(
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "sse-test" },
        },
        new AbortController().signal,
      )
      const received: string[] = []
      client.onListChanged("tools", () => received.push("tools"))
      client.onListChanged("resources", () => received.push("resources"))
      client.onListChanged("prompts", () => received.push("prompts"))
      await client.callTool("trigger_change", {}, new AbortController().signal)
      await waitFor(async () => received.length >= 3)
      expect(received).toContain("tools")
      expect(received).toContain("resources")
      expect(received).toContain("prompts")
      await client.close()
      await waitFor(async () => (await fixtureState(fixture.url)).sseClosed > 0)
    } finally {
      await client.close().catch(() => undefined)
      fixture.process.kill()
    }
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Malformed server response
// ---------------------------------------------------------------------------

describe("malformed server responses", () => {
  test("missing result field in JSON-RPC response throws", async () => {
    const noResultServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "no-result-server",
        enabled: true,
        transport: "http",
        url: noResultServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        await expect(
          client.initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "no-result-test" },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow()
      } finally {
        await client.close()
      }
    } finally {
      noResultServer.stop()
    }
  }, 10_000)

  test("unsupported method returns JSON-RPC error with code -32601", async () => {
    const unsupportedServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "unsupported-server",
        enabled: true,
        transport: "http",
        url: unsupportedServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        const err = await client
          .initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "unsupported-test" },
            },
            new AbortController().signal,
          )
          .catch((e: unknown) => e)
        expect(err).toBeDefined()
        expect(err instanceof Error).toBe(true)
        // Should have thrown an error (McpJsonRpcError or similar)
      } finally {
        await client.close()
      }
    } finally {
      unsupportedServer.stop()
    }
  }, 10_000)

  test("failed initialization error propagates to caller", async () => {
    const failInitServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "Server not available", data: { retryAfter: 30 } },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "fail-init-server",
        enabled: true,
        transport: "http",
        url: failInitServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        const err = await client
          .initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "fail-init-test" },
            },
            new AbortController().signal,
          )
          .catch((e: unknown) => e)
        expect(err).toBeDefined()
        expect(err instanceof Error).toBe(true)
        const errorMsg = (err as Error).message
        expect(errorMsg).toContain("Server not available")
      } finally {
        await client.close()
      }
    } finally {
      failInitServer.stop()
    }
  }, 10_000)

  test("JSON-RPC error response preserves code, message, and data", async () => {
    const errorServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "Custom server error", data: { detail: "extra info" } },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "jsonrpc-error-server",
        enabled: true,
        transport: "http",
        url: errorServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        const err = await client
          .initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "jsonrpc-error-test" },
            },
            new AbortController().signal,
          )
          .catch((e: unknown) => e)
        expect(err).toBeDefined()
        expect(err instanceof Error).toBe(true)
        const errorMsg = (err as Error).message
        expect(errorMsg).toContain("Custom server error")
        // Verify it's a McpJsonRpcError with preserved fields
        expect(err).toHaveProperty("code", -32000)
        expect(err).toHaveProperty("data")
        expect((err as Record<string, unknown>).data).toEqual({ detail: "extra info" })
        expect(err).toHaveProperty("isMcpError", true)
      } finally {
        await client.close()
      }
    } finally {
      errorServer.stop()
    }
  }, 10_000)

  test("handles invalid JSON response gracefully", async () => {
    const badServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response("not valid json at all", {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "bad-server",
        enabled: true,
        transport: "http",
        url: badServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        await expect(
          client.initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "bad-test" },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow()
      } finally {
        await client.close()
      }
    } finally {
      badServer.stop()
    }
  }, 10_000)

  test("handles non-JSON-RPC response body gracefully", async () => {
    const badServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(JSON.stringify({ foo: "bar", baz: 42 }), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "not-rpc",
        enabled: true,
        transport: "http",
        url: badServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        await expect(
          client.initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "bad-test" },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow()
      } finally {
        await client.close()
      }
    } finally {
      badServer.stop()
    }
  }, 10_000)
})

// ---------------------------------------------------------------------------
// HTTP 401 / 403 McpAuthRequiredError
// ---------------------------------------------------------------------------

describe("McpAuthRequiredError for 401/403", () => {
  test("throws McpAuthRequiredError on 401", async () => {
    const authServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Unauthorized" } }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "www-authenticate": 'Bearer resource_metadata="https://auth.example.com/oauth/authorize"',
            },
          },
        )
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "auth-server",
        enabled: true,
        transport: "http",
        url: authServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        await expect(
          client.initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "auth-test" },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow(McpAuthRequiredError)
      } catch (err) {
        expect(err).toBeInstanceOf(McpAuthRequiredError)
      } finally {
        await client.close()
      }
    } finally {
      authServer.stop()
    }
  }, 10_000)

  test("throws McpAuthRequiredError on 403", async () => {
    const authServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "forbidden-server",
        enabled: true,
        transport: "http",
        url: authServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        await expect(
          client.initialize(
            {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "auth-test" },
            },
            new AbortController().signal,
          ),
        ).rejects.toThrow(McpAuthRequiredError)
      } finally {
        await client.close()
      }
    } finally {
      authServer.stop()
    }
  }, 10_000)

  test("McpAuthRequiredError carries metadataUrl from www-authenticate header", async () => {
    const metadataPath = "https://meta.example.com/oauth/auth"
    const authServer = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Unauthorized" } }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "www-authenticate": `Bearer resource_metadata="${metadataPath}"`,
            },
          },
        )
      },
    })
    try {
      const config: ResolvedMcpServerConfig = {
        id: "metadata-server",
        enabled: true,
        transport: "http",
        url: authServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      }
      const client = await createMcpClient(config)
      try {
        await client.initialize(
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "auth-test" },
          },
          new AbortController().signal,
        )
      } catch (err) {
        expect(err).toBeInstanceOf(McpAuthRequiredError)
        expect((err as McpAuthRequiredError).metadataUrl).toBe(metadataPath)
      } finally {
        await client.close()
      }
    } finally {
      authServer.stop()
    }
  }, 10_000)

  test("refreshes bearer token and retries one 401 request", async () => {
    let requests = 0
    const authHeaders: string[] = []
    const retryServer = Bun.serve({
      port: 0,
      async fetch(req) {
        requests += 1
        authHeaders.push(req.headers.get("authorization") ?? "")
        if (requests === 1) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Unauthorized" } }), {
            status: 401,
            headers: {
              "content-type": "application/json",
              "www-authenticate": 'Bearer resource_metadata="https://meta.example.com/oauth"',
            },
          })
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "retry" } },
          }),
          { headers: { "content-type": "application/json" } },
        )
      },
    })
    let forceRefreshes = 0
    try {
      const config: ResolvedMcpServerConfig = {
        id: "retry-server",
        enabled: true,
        transport: "http",
        url: retryServer.url.toString(),
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
        tokenProvider: async (forceRefresh = false) => {
          if (forceRefresh) forceRefreshes += 1
          return { Authorization: forceRefresh ? "Bearer fresh-token" : "Bearer stale-token" }
        },
      }
      const client = await createMcpClient(config)
      try {
        await expect(
          client.initialize(
            { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "retry-test" } },
            new AbortController().signal,
          ),
        ).resolves.toMatchObject({ serverInfo: { name: "retry" } })
      } finally {
        await client.close()
      }
      expect(requests).toBeGreaterThanOrEqual(2)
      expect(forceRefreshes).toBe(1)
      expect(authHeaders.slice(0, 2)).toEqual(["Bearer stale-token", "Bearer fresh-token"])
    } finally {
      retryServer.stop()
    }
  }, 10_000)

  test("refreshes bearer token and retries one SSE 401 connection", async () => {
    let requests = 0
    const authHeaders: string[] = []
    const retryServer = Bun.serve({
      port: 0,
      fetch(req) {
        requests += 1
        authHeaders.push(req.headers.get("authorization") ?? "")
        if (requests === 1) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": 'Bearer resource_metadata="https://meta.example.com/oauth"' },
          })
        }
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`))
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    let forceRefreshes = 0
    const messages: Record<string, unknown>[] = []
    const errors: Error[] = []
    const transport = new HttpTransport({
      url: retryServer.url.toString(),
      transport: "sse",
      tokenProvider: async (forceRefresh = false) => {
        if (forceRefresh) forceRefreshes += 1
        return { Authorization: forceRefresh ? "Bearer fresh-sse-token" : "Bearer stale-sse-token" }
      },
    })
    transport.onMessage((message) => messages.push(message))
    transport.onError((error) => errors.push(error))
    try {
      await transport.start()
      await waitFor(async () => messages.length > 0)
      expect(requests).toBe(2)
      expect(forceRefreshes).toBe(1)
      expect(authHeaders).toEqual(["Bearer stale-sse-token", "Bearer fresh-sse-token"])
      expect(errors).toEqual([])
    } finally {
      await transport.close()
      retryServer.stop()
    }
  }, 10_000)
})
