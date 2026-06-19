import { expect, test } from "bun:test"

import { renderTui } from "../../src/tui/app"
import { createPromptEditor } from "../../src/tui/prompt-editor"
import { createInitialTuiState } from "../../src/tui/state"

test("renders slash autocomplete above the prompt", () => {
  const output = renderTui(
    {
      ...createInitialTuiState(true),
      slashActive: true,
      slashQuery: "rev",
      slashMatches: [{ name: "review", display: "/review", description: "review changes", source: "builtin" }],
    },
    "/rev",
  )

  expect(output.indexOf("/review")).toBeLessThan(output.indexOf("Prompt> /rev"))
  expect(output).toContain("review changes [builtin]")
})

test("preserves slash prompt text when an error is rendered", () => {
  const output = renderTui(
    {
      ...createInitialTuiState(true),
      errors: ["Unknown slash command: /missing"],
      diagnostics: [{ code: "tui.slash", message: "Unknown slash command: /missing" }],
    },
    "/missing now",
  )

  expect(output).toContain("Error: Unknown slash command: /missing")
  expect(output).toContain("Prompt> /missing now")
})

test("prompt editor inserts multiline text at the cursor", () => {
  const editor = createPromptEditor()

  editor.insertText("helo")
  editor.moveLeft()
  editor.insertText("l")
  editor.insertNewline()
  editor.insertText("world")

  expect(editor.text()).toBe("hell\nworldo")
})

test("prompt editor deletes Unicode input without splitting graphemes", () => {
  const editor = createPromptEditor()

  editor.insertText("a👨‍👩‍👧‍👦éb")
  editor.moveLeft()
  editor.deleteBackward()
  editor.deleteBackward()

  expect(editor.text()).toBe("ab")
})

test("prompt editor normalizes pasted newlines", () => {
  const editor = createPromptEditor()

  editor.insertText("first\r\nsecond\rthird")

  expect(editor.text()).toBe("first\nsecond\nthird")
})

test("prompt editor navigates history and restores drafts", () => {
  const editor = createPromptEditor()

  editor.recordHistory("first")
  editor.recordHistory("second")
  editor.insertText("draft")

  expect(editor.historyPrev()).toBe(true)
  expect(editor.text()).toBe("second")
  expect(editor.historyPrev()).toBe(true)
  expect(editor.text()).toBe("first")
  expect(editor.historyNext()).toBe(true)
  expect(editor.text()).toBe("second")
  expect(editor.historyNext()).toBe(true)
  expect(editor.text()).toBe("draft")
})
