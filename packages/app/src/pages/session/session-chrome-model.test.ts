import { describe, expect, test } from "bun:test"
import { contextGaugeState, stableAgentColor, teamBoardFeatureEnabled, visibleTodos } from "./session-chrome-model"

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

  test("makes the team board reachable for populated redesign sessions", () => {
    expect(teamBoardFeatureEnabled({ redesign: true, sessionID: "ses" })).toBe(true)
    expect(teamBoardFeatureEnabled({ redesign: false, sessionID: "ses" })).toBe(false)
    expect(teamBoardFeatureEnabled({ redesign: true })).toBe(false)
  })

  test("uses authoritative Board projections without client-side joins", async () => {
    const [board, details] = await Promise.all([
      Bun.file(import.meta.dir + "/team-board.tsx").text(),
      Bun.file(import.meta.dir + "/session-aggregate-chrome.tsx").text(),
    ])
    expect(board).toContain("sdk.client.team.history({ viewer_session_id }")
    expect(board).toContain(".board({ teamID, viewer_session_id }")
    expect(board).toContain("acceptBoardSnapshot")
    expect(board).toContain("window.setInterval(refreshVisible, 30_000)")
    expect(board).toContain("sdk.connection.status")
    expect(board).not.toContain("sdk.client.team.tasks(")
    expect(board).not.toContain("sdk.client.team.messages(")
    expect(board).not.toContain("sync.data.permission")
    expect(board).not.toContain("sync.data.question")
    expect(details).toContain("sdk.client.team.board(")
    expect(details).not.toContain("sdk.client.team.tasks(")
    expect(details).not.toContain("sync.data.permission")
    expect(details).not.toContain("sync.data.question")
  })

  test("keeps agent color stable and uses container responsive columns", async () => {
    expect(stableAgentColor("pr-g-impl")).toBe(stableAgentColor("pr-g-impl"))
    const css = await Bun.file(import.meta.dir + "/team-board.css").text()
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)")
    expect(css).toContain("@media (min-width: 760px)")
    expect(css).toContain("repeat(2, minmax(0, 1fr))")
    expect(css).toContain("@media (min-width: 1100px)")
    expect(css).toContain("repeat(3, minmax(0, 1fr))")
  })

  test("derives queued presentation from durable pending inputs", async () => {
    const [session, submit, settings] = await Promise.all([
      Bun.file(import.meta.dir + "/../session.tsx").text(),
      Bun.file(import.meta.dir + "/../../components/prompt-input/submit.ts").text(),
      Bun.file(import.meta.dir + "/../../context/settings.tsx").text(),
    ])
    expect(session).toContain('pending({ sessionID, state: "pending", delivery: "queue" }')
    expect(session).toContain("pendingInputs: result.value.inputs")
    expect(session).toContain("queueRetry?.draft === serialized ? queueRetry.id")
    expect(session).not.toContain("followup.v1")
    expect(session).not.toContain("queuedFollowups()[0]")
    expect(submit).toContain("input.client.v2.session.prompt")
    expect(submit).toContain('delivery: "queue"')
    expect(settings).toContain('setStore("general", "followup", value)')
  })
})
