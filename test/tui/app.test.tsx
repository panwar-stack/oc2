import { expect, mock, test } from "bun:test"

import { defaultConfig } from "../../src"
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
  spread: (element: { props: Record<string, unknown>; children?: unknown[] }, props: Record<string, unknown>) => {
    element.props = props
    element.children = props.children as unknown[] | undefined
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
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout })

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
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout })

  await waitForRenderer()
  const shell = renderedShell?.() as MockNode
  const text = collectText(shell)

  expect(Object.values(STATIC_TUI_SHELL_LABELS)).toEqual([
    "oc2 transcript viewport",
    "sidebar placeholder",
    "footer placeholder",
    "prompt container - prompt submission disabled in renderer shell PR",
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
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout })

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
  const launched = launchTui({ config: defaultConfig, cwd: "/repo", stdout })

  await waitForRenderer()
  expect(inputHandler()("\u0004")).toBe(true)
  await launched

  expect(renderer?.isDestroyed).toBe(true)
  expect(stdout.output).toContain("\x1b[0m\x1b[?25h")
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
  setTerminalTitle(title: string): void
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
  const content = typeof current.props.content === "string" ? current.props.content : ""
  return [content, ...(current.children ?? []).map(collectText)].filter(Boolean).join("\n")
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
