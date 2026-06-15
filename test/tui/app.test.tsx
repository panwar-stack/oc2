import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"

import { expect, test } from "bun:test"

import { defaultConfig } from "../../src"
import { launchTui, renderTui } from "../../src/tui/app"
import { createInitialTuiState } from "../../src/tui/state"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

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

test("launchTui completes slash command with Tab and Enter", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-tui-"))
  const stdin = new PassThrough()
  const output: string[] = []
  let sawAutocomplete = false
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const stdout = { columns: 100, write: (_chunk: string) => undefined }
  const completed = new Promise<void>((resolve) => {
    stdout.write = (chunk: string) => {
      output.push(chunk)
      const rendered = output.join("")
      if (rendered.includes("Prompt> /review ")) sawAutocomplete = true
      if (rendered.includes("assistant> fake response")) {
        stdin.write("\u0003")
        resolve()
      }
    }
  })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    model: "fake/test",
    providers: [provider],
    stdin,
    stdout,
  })

  stdin.write("/rev\t\r")
  await completed
  await launched

  expect(sawAutocomplete).toBe(true)
  expect(output.join("")).toContain("/review")
  expect(output.join("")).toContain("assistant> fake response")
  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toContain("[SUBTASK] Review the following code changes")
  await rm(dataDir, { recursive: true, force: true })
})

test("launchTui does not mutate prompt input while model picker is open", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-tui-"))
  const stdin = new PassThrough()
  const output: string[] = []
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const stdout = { columns: 100, write: (_chunk: string) => undefined }
  const completed = new Promise<void>((resolve) => {
    stdout.write = (chunk: string) => {
      output.push(chunk)
      if (output.join("").includes("assistant> fake response")) {
        stdin.write("\u0003")
        resolve()
      }
    }
  })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    model: "fake/test",
    providers: [provider],
    stdin,
    stdout,
  })

  stdin.write("hello\u0010search\u0010\r")
  await completed
  await launched

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toBe("hello")
  await rm(dataDir, { recursive: true, force: true })
})

test("launchTui handles split arrow escape sequences while model picker is open", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-tui-"))
  const stdin = new PassThrough()
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const stdout = { columns: 100, write: (_chunk: string) => undefined }
  const completed = new Promise<void>((resolve) => {
    stdout.write = (chunk: string) => {
      if (chunk.includes("assistant> fake response")) {
        stdin.write("\u0003")
        resolve()
      }
    }
  })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    model: "fake/test",
    providers: [provider],
    stdin,
    stdout,
  })

  stdin.write("hello\u0010")
  stdin.write("\u001b")
  stdin.write("[A")
  stdin.write("\u0010\r")
  await completed
  await launched

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toBe("hello")
  await rm(dataDir, { recursive: true, force: true })
})

test("launchTui handles fully split arrow escape sequences while model picker is open", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-tui-"))
  const stdin = new PassThrough()
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const stdout = { columns: 100, write: (_chunk: string) => undefined }
  const completed = new Promise<void>((resolve) => {
    stdout.write = (chunk: string) => {
      if (chunk.includes("assistant> fake response")) {
        stdin.write("\u0003")
        resolve()
      }
    }
  })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    model: "fake/test",
    providers: [provider],
    stdin,
    stdout,
  })

  stdin.write("hello\u0010")
  stdin.write("\u001b")
  stdin.write("[")
  stdin.write("A")
  stdin.write("\u0010\r")
  await completed
  await launched

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toBe("hello")
  await rm(dataDir, { recursive: true, force: true })
})

test("launchTui buffers async split arrow escape sequences while model picker is open", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-tui-"))
  const stdin = new PassThrough()
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const stdout = { columns: 100, write: (_chunk: string) => undefined }
  const completed = new Promise<void>((resolve) => {
    stdout.write = (chunk: string) => {
      if (chunk.includes("assistant> fake response")) {
        stdin.write("\u0003")
        resolve()
      }
    }
  })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    model: "fake/test",
    providers: [provider],
    stdin,
    stdout,
  })

  stdin.write("hello\u0010")
  stdin.write("\u001b")
  await delay(5)
  stdin.write("[")
  await delay(5)
  stdin.write("A")
  stdin.write("\u0010\r")
  await completed
  await launched

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toBe("hello")
  await rm(dataDir, { recursive: true, force: true })
})

test("launchTui preserves split Alt+Enter newline input", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-tui-"))
  const stdin = new PassThrough()
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const stdout = { columns: 100, write: (_chunk: string) => undefined }
  const completed = new Promise<void>((resolve) => {
    stdout.write = (chunk: string) => {
      if (chunk.includes("assistant> fake response")) {
        stdin.write("\u0003")
        resolve()
      }
    }
  })
  const launched = launchTui({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    model: "fake/test",
    providers: [provider],
    stdin,
    stdout,
  })

  stdin.write("hello")
  stdin.write("\u001b")
  stdin.write("\r")
  stdin.write("world\r")
  await completed
  await launched

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toBe("hello\nworld")
  await rm(dataDir, { recursive: true, force: true })
})
