import { describe, expect, test } from "bun:test"
import { Definitions } from "../../../src/config/keybind"
import { initialRoute } from "../../../src/context/route"

describe("TUI Team Board route and bindings", () => {
  test("validates and retains session view and selected team state", () => {
    expect(initialRoute({ type: "session", sessionID: "session", view: "tasks", teamID: "team" })).toEqual({
      type: "session",
      sessionID: "session",
      view: "tasks",
      teamID: "team",
    })
    expect(initialRoute({ type: "session", sessionID: "session", view: "invalid", teamID: 42 })).toEqual({
      type: "session",
      sessionID: "session",
      view: undefined,
      teamID: undefined,
    })
  })

  test("owns ctrl+y without changing background or variant controls", () => {
    expect(Definitions.team_board_toggle.default).toBe("ctrl+y")
    expect(Definitions.session_background.default).toBe("ctrl+b")
    expect(Definitions.variant_cycle.default).toBe("ctrl+t")
  })

  test("keeps one mounted session owner and makes hidden session controls inert", async () => {
    const [app, session, board] = await Promise.all([
      Bun.file(new URL("../../../src/app.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../../src/routes/session/index.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../../src/routes/session/team-board.tsx", import.meta.url)).text(),
    ])
    expect(app).toContain('when={route.data.type === "session" ? route.data.sessionID : undefined} keyed')
    expect(session).toContain('visible={sessionView() === "session"}')
    expect(session).toContain('visible={visible() && sessionView() === "session"}')
    expect(session).toContain('disabled={disabled() || sessionView() !== "session"}')
    expect(session).toContain("sessionFocus = renderer.currentFocusedRenderable")
    expect(session).toContain("sessionFocus.focus()")
    expect(session).toContain('id="session-composer-layer" visible={sessionView() === "session"}')
    expect(session).toContain('id="session-persistent-chrome"')
    expect(session.indexOf('id="session-persistent-chrome"')).toBeGreaterThan(
      session.indexOf('id="session-composer-layer"'),
    )
    const persistentChrome = session.slice(session.indexOf('id="session-persistent-chrome"'))
    expect(persistentChrome).toContain("<SessionWorkingLine")
    expect(persistentChrome).toContain("<SessionStatusLine")
    expect(board).toContain("props.onBack()")
    expect(board).toContain('event.name === "escape"')
  })

  test("uses authoritative Board/history APIs without local joins or guessed events", async () => {
    const board = await Bun.file(new URL("../../../src/routes/session/team-board.tsx", import.meta.url)).text()
    expect(board).toContain("sdk.client.team.history")
    expect(board).toContain(".board({ teamID, viewer_session_id: viewerSessionID }")
    expect(board).toContain("viewer_session_id")
    expect(board).not.toContain("client.team.tasks")
    expect(board).not.toContain("client.team.messages")
    expect(board).not.toContain("team.board.updated")
    expect(board).toContain("30_000")
    const aggregateCounts = board.indexOf("`${data().counts.workers} workers")
    expect(board.slice(Math.max(0, aggregateCounts - 180), aggregateCounts)).toContain("fg={theme.textMuted}")
    const workerDependencies = board.indexOf("waits on {Locale.truncate(props.dependencies")
    expect(board.slice(Math.max(0, workerDependencies - 100), workerDependencies)).toContain("fg={theme.textMuted}")
    const taskMetadata = board.indexOf("`${task.status} · ${task.assignee")
    expect(board.slice(Math.max(0, taskMetadata - 180), taskMetadata)).toContain("fg={theme.textMuted}")
  })
})
