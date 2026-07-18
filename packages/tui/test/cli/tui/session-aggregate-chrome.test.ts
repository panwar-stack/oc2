import { describe, expect, test } from "bun:test"
import { groupDialogTeamTasks } from "../../../src/component/dialog-team"
import { sessionActivity, sessionContextHealth } from "../../../src/routes/session/chrome"
import {
  SESSION_SIDEBAR_WIDTH,
  sessionSidebarContentWidth,
  sessionSidebarPresentation,
} from "../../../src/routes/session/sidebar"
import { contextGaugeState, orderSidebarTodos } from "../../../src/routes/session/sidebar-sections"

describe("TUI session aggregate chrome", () => {
  test("uses a 34-cell sidebar at the 100-column breakpoint", () => {
    expect(SESSION_SIDEBAR_WIDTH).toBe(34)
    expect(sessionSidebarPresentation({ width: 99, parent: false, open: false, preference: "auto" })).toBe("hidden")
    expect(sessionSidebarPresentation({ width: 100, parent: false, open: false, preference: "auto" })).toBe("wide")
    expect(sessionSidebarPresentation({ width: 80, parent: false, open: true, preference: "hide" })).toBe("overlay")
    expect(sessionSidebarPresentation({ width: 120, parent: true, open: true, preference: "auto" })).toBe("hidden")
    expect(sessionSidebarContentWidth(100, "wide")).toBe(62)
    expect(sessionSidebarContentWidth(80, "overlay")).toBe(76)
  })

  test("uses exact context thresholds, actions, and eight gauge cells", () => {
    expect(contextGaugeState(69, 100).level).toBe("normal")
    expect(contextGaugeState(70, 100)).toMatchObject({ level: "warning", action: "compact suggested" })
    expect(contextGaugeState(90, 100)).toMatchObject({ level: "danger", action: "fork or new session" })
    expect(Bun.stringWidth(contextGaugeState(70, 100).gauge ?? "")).toBe(8)
    expect(sessionContextHealth({ tokens: 90, limit: 100 }).label).toBe("ctx 90 ▰▰▰▰▰▰▰▱ 90%")
  })

  test("keeps waiting, local work, and teammate work truthful", () => {
    expect(sessionActivity({ waiting: true, status: { type: "busy" } })).toEqual({
      type: "waiting",
      interruptible: false,
    })
    expect(
      sessionActivity({ waiting: false, status: { type: "busy" }, task: "Implement the board", started: 10 }),
    ).toEqual({ type: "session", interruptible: true, task: "Implement the board", started: 10 })
    expect(
      sessionActivity({ waiting: false, status: { type: "idle" }, teammate: { name: "pr-g", task: "Review" } }),
    ).toEqual({ type: "team", interruptible: false, who: "pr-g", task: "Review", started: undefined })
  })

  test("orders todos and preserves task assignees and dependencies", () => {
    expect(
      orderSidebarTodos([
        { content: "done", status: "completed" },
        { content: "pending", status: "pending" },
        { content: "active", status: "in_progress" },
        { content: "cancelled", status: "cancelled" },
      ]).map(({ item }) => item.content),
    ).toEqual(["active", "pending", "done", "cancelled"])

    const task = {
      id: "task",
      team_id: "team",
      description: "Blocked task",
      status: "blocked",
      assignee: "pr-g",
      dependency_ids: ["dep"],
      time_created: 1,
      time_updated: 2,
    }
    expect(groupDialogTeamTasks([task])["needs-you"][0]).toEqual(task)
  })

  test("uses one-cell todo glyphs and clipped rows", async () => {
    const source = await Bun.file(import.meta.dir + "/../../../src/component/todo-item.tsx").text()
    expect(source).toContain('wrapMode="none"')
    expect(source).toContain('? "◐"')
    expect(source).not.toContain("[✓]")
    expect(source).not.toContain('wrapMode="word"')
  })
})
