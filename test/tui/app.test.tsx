import { expect, test } from "bun:test"

import { renderTui } from "../../src/tui/app"
import { createInitialTuiState } from "../../src/tui/state"

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
