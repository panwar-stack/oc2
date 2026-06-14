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
    },
  })
})

test("parses tui resume and model flags", () => {
  expect(parseCommand(["tui", "--session", "session-1", "--model", "fake/test"])).toEqual({
    ok: true,
    command: { name: "tui", sessionId: "session-1", model: "fake/test" },
  })
})

test("rejects unknown commands and invalid arguments", () => {
  expect(parseCommand(["unknown"])).toEqual({ ok: false, message: "Unknown command: unknown" })
  expect(parseCommand(["version", "extra"])).toEqual({
    ok: false,
    message: "version does not accept positional arguments",
  })
})
