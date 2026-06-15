import { expect, test } from "bun:test"

import { parseTuiKey } from "../../src/tui/keymap"

test("parses model picker and variant key bindings", () => {
  expect(parseTuiKey("\u0010")).toEqual({ action: "model-picker-toggle" })
  expect(parseTuiKey("\u0016")).toEqual({ action: "variant-cycle" })
  expect(parseTuiKey("\u001b[A")).toEqual({ action: "picker-up" })
  expect(parseTuiKey("\u001b[B")).toEqual({ action: "picker-down" })
})

test("keeps existing TUI key bindings", () => {
  expect(parseTuiKey("\u0013")).toEqual({ action: "toggle-side-panel" })
  expect(parseTuiKey("\u0014")).toEqual({ action: "toggle-team-panel" })
  expect(parseTuiKey("\u001b[77~")).toEqual({ action: "toggle-mcp-panel" })
  expect(parseTuiKey("\r")).toEqual({ action: "submit" })
  expect(parseTuiKey("\u001b")).toEqual({ action: "escape" })
  expect(parseTuiKey("a")).toEqual({ action: "input", value: "a" })
})
