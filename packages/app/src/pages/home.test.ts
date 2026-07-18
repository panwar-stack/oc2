import { describe, expect, test } from "bun:test"
import {
  HOME_ALL_SESSIONS_KEYBIND,
  homeSessionTokenCount,
  nextHomeSessionCursor,
  recentHomeSessions,
} from "./home-model"

describe("redesigned home resume surface", () => {
  test("selects only the three most recently updated root records", () => {
    const records = [
      { session: { id: "old", time: { created: 1, updated: 2 } } },
      { session: { id: "new", time: { created: 1, updated: 8 } } },
      { session: { id: "middle", time: { created: 1, updated: 5 } } },
      { session: { id: "fourth", time: { created: 1, updated: 4 } } },
    ]

    expect(recentHomeSessions(records).map((record) => record.session.id)).toEqual(["new", "middle", "fourth"])
  })

  test("uses aggregate token data only when the session provides it", () => {
    expect(homeSessionTokenCount({})).toBeUndefined()
    expect(
      homeSessionTokenCount({
        tokens: { input: 10, output: 8, reasoning: 5, cache: { read: 3, write: 2 } },
      }),
    ).toBe(28)
  })

  test("wraps keyboard cursor movement without inventing a selection for an empty list", () => {
    expect(nextHomeSessionCursor(0, -1, 3)).toBe(2)
    expect(nextHomeSessionCursor(2, 1, 3)).toBe(0)
    expect(nextHomeSessionCursor(4, 1, 0)).toBe(0)
  })

  test("scopes the all-sessions shortcut and renders canonical resume states", async () => {
    const source = await Bun.file(new URL("./home.tsx", import.meta.url)).text()
    const layout = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()

    expect(HOME_ALL_SESSIONS_KEYBIND).toBe("ctrl+o")
    expect(source).toContain("keybind: HOME_ALL_SESSIONS_KEYBIND")
    expect(source).not.toContain('keybind: "mod+o"')
    expect(layout).toContain('id: "project.open"')
    expect(layout).toContain('keybind: "mod+o"')
    expect(source).toContain("<Show when={settings.general.newLayoutDesigns()} fallback={<LegacyHome />}>")
    expect(source).toContain('role="listbox"')
    expect(source).toContain('variant="empty"')
    expect(source).toContain('variant="loading"')
    expect(source).toContain('variant="error"')
    expect(source).toContain("whitespace-nowrap")
    expect(source).toContain("setSessionPromptHandoff(")
    expect(source).not.toContain("?prompt=")
    expect(source).toContain("Continue ⏎")
    expect(source).toContain("autofocus")
    expect(source).toContain("void loadAllSessions()")
    expect(source).toContain("if (!loaded) throw new Error")
    expect(source).toContain("/^[1-3]$/.test(event.key)")
    expect(source).not.toContain("onDigit={")
    expect(source).not.toContain("up to date")
    expect(source).toContain('retry() ? "▲" : busy() ? "●"')
    expect(source).toContain("text-v2-state-fg-warning")
  })
})
