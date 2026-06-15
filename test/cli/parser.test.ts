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
  expect(parseCommand(["mcp", "list", "--json"])).toEqual({
    ok: true,
    command: { name: "mcp", action: "list", json: true },
  })
  expect(parseCommand(["commands", "--json"])).toEqual({ ok: true, command: { name: "commands", json: true } })
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
    },
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
    },
  })
})

test("parses tui resume and model flags", () => {
  expect(parseCommand(["tui", "--session", "session-1", "--model", "fake/test", "--root", "/repo"])).toEqual({
    ok: true,
    command: { name: "tui", sessionId: "session-1", model: "fake/test", roots: ["/repo"] },
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
