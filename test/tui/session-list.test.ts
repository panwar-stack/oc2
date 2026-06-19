import { expect, test } from "bun:test"

import { formatSessionListDialog, type SessionListState } from "../../src/tui/app"
import { createInitialTuiState } from "../../src/tui/state"

test("formats session list loading, empty, error, and selection states", () => {
  const state = { ...createInitialTuiState(true), sessionId: "s1" }

  expect(formatSessionListDialog(state, sessionList({ loading: true }))).toContain("Loading sessions...")
  expect(formatSessionListDialog(state, sessionList())).toContain("No sessions found")
  expect(formatSessionListDialog(state, sessionList({ error: "database unavailable" }))).toContain(
    "error: database unavailable",
  )

  const output = formatSessionListDialog(
    state,
    sessionList({
      selectedIndex: 1,
      sessions: [
        { id: "s1", title: "Current", roots: ["/repo"] },
        { id: "s2", title: "Existing", roots: ["/repo", "/other"] },
      ],
    }),
  )

  expect(output).toContain("current: s1")
  expect(output).toContain("  s1 Current roots=/repo")
  expect(output).toContain("> s2 Existing roots=/repo,/other")
  expect(output).toContain("Return switch")
})

function sessionList(input: Partial<SessionListState> = {}): SessionListState {
  return {
    loading: false,
    sessions: [],
    selectedIndex: 0,
    ...input,
  }
}
