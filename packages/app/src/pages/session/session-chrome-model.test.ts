import { describe, expect, test } from "bun:test"
import { contextGaugeState, groupTeamTasks, rootSessionID, stableAgentColor, visibleTodos } from "./session-chrome-model"

describe("session aggregate chrome", () => {
  test("uses the 70 and 90 percent context thresholds", () => {
    expect(contextGaugeState(69)).toEqual({ level: "success", percent: 69 })
    expect(contextGaugeState(70)).toEqual({ level: "warning", percent: 70, action: "compact" })
    expect(contextGaugeState(89)).toEqual({ level: "warning", percent: 89, action: "compact" })
    expect(contextGaugeState(90)).toEqual({ level: "danger", percent: 90, action: "fork" })
    expect(contextGaugeState(undefined)).toBeUndefined()
  })

  test("bounds todo rows and reports stable overflow", () => {
    const todos = Array.from({ length: 8 }, (_, index) => ({
      content: `task ${index}`,
      status: index === 0 ? "in_progress" : "pending",
      priority: "medium",
    }))
    expect(visibleTodos(todos, 5)).toEqual({ items: todos.slice(0, 5), overflow: 3 })
  })

  test("groups task states without losing dependency data", () => {
    const tasks = [
      {
        id: "work",
        team_id: "team",
        description: "work",
        status: "in_progress",
        dependency_ids: ["done"],
        time_created: 1,
        time_updated: 2,
      },
      {
        id: "blocked",
        team_id: "team",
        description: "blocked",
        status: "blocked",
        time_created: 1,
        time_updated: 2,
      },
      {
        id: "done",
        team_id: "team",
        description: "done",
        status: "completed",
        time_created: 1,
        time_updated: 2,
      },
    ]
    const groups = groupTeamTasks(tasks)
    expect(groups.working[0]?.dependency_ids).toEqual(["done"])
    expect(groups["needs-you"].map((task) => task.id)).toEqual(["blocked"])
    expect(groups.completed.map((task) => task.id)).toEqual(["done"])
  })

  test("resolves child team views to the root session without looping on malformed ancestry", () => {
    const sessions = [
      { id: "lead" },
      { id: "child", parentID: "lead" },
      { id: "nested", parentID: "child" },
      { id: "cycle-a", parentID: "cycle-b" },
      { id: "cycle-b", parentID: "cycle-a" },
    ]
    expect(rootSessionID(sessions, "nested")).toBe("lead")
    expect(rootSessionID(sessions, "cycle-a")).toBe("cycle-a")
  })

  test("guards team task payloads and does not fetch unused message bodies", async () => {
    const [board, details] = await Promise.all([
      Bun.file(import.meta.dir + "/team-board.tsx").text(),
      Bun.file(import.meta.dir + "/session-aggregate-chrome.tsx").text(),
    ])
    expect(board).toContain("Array.isArray(result.data) ? result.data : []")
    expect(board).toContain("rootSessionID(sync.data.session, props.sessionID)")
    expect(board).not.toContain("sdk.client.team.messages(")
    expect(details).toContain("const tasks = Array.isArray(result) ? result : []")
    expect(details).toContain("rootSessionID(sync.data.session, props.sessionID)")
  })

  test("keeps agent color stable and uses container responsive columns", async () => {
    expect(stableAgentColor("pr-g-impl")).toBe(stableAgentColor("pr-g-impl"))
    const css = await Bun.file(import.meta.dir + "/team-board.css").text()
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)")
    expect(css).toContain("@container (min-width: 760px)")
    expect(css).toContain("repeat(2, minmax(0, 1fr))")
    expect(css).toContain("@container (min-width: 1100px)")
    expect(css).toContain("repeat(3, minmax(0, 1fr))")
  })
})
