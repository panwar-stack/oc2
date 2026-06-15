import { expect, mock, test } from "bun:test"

import { defaultConfig } from "../../src"
import type { RuntimeEvent } from "../../src/events/events"
import type { TuiClient } from "../../src/tui/client"
import { createInitialTuiState } from "../../src/tui/state"

let rendererConfig: Record<string, unknown> | undefined
let renderedShell: (() => unknown) | undefined
let renderedWith: MockRenderer | undefined
let renderer: MockRenderer | undefined

mock.module("@opentui/core", () => ({
  createCliRenderer: async (config: Record<string, unknown>) => {
    rendererConfig = config
    renderer = createMockRenderer()
    return renderer
  },
}))

mock.module("@opentui/solid", () => ({
  createElement: (tag: string): MockNode => ({ tag, props: {}, children: [] }),
  render: async (shell: () => unknown, target: MockRenderer) => {
    renderedShell = shell
    renderedWith = target
  },
  spread: (
    element: { props: Record<string, unknown>; children?: unknown[] },
    props: Record<string, unknown> | (() => Record<string, unknown>),
  ) => {
    const next = typeof props === "function" ? props() : props
    element.props = next
    element.children = next.children as unknown[] | undefined
  },
}))

const { launchTui, renderTui, STATIC_TUI_SHELL_LABELS } = await import("../../src/tui/app")

test("renders messages, streaming text, tool status, and side panel", () => {
  const output = renderTui(
    {
      ...createInitialTuiState(true),
      sessionId: "s1",
      messages: [{ id: "m1", role: "user", text: "hello", status: "completed" }],
      streamingText: "partial",
      toolCalls: [{ id: "t1", name: "read", status: "running" }],
      status: "running",
      running: true,
    },
    "next",
  )

  expect(output).toContain("user> hello")
  expect(output).toContain("assistant> partial")
  expect(output).toContain("read [running]")
  expect(output).toContain("Running> next")
})

test("renders error banner and hides side panel", () => {
  const output = renderTui({ ...createInitialTuiState(false), errors: ["bad"] })

  expect(output).toContain("Error: bad")
  expect(output).not.toContain("--- side panel ---")
})

test("renders PR14 team MCP permission question and agent panels", () => {
  const state = {
    ...createInitialTuiState(true),
    activePanel: "team" as const,
    teams: [
      {
        id: "team-1",
        name: "frontend",
        goal: "ship panels",
        status: "active",
        reportAvailable: true,
        members: [
          {
            id: "member-1",
            name: "daemon",
            status: "active",
            lifecycle: "daemon",
            dependencyIds: ["member-0"],
            daemonState: "running",
          },
        ],
        tasks: [{ id: "task-1", status: "pending", description: "review", assignee: "daemon", dependencyIds: [] }],
        mailbox: [{ id: "msg-1", recipientId: "lead", sender: "daemon", body: "ready" }],
      },
    ],
    permissions: [
      { permissionId: "perm-1", toolName: "bash", action: "execute", resource: "npm test", status: "pending" as const },
      { permissionId: "perm-2", toolName: "write", status: "deny" as const, reason: "blocked" },
    ],
    questionPrompt: {
      permissionId: "perm-1",
      header: "Confirm",
      question: "Run tests?",
      options: [{ label: "Yes", description: "run them" }],
      multiple: false,
    },
    agentTasks: [{ id: "agent-1", kind: "team-member", status: "running" }],
  }

  const output = renderTui(state, "")

  expect(output).toContain("Team: frontend")
  expect(output).toContain("Goal: ship panels")
  expect(output).toContain("daemon: active lifecycle=daemon deps=member-0 daemon=running")
  expect(output).toContain("review: pending @daemon")
  expect(output).toContain("daemon -> lead: ready")
  expect(output).toContain("pending bash: execute npm test")
  expect(output).toContain("denied write: blocked")
  expect(output).toContain("permission> pending bash: execute npm test")
  expect(output).toContain("permission> denied write: blocked")
  expect(output).toContain("Question: Confirm")
  expect(output).toContain("Run tests?")
  expect(output).toContain("team-member:agent-1 running")
})

test("renders MCP panel and active MCP tool calls", () => {
  const output = renderTui({
    ...createInitialTuiState(true),
    activePanel: "mcp",
    mcpServers: [
      {
        serverId: "browser",
        status: "auth_required",
        authState: "callback_pending",
        toolCount: 1,
        tools: ["mcp_browser_open"],
        authRequired: true,
        resourceCount: 2,
        promptCount: 3,
        authUrl: "http://127.0.0.1:7331/callback",
      },
      { serverId: "bad", status: "failed", tools: [], authRequired: false, error: "boom" },
    ],
    toolCalls: [{ id: "m1", name: "mcp_browser_open", status: "running" }],
  })

  expect(output).toContain(
    "browser: callback_pending tools=1 resources=2 prompts=3 auth=http://127.0.0.1:7331/callback",
  )
  expect(output).toContain("bad: failed tools=0 error=boom")
  expect(output).toContain("mcp_browser_open [running]")
})

test("narrow terminal hides side panels but preserves prompt and errors", () => {
  const output = renderTui(
    {
      ...createInitialTuiState(true),
      activePanel: "team",
      errors: ["recoverable"],
      teams: [{ id: "team-1", status: "active", reportAvailable: false, members: [], tasks: [], mailbox: [] }],
    },
    "keep typing",
    { width: 60 },
  )

  expect(output).toContain("Error: recoverable")
  expect(output).toContain("Prompt> keep typing")
  expect(output).not.toContain("--- side panel ---")
  expect(output).not.toContain("Team: team-1")
})

test("narrow terminal keeps question prompt visible", () => {
  const output = renderTui(
    {
      ...createInitialTuiState(true),
      questionPrompt: {
        permissionId: "question-1",
        header: "Confirm",
        question: "Run tests?",
        options: [{ label: "Yes" }],
        multiple: false,
      },
    },
    "",
    { width: 60 },
  )

  expect(output).not.toContain("--- side panel ---")
  expect(output).toContain("Question: Confirm")
  expect(output).toContain("Run tests?")
  expect(output).toContain("Prompt> ")
})

test("renders slash suggestions below prompt and hides side panel", () => {
  const output = renderTui(
    {
      ...createInitialTuiState(true),
      activePanel: "team",
      teams: [{ id: "team-1", status: "active", reportAvailable: false, members: [], tasks: [], mailbox: [] }],
      slashActive: true,
      slashQuery: "rev",
      slashMatches: [
        { name: "review", display: "/review", description: "review changes", source: "builtin" },
        { name: "clear", display: "/clear", description: "clear visible messages", source: "tui" },
      ],
    },
    "/rev",
  )

  expect(output).toContain("Prompt> /rev")
  expect(output).toContain("/review")
  expect(output).toContain("review changes [builtin]")
  expect(output).toContain("[ESC to cancel]")
  expect(output).not.toContain("--- side panel ---")
  expect(output).not.toContain("Team: team-1")
})

test("caps slash suggestions and reports hidden matches", () => {
  const output = renderTui({
    ...createInitialTuiState(false),
    slashActive: true,
    slashMatches: Array.from({ length: 6 }, (_, index) => ({
      name: `cmd-${index}`,
      display: `/cmd-${index}`,
      description: "long description for command",
      source: "builtin" as const,
    })),
  })

  expect(output).toContain("/cmd-0")
  expect(output).toContain("/cmd-4")
  expect(output).not.toContain("/cmd-5")
  expect(output).toContain("... and 1 more")
})

test("launchTui starts an OpenTUI renderer shell with required options", async () => {
  resetRendererMock()
  const stdout = createMockStdout()
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout, client: createMockClient() })

  await waitForRenderer()

  expect(rendererConfig).toMatchObject({
    externalOutputMode: "passthrough",
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
  })
  expect(renderedShell).toBeFunction()
  expect(renderedWith).toBe(renderer)
  renderer?.destroy()
  await launched
  expect(stdout.output).toContain("\x1b[0m\x1b[?25h")
})

test("static renderer shell exposes PR2 placeholder regions", async () => {
  resetRendererMock()
  const stdout = createMockStdout()
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout, client: createMockClient() })

  await waitForRenderer()
  const shell = renderedShell?.() as MockNode
  const text = collectText(shell)

  expect(Object.values(STATIC_TUI_SHELL_LABELS)).toEqual([
    "oc2 transcript viewport",
    "sidebar placeholder",
    "footer placeholder",
    "Prompt>",
  ])
  expect(text).toContain(STATIC_TUI_SHELL_LABELS.transcript)
  expect(text).toContain(STATIC_TUI_SHELL_LABELS.sidebar)
  expect(text).toContain(STATIC_TUI_SHELL_LABELS.footer)
  expect(text).toContain(STATIC_TUI_SHELL_LABELS.prompt)
  renderer?.destroy()
  await launched
})

test("launchTui destroys the renderer and resolves on Ctrl+C", async () => {
  resetRendererMock()
  const stdout = createMockStdout()
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout, client: createMockClient() })

  await waitForRenderer()
  expect(inputHandler()("\u0003")).toBe(true)
  await launched

  expect(renderer?.isDestroyed).toBe(true)
  expect(renderer?.setTerminalTitleCalls).toEqual([""])
  expect(stdout.output).toContain("\x1b[0m\x1b[?25h")
})

test("launchTui destroys the renderer and resolves on Ctrl+D", async () => {
  resetRendererMock()
  const stdout = createMockStdout()
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout, client: createMockClient() })

  await waitForRenderer()
  expect(inputHandler()("\u0004")).toBe(true)
  await launched

  expect(renderer?.isDestroyed).toBe(true)
  expect(stdout.output).toContain("\x1b[0m\x1b[?25h")
})

test("launchTui hydrates a resumed session into basic transcript rows", async () => {
  resetRendererMock()
  const client = createMockClient({
    hydrateState: {
      ...createInitialTuiState(true),
      sessionId: "s1",
      messages: [
        { id: "u1", role: "user", text: "hello", status: "completed" },
        { id: "a1", role: "assistant", text: "hi there", status: "completed" },
      ],
    },
  })
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", sessionId: "s1", client })

  await waitForRenderer()
  const text = shellText()

  expect(client.hydrateCalls).toEqual(["s1"])
  expect(text).toContain("user> hello")
  expect(text).toContain("assistant> hi there")
  renderer?.destroy()
  await launched
})

test("launchTui shows hydration diagnostics and submits next prompt as a new session", async () => {
  resetRendererMock()
  const client = createMockClient({
    hydrateState: {
      ...createInitialTuiState(true),
      diagnostics: [{ message: "Failed to hydrate session missing" }],
    },
  })
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", sessionId: "missing", client })

  await waitForRenderer()
  expect(shellText()).toContain("diagnostic> Failed to hydrate session missing")
  inputHandler()("next")
  inputHandler()("\r")
  await Bun.sleep(0)

  expect(client.promptCalls[0]).toMatchObject({ prompt: "next", sessionId: undefined, roots: ["/repo"] })
  renderer?.destroy()
  await launched
})

test("launchTui projects runtime events through TuiState into transcript rows", async () => {
  resetRendererMock()
  const client = createMockClient()
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", client })

  await waitForRenderer()
  client.publish({ type: "model.started", payload: { sessionId: "s1" } })
  client.publish({ type: "model.delta", payload: { sessionId: "s1", delta: "partial" } })
  expect(shellText()).toContain("assistant> partial")
  client.publish({ type: "model.completed", payload: { sessionId: "s1" } })
  expect(shellText()).toContain("assistant> partial")
  renderer?.destroy()
  await launched
})

test("launchTui submits prompts through TuiClient with launch model and roots", async () => {
  resetRendererMock()
  const client = createMockClient({ hydrateState: { ...createInitialTuiState(true), sessionId: "s1" } })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    sessionId: "s1",
    model: "fake/test",
    roots: ["/repo", "/other"],
    client,
  })

  await waitForRenderer()
  inputHandler()("hello")
  expect(shellText()).toContain("Prompt> hello")
  inputHandler()("\r")
  await Bun.sleep(0)

  expect(shellText()).toContain("user> hello")
  expect(shellText()).toContain("Prompt> ")
  expect(client.promptCalls[0]).toMatchObject({
    prompt: "hello",
    sessionId: "s1",
    model: "fake/test",
    roots: ["/repo", "/other"],
  })
  expect(client.promptCalls[0]?.signal).toBeInstanceOf(AbortSignal)
  renderer?.destroy()
  await launched
})

test("launchTui aborts active runs on Ctrl+C before exiting when idle", async () => {
  resetRendererMock()
  let resolvePrompt: ((value: { sessionId: string }) => void) | undefined
  const client = createMockClient({
    hydrateState: { ...createInitialTuiState(true), sessionId: "s1" },
    prompt: (input) =>
      new Promise((resolve) => {
        resolvePrompt = resolve
        client.promptCalls.push(input)
      }),
  })
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", sessionId: "s1", client })

  await waitForRenderer()
  inputHandler()("slow")
  inputHandler()("\r")
  await Bun.sleep(0)
  expect(client.promptCalls[0]?.signal?.aborted).toBe(false)

  expect(inputHandler()("\u0003")).toBe(true)
  expect(renderer?.isDestroyed).toBe(false)
  expect(client.promptCalls[0]?.signal?.aborted).toBe(true)
  expect(client.abortCalls).toEqual(["s1"])
  resolvePrompt?.({ sessionId: "s1" })
  await Bun.sleep(0)

  expect(inputHandler()("\u0003")).toBe(true)
  await launched
  expect(renderer?.isDestroyed).toBe(true)
})

interface MockNode {
  readonly tag: string
  props: Record<string, unknown>
  children?: unknown[]
}

interface MockStdout {
  readonly columns: number
  output: string
  write(chunk: string): void
}

interface MockRenderer {
  isDestroyed: boolean
  readonly setTerminalTitleCalls: string[]
  destroy(): void
  once(event: "destroy", listener: () => void): void
  requestRender(): void
  setTerminalTitle(title: string): void
}

interface MockClient extends TuiClient {
  hydrateCalls: string[]
  promptCalls: Array<Parameters<TuiClient["sessions"]["prompt"]>[0]>
  abortCalls: string[]
  publish(input: { readonly type: RuntimeEvent["type"]; readonly payload: RuntimeEvent["payload"] }): void
}

function createMockRenderer(): MockRenderer {
  const destroyListeners: Array<() => void> = []
  return {
    isDestroyed: false,
    setTerminalTitleCalls: [],
    destroy() {
      if (this.isDestroyed) return
      this.isDestroyed = true
      for (const listener of destroyListeners) listener()
    },
    once(_event, listener) {
      destroyListeners.push(listener)
    },
    requestRender() {},
    setTerminalTitle(title) {
      this.setTerminalTitleCalls.push(title)
    },
  }
}

function resetRendererMock(): void {
  rendererConfig = undefined
  renderedShell = undefined
  renderedWith = undefined
  renderer = undefined
}

function createMockStdout(): MockStdout {
  return {
    columns: 100,
    output: "",
    write(chunk) {
      this.output += chunk
    },
  }
}

function collectText(node: MockNode | unknown): string {
  if (!node || typeof node !== "object") return ""
  const current = node as MockNode
  const rawContent = current.props.content
  const content = typeof rawContent === "function" ? rawContent() : rawContent
  return [content, ...(current.children ?? []).map(collectText)].filter(Boolean).join("\n")
}

function shellText(): string {
  return collectText(renderedShell?.())
}

async function waitForRenderer(): Promise<void> {
  await Bun.sleep(0)
  expect(renderer).toBeDefined()
}

function inputHandler(): (sequence: string) => boolean {
  const handlers = rendererConfig?.prependInputHandlers
  expect(Array.isArray(handlers)).toBe(true)
  const [handler] = handlers as Array<(sequence: string) => boolean>
  expect(handler).toBeDefined()
  return handler!
}

function createMockClient(
  input: {
    readonly hydrateState?: ReturnType<typeof createInitialTuiState>
    readonly prompt?: (input: Parameters<TuiClient["sessions"]["prompt"]>[0]) => Promise<{ readonly sessionId: string }>
  } = {},
): MockClient {
  const hydrateCalls: string[] = []
  const promptCalls: Array<Parameters<TuiClient["sessions"]["prompt"]>[0]> = []
  const abortCalls: string[] = []
  const listeners = new Set<(event: RuntimeEvent) => void>()
  const client: MockClient = {
    hydrateCalls,
    promptCalls,
    abortCalls,
    sessions: {
      async list() {
        return []
      },
      async hydrate(sessionId) {
        hydrateCalls.push(sessionId)
        const state = input.hydrateState ?? { ...createInitialTuiState(true), sessionId }
        return { session: { id: state.sessionId ?? "", roots: ["/repo"] }, state }
      },
      async prompt(promptInput) {
        if (input.prompt) return await input.prompt(promptInput)
        promptCalls.push(promptInput)
        return { sessionId: promptInput.sessionId ?? "created-session" }
      },
      async abort(sessionId) {
        abortCalls.push(sessionId)
      },
    },
    commands: {
      async list() {
        return []
      },
      async execute() {
        return { ok: false }
      },
    },
    status: {
      async snapshot() {
        return { roots: ["/repo"], diagnostics: [] }
      },
    },
    events: {
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    publish(eventInput) {
      const event = { id: crypto.randomUUID(), timestamp: new Date(), ...eventInput } as RuntimeEvent
      for (const listener of listeners) listener(event)
    },
  }
  return client
}
