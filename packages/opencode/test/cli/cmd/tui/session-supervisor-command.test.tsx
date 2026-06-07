import { expect, test } from "bun:test"
import { SessionPaths } from "../../../../src/server/routes/instance/httpapi/groups/session"

test("supervisor session paths are unavailable to TUI commands", () => {
  expect("supervisor" in SessionPaths).toBe(false)
  expect("supervisorActivity" in SessionPaths).toBe(false)
  expect("supervisorReport" in SessionPaths).toBe(false)
})
