import { describe, expect, test } from "bun:test"
import type { Session } from "@oc2-ai/sdk/v2"
import {
  HOME_ALL_SESSIONS_KEY,
  homeSessionMeta,
  homeSessionRecency,
  nextHomeSessionCursor,
  recentHomeRootSessions,
} from "../src/routes/home/session-destination"

const session = (input: {
  id: string
  updated: number
  parentID?: string
  archived?: number
  agent?: string
  tokens?: Session["tokens"]
}): Session => ({
  id: input.id,
  slug: input.id,
  projectID: "project",
  directory: "/repo",
  parentID: input.parentID,
  title: input.id,
  agent: input.agent,
  tokens: input.tokens,
  version: "test",
  time: { created: input.updated, updated: input.updated, archived: input.archived },
})

describe("TUI home resume surface", () => {
  test("sorts the top three visible root sessions by recency", () => {
    const sessions = [
      session({ id: "old", updated: 1 }),
      session({ id: "child", updated: 9, parentID: "new" }),
      session({ id: "new", updated: 8 }),
      session({ id: "archived", updated: 10, archived: 11 }),
      session({ id: "middle", updated: 5 }),
      session({ id: "fourth", updated: 4 }),
    ]

    expect(recentHomeRootSessions(sessions).map((item) => item.id)).toEqual(["new", "middle", "fourth"])
  })

  test("renders only truthful agent and token metadata", () => {
    const now = 3_600_000
    expect(homeSessionMeta(session({ id: "plain", updated: 0 }), now)).toBe("1h ago")
    expect(
      homeSessionMeta(
        session({
          id: "rich",
          updated: now - 60_000,
          agent: "build",
          tokens: { input: 10, output: 8, reasoning: 5, cache: { read: 3, write: 2 } },
        }),
        now,
      ),
    ).toBe("build · 28 tok · 1m ago")
    expect(homeSessionRecency(now - 30_000, now)).toBe("now")
  })

  test("wraps cursor movement and reserves ctrl+o for the home layer", () => {
    expect(nextHomeSessionCursor(0, -1, 3)).toBe(2)
    expect(nextHomeSessionCursor(2, 1, 3)).toBe(0)
    expect(nextHomeSessionCursor(7, 1, 0)).toBe(0)
    expect(HOME_ALL_SESSIONS_KEY).toBe("ctrl+o")
  })

  test("keeps prompt submission, resume states, and session-list grammar rendered", async () => {
    const home = await Bun.file(new URL("../src/routes/home.tsx", import.meta.url)).text()
    const dialog = await Bun.file(new URL("../src/component/dialog-session-list.tsx", import.meta.url)).text()
    const footer = await Bun.file(new URL("../src/feature-plugins/home/footer.tsx", import.meta.url)).text()

    expect(home).toContain("if (ref()?.current.input.trim()) return")
    expect(home).toContain("if (dialog.stack.length > 0) return")
    expect(home).toContain('event.ctrl && !event.meta && !event.shift && !event.option && event.name === "o"')
    expect(home).toContain('keymap.dispatchCommand("session.list")')
    expect(home).toContain('sync.status !== "complete" && recent().length === 0')
    expect(home).toContain('variant="loading"')
    expect(home).toContain('variant="empty"')
    expect(home).toContain('wrapMode="none"')
    expect(dialog).toContain("homeSessionMeta(x)")
    expect(dialog).toContain('variant="error"')
    expect(dialog).toContain('variant="loading"')
    expect(dialog).toContain('if (!searchResults.error || event.name !== "return") return')
    expect(footer).toContain('"● connected" : "◐ connecting"')
  })
})
