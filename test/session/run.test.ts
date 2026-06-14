import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"

import {
  createSessionRunService,
  createRuntimeEventBus,
  createToolRegistry,
  defaultConfig,
  ModelProviderError,
  openOc2Database,
  type McpClient,
  type McpHostHandlers,
  type McpInitializeInput,
  type McpInitializeResult,
  type ModelContext,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ToolDefinition,
} from "../../src"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

test("run creates session, persists user prompt and assistant response", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
  })

  const result = await service.run({ prompt: "hello", model: "fake/test" })

  expect(result.status).toBe("completed")
  expect(service.sessions.messages.listBySession(result.sessionId).map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  db.close()
})

test("run resumes an existing session and appends new prompt", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents])],
  })
  const first = await service.run({ prompt: "first", model: "fake/test" })

  const second = await service.run({ sessionId: first.sessionId, prompt: "second", model: "fake/test" })

  expect(second.sessionId).toBe(first.sessionId)
  expect(
    service.sessions.messages.listBySession(first.sessionId).filter((message) => message.role === "user"),
  ).toHaveLength(2)
  db.close()
})

test("run persists ordered absolute workspace roots for new sessions", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo/project",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
  })

  const result = await service.run({ prompt: "hello", model: "fake/test", roots: [".", "../reference"] })

  expect(service.sessions.resumeSession(result.sessionId)?.workspaceRoots.map((root) => root.path)).toEqual([
    resolve("/repo/project", "."),
    resolve("/repo/project", "../reference"),
  ])
  db.close()
})

test("run defaults new session workspace roots to cwd when omitted", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo/project",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
  })

  const result = await service.run({ prompt: "hello", model: "fake/test" })

  expect(service.sessions.resumeSession(result.sessionId)?.workspaceRoots.map((root) => root.path)).toEqual([
    resolve("/repo/project"),
  ])
  db.close()
})

test("run wires MCP roots handler from normal session workspace roots", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  let capturedCapabilities: McpInitializeInput["capabilities"] | undefined
  const cwd = "/repo/project space"
  const config = {
    ...defaultConfig,
    mcp: {
      roots: {
        enabled: true,
        transport: "stdio" as const,
        command: "fake",
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      },
    },
  }
  const service = createSessionRunService({
    config,
    cwd,
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    mcpClientFactory: () => fakeMcpClient({
      onHandlers: (handlers) => {
        capturedHandlers = handlers
      },
      onInitialize: (input) => {
        capturedCapabilities = input.capabilities
      },
    }),
  })

  const result = await service.run({ prompt: "hello", model: "fake/test", roots: [".", "../reference space"] })
  const session = service.sessions.resumeSession(result.sessionId)!
  const roots = await capturedHandlers!.rootsList!(new AbortController().signal)

  expect(capturedCapabilities?.roots).toEqual({ listChanged: true })
  expect(roots).toEqual(
    session.workspaceRoots.map((root) => ({
      uri: pathToFileURL(root.path).href,
      name: root.label,
    })),
  )
  expect(roots.map((root) => root.uri)).toEqual([
    pathToFileURL(resolve(cwd, ".")).href,
    pathToFileURL(resolve(cwd, "../reference space")).href,
  ])
  expect(roots[0]!.uri).toContain("project%20space")
  db.close()
})

test("MCP sampling is denied by default in normal session runs", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents])
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withSamplingMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [provider],
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.samplingCreateMessage!(
    "sampler",
    { messages: [{ role: "user", content: { type: "text", text: "hello" } }] },
    new AbortController().signal,
  )

  expect((result as any).stopReason).toBe("refusal")
  expect(provider.requests).toHaveLength(1)
  db.close()
})

test("MCP sampling requires exact mcp.sampling server permission", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents])
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withSamplingMcpConfig([{ match: "mcp.sampling", decision: "allow" }]),
    cwd: "/repo",
    database: db,
    providers: [provider],
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.samplingCreateMessage!(
    "sampler",
    { messages: [{ role: "user", content: { type: "text", text: "hello" } }] },
    new AbortController().signal,
  )

  expect((result as any).stopReason).toBe("refusal")
  expect(provider.requests).toHaveLength(1)
  db.close()
})

test("MCP sampling uses explicit permission and isolated redacted model request", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const events = createRuntimeEventBus()
  const published: unknown[] = []
  events.all((event) => published.push(event))
  const provider = createScriptedModelProvider([
    simpleAssistantEvents,
    [{ type: "text-delta", text: "sample response" }, { type: "done" }],
  ])
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withSamplingMcpConfig([{ match: "mcp.sampling:sampler", decision: "allow" }]),
    cwd: "/repo",
    database: db,
    events,
    providers: [provider],
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  const run = await service.run({ prompt: "normal prompt", model: "fake/test" })
  const result = await capturedHandlers!.samplingCreateMessage!(
    "sampler",
    {
      messages: [
        { role: "user", content: { type: "text", text: "Authorization: Bearer secret-token" } },
        { role: "assistant", content: "api_key=sk-secret123456" },
      ],
      maxTokens: 12,
    },
    new AbortController().signal,
  )

  expect((result as any).content.text).toBe("sample response")
  expect(provider.requests).toHaveLength(2)
  const samplingRequest = provider.requests[1]!
  expect(samplingRequest.sessionId).toBe(run.sessionId)
  expect(samplingRequest.modelId).toBe("test")
  expect(samplingRequest.maxTokens).toBe(12)
  expect(samplingRequest.tools).toEqual([])
  expect(samplingRequest.providerOptions).toEqual({ source: "mcp.sampling", serverId: "sampler" })
  expect(samplingRequest.messages).toEqual([
    { role: "user", content: "Authorization: Bearer [REDACTED]" },
    { role: "assistant", content: "api_key=[REDACTED]" },
  ])
  expect(JSON.stringify(provider.requests)).not.toContain("secret-token")
  expect(JSON.stringify(published)).not.toContain("secret-token")
  db.close()
})

test("MCP sampling rejects recursive in-flight sampling for the same server", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([
    simpleAssistantEvents,
    [{ type: "text-delta", text: "slow sample" }, { type: "done" }],
  ], { delayMs: 50 })
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withSamplingMcpConfig([{ match: "mcp.sampling:sampler", decision: "allow" }]),
    cwd: "/repo",
    database: db,
    providers: [provider],
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const first = capturedHandlers!.samplingCreateMessage!(
    "sampler",
    { messages: [{ role: "user", content: { text: "first" } }] },
    new AbortController().signal,
  )
  await waitFor(async () => provider.requests.length === 2)
  const second = await capturedHandlers!.samplingCreateMessage!(
    "sampler",
    { messages: [{ role: "user", content: { text: "second" } }] },
    new AbortController().signal,
  )
  const firstResult = await first

  expect((second as any).stopReason).toBe("refusal")
  expect((firstResult as any).content.text).toBe("slow sample")
  expect(provider.requests).toHaveLength(2)
  db.close()
})

test("MCP sampling propagates cancellation to the model provider", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createBlockingProvider()
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withSamplingMcpConfig([{ match: "mcp.sampling:sampler", decision: "allow" }]),
    cwd: "/repo",
    database: db,
    providers: [provider],
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const abort = new AbortController()
  const sampling = capturedHandlers!.samplingCreateMessage!(
    "sampler",
    { messages: [{ role: "user", content: { text: "cancel" } }] },
    abort.signal,
  )
  await waitFor(async () => provider.requests.length === 2)
  abort.abort(new Error("sampling cancelled"))

  await expect(sampling).rejects.toThrow("cancelled")
  expect(provider.requests[1]!.signal.aborted).toBe(true)
  db.close()
})

test("MCP elicitation accepts resolver answer that matches schema", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  const prompts: unknown[] = []
  const service = createSessionRunService({
    config: withElicitationMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    resolveQuestion: async (input) => {
      prompts.push(input)
      return { approved: true }
    },
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.elicitationCreate!(
    "elicit",
    {
      message: "Approve?",
      requestedSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    new AbortController().signal,
  )

  expect(result).toEqual({ action: "accept", content: { approved: true } })
  expect(prompts).toEqual([{ question: "Approve?", header: "MCP Server Request", options: [] }])
  db.close()
})

test("MCP elicitation declines when resolver returns no answer", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withElicitationMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    resolveQuestion: async () => undefined,
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.elicitationCreate!(
    "elicit",
    { message: "Approve?" },
    new AbortController().signal,
  )

  expect(result).toEqual({ action: "decline" })
  db.close()
})

test("MCP elicitation returns cancel when resolver aborts", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withElicitationMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    resolveQuestion: async () => {
      throw new Error("question timed out")
    },
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.elicitationCreate!(
    "elicit",
    { message: "Approve?" },
    new AbortController().signal,
  )

  expect(result).toEqual({ action: "cancel" })
  db.close()
})

test("MCP elicitation declines invalid answers with deterministic schema reason", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withElicitationMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    resolveQuestion: async () => "not an object",
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.elicitationCreate!(
    "elicit",
    { message: "Approve?", requestedSchema: { type: "object", required: ["approved"] } },
    new AbortController().signal,
  )

  expect((result as any).action).toBe("decline")
  expect((result as any).reason).toBe("Schema validation failed: expected object")
  db.close()
})

test("MCP elicitation validates object property schema mismatch", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  const service = createSessionRunService({
    config: withElicitationMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    resolveQuestion: async () => ({ count: "one", extra: true }),
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  const result = await capturedHandlers!.elicitationCreate!(
    "elicit",
    {
      message: "Count?",
      requestedSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 2 } },
        required: ["count"],
        additionalProperties: false,
      },
    },
    new AbortController().signal,
  )

  expect((result as any).action).toBe("decline")
  expect((result as any).reason).toBe('Schema validation failed: field "count": expected integer')
  db.close()
})

test("MCP elicitation visibly marks secret-looking prompts and schemas", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let capturedHandlers: McpHostHandlers | undefined
  let promptInput: any
  const service = createSessionRunService({
    config: withElicitationMcpConfig(),
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    resolveQuestion: async (input) => {
      promptInput = input
      return { apiToken: "redacted-by-test" }
    },
    mcpClientFactory: () => fakeMcpClient({ onHandlers: (handlers) => (capturedHandlers = handlers) }),
  })

  await service.run({ prompt: "hello", model: "fake/test" })
  await capturedHandlers!.elicitationCreate!(
    "elicit",
    {
      message: "Enter value",
      requestedSchema: {
        type: "object",
        properties: {
          apiToken: { type: "string", description: "API key", default: "Bearer raw-secret-value" },
        },
      },
    },
    new AbortController().signal,
  )

  expect(promptInput.header).toContain("SECURITY")
  expect(promptInput.question).toContain("Enter value")
  expect(promptInput.question).toContain("apiToken")
  expect(promptInput.question).toContain("description")
  expect(promptInput.question).not.toContain("raw-secret-value")
  db.close()
})

test("one active model run per session is enforced", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents], { delayMs: 20 })
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })
  const session = service.sessions.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })

  const first = service.run({ sessionId: session.id, prompt: "first" })
  await expect(service.run({ sessionId: session.id, prompt: "second" })).rejects.toThrow("already active")
  await first
  db.close()
})

test("persisted running status blocks another run service", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const first = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
  })
  const second = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
  })
  const session = first.sessions.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    status: "running",
  })

  await expect(second.run({ sessionId: session.id, prompt: "second" })).rejects.toThrow("already active")
  db.close()
})

test("per-run disabled tools are enforced during execution", async () => {
  const db = openOc2Database({ path: ":memory:" })
  let executions = 0
  const registry = createToolRegistry([
    countingTool(() => {
      executions += 1
    }),
  ])
  const provider = createScriptedModelProvider([
    [{ type: "tool-call", call: { id: "tool-1", name: "count", arguments: {} } }, { type: "done" }],
    simpleAssistantEvents,
  ])
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: db,
    registry,
    providers: [provider],
  })

  const result = await service.run({ prompt: "call disabled tool", model: "fake/test", disabledTools: ["count"] })

  expect(executions).toBe(0)
  expect(result.toolCalls).toEqual([{ id: "tool-1", name: "count", input: {}, ok: false }])
  expect(service.sessions.toolCalls.get("tool-1")?.status).toBe("failed")
  db.close()
})

test("run exposes subagent tool through the default runtime registry", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const config = {
    ...defaultConfig,
    agents: { worker: { mode: "subagent" as const, allowedTools: [], maxIterations: 20 } },
  }
  const provider = createScriptedModelProvider([
    [
      {
        type: "tool-call",
        call: { id: "subagent-1", name: "subagent", arguments: { agentId: "worker", prompt: "child task" } },
      },
      { type: "done" },
    ],
    simpleAssistantEvents,
    simpleAssistantEvents,
  ])
  const service = createSessionRunService({ config, cwd: "/repo", database: db, providers: [provider] })

  const result = await service.run({ prompt: "delegate", model: "fake/test" })

  expect(result.toolCalls).toEqual([
    { id: "subagent-1", name: "subagent", input: { agentId: "worker", prompt: "child task" }, ok: true },
  ])
  expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain("subagent")
  expect(service.sessions.listSessions().some((session) => session.parentSessionId === result.sessionId)).toBe(true)
  db.close()
})

test("run wires local repository memory into default tool execution", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([
    [
      {
        type: "tool-call",
        call: {
          id: "memory-1",
          name: "memory",
          arguments: { action: "store", key: "runtime", content: "Runtime injects local memory." },
        },
      },
      { type: "done" },
    ],
    simpleAssistantEvents,
  ])
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })

  const result = await service.run({ prompt: "remember", model: "fake/test" })

  expect(result.toolCalls).toEqual([
    {
      id: "memory-1",
      name: "memory",
      input: { action: "store", key: "runtime", content: "Runtime injects local memory." },
      ok: true,
    },
  ])
  expect(service.sessions.toolCalls.get("memory-1")?.status).toBe("completed")
  db.close()
})

test("fatal model error leaves session resumable", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const failing = {
    id: "fake",
    name: "Failing",
    async listModels() {
      return [{ id: "test" }]
    },
    async *stream() {
      throw new ModelProviderError({ message: "bad key", classification: "auth", retryable: false })
      yield { type: "done" as const }
    },
  }
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [failing] })

  const result = await service.run({ prompt: "hello", model: "fake/test" })

  expect(result.status).toBe("failed")
  expect(service.sessions.resumeSession(result.sessionId)?.id).toBe(result.sessionId)
  expect(service.sessions.messages.listBySession(result.sessionId).at(-1)?.status).toBe("failed")
  db.close()
})

function countingTool(onExecute: () => void): ToolDefinition<Record<string, never>, string> {
  return {
    name: "count",
    description: "Counts executions",
    inputSchema: z.object({}),
    modelInputSchema: { type: "object", properties: {} },
    execute() {
      onExecute()
      return "counted"
    },
  }
}

function fakeMcpClient(input: {
  readonly onHandlers?: (handlers: McpHostHandlers) => void
  readonly onInitialize?: (input: McpInitializeInput) => void
}): McpClient {
  return {
    async initialize(init) {
      input.onInitialize?.(init)
      return {} as McpInitializeResult
    },
    async listTools() {
      return []
    },
    async callTool() {
      return { content: "ok" }
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
    setHostHandlers(handlers) {
      input.onHandlers?.(handlers)
    },
    async close() {},
  }
}

function withSamplingMcpConfig(toolPermissions: { match: string; decision: "allow" | "deny" | "ask" }[] = []) {
  return {
    ...defaultConfig,
    mcp: {
      sampler: {
        enabled: true,
        transport: "stdio" as const,
        command: "fake",
        args: [],
        env: {},
        headers: {},
        toolPermissions,
        startupTimeoutMs: 10_000,
      },
    },
  }
}

function withElicitationMcpConfig() {
  return {
    ...defaultConfig,
    mcp: {
      elicit: {
        enabled: true,
        transport: "stdio" as const,
        command: "fake",
        args: [],
        env: {},
        headers: {},
        toolPermissions: [],
        startupTimeoutMs: 10_000,
      },
    },
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}

function createBlockingProvider(): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    id: "fake",
    name: "Blocking Fake",
    requests,
    async listModels(): Promise<readonly ModelInfo[]> {
      return [{ id: "test", supportsTools: true }]
    },
    async *stream(request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {
      requests.push(request)
      if (requests.length === 1) {
        yield* simpleAssistantEvents
        return
      }
      await new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      })
    },
  }
}
