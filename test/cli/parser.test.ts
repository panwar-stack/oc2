import { expect, test } from "bun:test"

import { parseCommand } from "../../src/cli/commands"

test("parses basic commands and JSON flags", () => {
  expect(parseCommand(["version", "--json"])).toEqual({ ok: true, command: { name: "version", json: true } })
  expect(parseCommand(["diagnostics"])).toEqual({ ok: true, command: { name: "diagnostics", json: false } })
  expect(parseCommand(["config", "path"])).toEqual({
    ok: true,
    command: { name: "config", action: "path", json: false },
  })
  expect(parseCommand(["tools", "list", "--json"])).toEqual({
    ok: true,
    command: { name: "tools", action: "list", json: true },
  })
  expect(parseCommand(["tools", "enable", "read"])).toEqual({
    ok: true,
    command: { name: "tools", action: "enable", toolName: "read", json: false },
  })
  expect(parseCommand(["mcp", "list", "--json"])).toEqual({
    ok: true,
    command: { name: "mcp", action: "list", json: true },
  })
  expect(parseCommand(["commands", "--json"])).toEqual({ ok: true, command: { name: "commands", json: true } })
  expect(parseCommand(["sessions", "list"])).toEqual({
    ok: true,
    command: { name: "sessions", action: "list", json: false },
  })
  expect(parseCommand(["memory", "list", "--repository", "../repo", "--json"])).toEqual({
    ok: true,
    command: { name: "memory", action: "list", repository: "../repo", json: true },
  })
})

test("parses MCP management commands", () => {
  expect(parseCommand(["mcp", "enable", "browser"])).toEqual({
    ok: true,
    command: { name: "mcp", action: "enable", serverId: "browser", json: false },
  })
  expect(parseCommand(["mcp", "disable", "browser", "--json"])).toEqual({
    ok: true,
    command: { name: "mcp", action: "disable", serverId: "browser", json: true },
  })
  expect(parseCommand(["mcp", "test", "browser"])).toEqual({
    ok: true,
    command: { name: "mcp", action: "test", serverId: "browser", json: false },
  })
})

test("parses config get and set", () => {
  expect(parseCommand(["config", "get", "model.provider", "--json"])).toEqual({
    ok: true,
    command: { name: "config", action: "get", key: "model.provider", json: true },
  })
  expect(parseCommand(["config", "set", "runtime.logLevel", "debug"])).toEqual({
    ok: true,
    command: { name: "config", action: "set", key: "runtime.logLevel", value: "debug", json: false },
  })
})

test("parses run help and execution", () => {
  expect(parseCommand(["run", "--help"])).toEqual({ ok: true, command: { name: "run", help: true } })
  expect(parseCommand(["run", "hello"])).toEqual({
    ok: true,
    command: {
      name: "run",
      prompt: "hello",
      json: false,
      model: undefined,
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
  expect(parseCommand(["run", "hello", "--team", "--timeout", "5000", "--max-concurrency", "2"])).toMatchObject({
    ok: true,
    command: { name: "run", team: true, timeoutMs: 5000, maxConcurrency: 2 },
  })
  expect(parseCommand(["run", "hello", "--timeout", "0"])).toEqual({
    ok: false,
    message: "--timeout must be a positive integer",
  })
})

test("parses repeated run root flags in order", () => {
  expect(parseCommand(["run", "hello", "--root", ".", "--root", "../reference"])).toEqual({
    ok: true,
    command: {
      name: "run",
      prompt: "hello",
      json: false,
      model: undefined,
      tools: [],
      disabledTools: [],
      mcp: [],
      disabledMcp: [],
      roots: [".", "../reference"],
      team: false,
      timeoutMs: undefined,
      maxConcurrency: undefined,
    },
  })
})

test("parses tui resume and model flags", () => {
  expect(parseCommand(["tui", "--session", "session-1", "--model", "fake/test", "--root", "/repo"])).toEqual({
    ok: true,
    command: { name: "tui", sessionId: "session-1", model: "fake/test", roots: ["/repo"] },
  })
  expect(parseCommand(["resume", "session-1", "--tui", "--model", "fake/test", "--root", "/repo"])).toEqual({
    ok: true,
    command: { name: "resume", sessionId: "session-1", tui: true, json: false, model: "fake/test", roots: ["/repo"] },
  })
})

test("parses export format and recursive flags", () => {
  expect(parseCommand(["export", "session-1", "--format", "markdown"])).toEqual({
    ok: true,
    command: { name: "export", sessionId: "session-1", format: "markdown", recursive: false },
  })
  expect(parseCommand(["export", "session-1", "--format", "json", "--recursive"])).toEqual({
    ok: true,
    command: { name: "export", sessionId: "session-1", format: "json", recursive: true },
  })
})

test("rejects unknown commands and invalid arguments", () => {
  expect(parseCommand(["unknown"])).toEqual({ ok: false, message: "Unknown command: unknown" })
  expect(parseCommand(["version", "extra"])).toEqual({
    ok: false,
    message: "version does not accept positional arguments",
  })
})
