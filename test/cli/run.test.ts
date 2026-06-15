import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"

import { parseCommand } from "../../src/cli/commands"
import { runCli } from "../../src/cli/index"
import { ModelProviderError, type ModelRequest } from "../../src"

test("parses run prompt and resume run flags", () => {
  expect(parseCommand(["run", "hello", "--json", "--model", "fake/test"])).toEqual({
    ok: true,
    command: {
      name: "run",
      prompt: "hello",
      json: true,
      model: "fake/test",
      tools: [],
      disabledTools: [],
      mcp: [],
      disabledMcp: [],
      roots: [],
      team: false,
      timeoutMs: undefined,
      maxConcurrency: undefined,
    },
  })
  expect(parseCommand(["resume", "session-1", "--run", "next", "--json"])).toEqual({
    ok: true,
    command: { name: "resume", sessionId: "session-1", run: "next", json: true, model: undefined },
  })
})

test("oc2 run --json emits stable final output", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-cli-"))
  const stdout: string[] = []
  const result = await runCli({
    argv: ["run", "hello", "--json", "--model", "fake/test"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    fileExists: async () => false,
    streams: {
      stdout: (text) => {
        stdout.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(0)
  const output = JSON.parse(stdout.join(""))
  expect(output.finalAssistantText).toBe("fake response")
  expect(output.toolCalls).toEqual([])
  expect(output.errors).toEqual([])
  expect(output.exitStatus).toBe("completed")
  await rm(dataDir, { recursive: true, force: true })
})

test("oc2 run dispatches slash command prompts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-cli-"))
  const requests: ModelRequest[] = []
  const provider = {
    id: "fake",
    name: "Capturing",
    async listModels() {
      return [{ id: "test", supportsTools: true }]
    },
    async *stream(request: ModelRequest) {
      requests.push(request)
      yield { type: "text-delta" as const, text: "ok" }
      yield { type: "done" as const }
    },
  }

  const result = await runCli({
    argv: ["run", "/review diff --git a/file b/file\n+  indented context", "--json", "--model", "fake/test"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    fileExists: async () => false,
    modelProviders: [provider],
    streams: { stdout: () => undefined },
  })

  expect(result.exitCode).toBe(0)
  const userMessage = requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toContain("[SUBTASK] Review the following code changes")
  expect(userMessage?.content).toContain("diff --git a/file b/file\n+  indented context")
  await rm(dataDir, { recursive: true, force: true })
})

test("oc2 run text mode prints final assistant text", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-cli-"))
  const stdout: string[] = []
  const result = await runCli({
    argv: ["run", "hello", "--model", "fake/test"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    fileExists: async () => false,
    streams: {
      stdout: (text) => {
        stdout.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(0)
  expect(stdout.join("")).toBe("fake response\n")
  await rm(dataDir, { recursive: true, force: true })
})

test("oc2 run applies per-run disabled tool flags to model context", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-cli-"))
  const requests: ModelRequest[] = []
  const provider = {
    id: "fake",
    name: "Capturing",
    async listModels() {
      return [{ id: "test", supportsTools: true }]
    },
    async *stream(request: ModelRequest) {
      requests.push(request)
      yield { type: "text-delta" as const, text: "ok" }
      yield { type: "done" as const }
    },
  }

  const result = await runCli({
    argv: ["run", "hello", "--json", "--model", "fake/test", "--no-tool", "bash"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    fileExists: async () => false,
    modelProviders: [provider],
    streams: { stdout: () => undefined },
  })

  expect(result.exitCode).toBe(0)
  expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("bash")
  await rm(dataDir, { recursive: true, force: true })
})

test("failed non-interactive run exits non-zero with JSON", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-cli-"))
  const stdout: string[] = []
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

  const result = await runCli({
    argv: ["run", "hello", "--json", "--model", "fake/test"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    fileExists: async () => false,
    modelProviders: [failing],
    streams: {
      stdout: (text) => {
        stdout.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(1)
  const output = JSON.parse(stdout.join(""))
  expect(output.sessionId).toBeString()
  expect(output.errors[0].message).toBe("bad key")
  expect(output.exitStatus).toBe("failed")
  await rm(dataDir, { recursive: true, force: true })
})

test("oc2 tui dispatches to the TUI launcher", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-cli-"))
  const launches: unknown[] = []
  const result = await runCli({
    argv: ["tui", "--session", "session-1", "--model", "fake/test", "--root", "../other"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    fileExists: async () => false,
    tuiLauncher: async (options) => {
      launches.push({
        sessionId: options.sessionId,
        model: options.model,
        cwd: options.cwd,
        roots: options.roots,
        commands: options.commands?.list().map((command) => command.name),
      })
    },
  })

  expect(result.exitCode).toBe(0)
  expect(launches).toEqual([
    {
      sessionId: "session-1",
      model: "fake/test",
      cwd: "/repo",
      roots: ["../other"],
      commands: ["review", "clarify", "spec-planner", "spec-implement", "team-report", "init"],
    },
  ])
  await rm(dataDir, { recursive: true, force: true })
})
