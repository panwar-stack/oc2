import { expect, test } from "bun:test"

import { createTuiKeymap, normalizeTuiKeyName, parseTuiKey } from "../../src/tui/keymap"

test("parses command palette, model picker, and variant key bindings", () => {
  expect(parseTuiKey("\u0010")).toEqual({ action: "command-palette" })
  expect(parseTuiKey("\u0010", "list")).toEqual({ action: "picker-up" })
  expect(parseTuiKey("\u0016")).toEqual({ action: "variant-cycle" })
  expect(parseTuiKey("\u001b[A")).toEqual({ action: "history-prev" })
  expect(parseTuiKey("\u001b[B")).toEqual({ action: "history-next" })
  expect(parseTuiKey("\u001b[A", "list")).toEqual({ action: "picker-up" })
  expect(parseTuiKey("\u001b[B", "dialog")).toEqual({ action: "picker-down" })
})

test("keeps existing TUI key bindings", () => {
  expect(parseTuiKey("\u0013")).toEqual({ action: "toggle-side-panel" })
  expect(parseTuiKey("\u0014")).toEqual({ action: "toggle-team-panel" })
  expect(parseTuiKey("\u001b[77~")).toEqual({ action: "toggle-mcp-panel" })
  expect(parseTuiKey("\r")).toEqual({ action: "submit" })
  expect(parseTuiKey("\n")).toEqual({ action: "newline" })
  expect(parseTuiKey("\u001b\r")).toEqual({ action: "newline" })
  expect(parseTuiKey("\u001b\n")).toEqual({ action: "newline" })
  expect(parseTuiKey("\u001b[13;2u")).toEqual({ action: "newline" })
  expect(parseTuiKey("\u001b[13;5u")).toEqual({ action: "newline" })
  expect(parseTuiKey("\u001b[27;5;13~")).toEqual({ action: "newline" })
  expect(parseTuiKey("\u001b")).toEqual({ action: "escape" })
  expect(parseTuiKey("a")).toEqual({ action: "input", value: "a" })
  expect(parseTuiKey("é你🙂")).toEqual({ action: "input", value: "é你🙂" })
})

test("parses prompt editing key bindings", () => {
  expect(parseTuiKey("\u001b[D")).toEqual({ action: "cursor-left" })
  expect(parseTuiKey("\u001b[C")).toEqual({ action: "cursor-right" })
  expect(parseTuiKey("\u001b[H")).toEqual({ action: "cursor-start" })
  expect(parseTuiKey("\u001b[1~")).toEqual({ action: "cursor-start" })
  expect(parseTuiKey("\u001b[F")).toEqual({ action: "cursor-end" })
  expect(parseTuiKey("\u001b[4~")).toEqual({ action: "cursor-end" })
  expect(parseTuiKey("\u001b[3~")).toEqual({ action: "delete-forward" })
  expect(parseTuiKey("\u001b[200~hello\n世界\u001b[201~")).toEqual({ action: "paste", value: "hello\n世界" })
})

test("normalizes key aliases", () => {
  expect(normalizeTuiKeyName("enter")).toBe("return")
  expect(normalizeTuiKeyName("esc")).toBe("escape")
  expect(normalizeTuiKeyName("pgdown")).toBe("pagedown")
  expect(normalizeTuiKeyName("pgup")).toBe("pageup")
})

test("handles leader key bindings with timeout", () => {
  let now = 1000
  const keymap = createTuiKeymap({ now: () => now, leaderTimeoutMs: 2000 })

  expect(keymap.handle("\u0018")).toEqual({ action: "leader" })
  expect(keymap.handle("b")).toEqual({ action: "toggle-side-panel" })
  expect(keymap.handle("\u0018")).toEqual({ action: "leader" })
  now += 2001
  expect(keymap.handle("q")).toEqual({ action: "input", value: "q" })
  expect(keymap.handle("\u0018")).toEqual({ action: "leader" })
  expect(keymap.handle("m")).toEqual({ action: "model-picker-toggle" })
})
