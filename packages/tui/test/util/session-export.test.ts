import { describe, expect, test } from "bun:test"
import { collectExportSessionAsync } from "../../src/util/session-export"

const session = (id: string, created: number, title = id) => ({
  id,
  title,
  time: { created, updated: created },
})

const message = (sessionID: string, text: string) => ({
  info: { id: `${sessionID}_message`, sessionID, role: "user" as const },
  parts: [{ id: `${sessionID}_part`, sessionID, messageID: `${sessionID}_message`, type: "text" as const, text }],
})

describe("collectExportSessionAsync", () => {
  test("collects root messages, child sessions, nested children, and empty messages", async () => {
    const sessions = new Map([
      ["root", session("root", 0, "Root")],
      ["child", session("child", 1, "Child")],
      ["nested", session("nested", 2, "Nested")],
      ["empty", session("empty", 3, "Empty")],
    ])

    const exported = await collectExportSessionAsync(
      {
        get: async (sessionID) => sessions.get(sessionID)!,
        messages: async (sessionID) => (sessionID === "empty" ? [] : [message(sessionID, `${sessionID} message`)]),
        children: async (sessionID) => {
          if (sessionID === "root") return [sessions.get("child")!, sessions.get("empty")!]
          if (sessionID === "child") return [sessions.get("nested")!]
          return []
        },
      },
      "root",
    )

    expect(exported.info.id).toBe("root")
    expect(exported.messages[0]?.parts).toMatchObject([{ type: "text", text: "root message" }])
    expect(exported.children.map((node) => node.info.id)).toEqual(["child", "empty"])
    expect(exported.children[0]?.messages[0]?.parts).toMatchObject([{ type: "text", text: "child message" }])
    expect(exported.children[0]?.children.map((node) => node.info.id)).toEqual(["nested"])
    expect(exported.children[0]?.children[0]?.messages[0]?.parts).toMatchObject([
      { type: "text", text: "nested message" },
    ])
    expect(exported.children[1]?.messages).toEqual([])
  })

  test("orders siblings by created time then id", async () => {
    const sessions = new Map([
      ["root", session("root", 0)],
      ["later", session("later", 20)],
      ["same_b", session("same_b", 10)],
      ["same_a", session("same_a", 10)],
    ])

    const exported = await collectExportSessionAsync(
      {
        get: async (sessionID) => sessions.get(sessionID)!,
        messages: async () => [],
        children: async (sessionID) =>
          sessionID === "root" ? [sessions.get("later")!, sessions.get("same_b")!, sessions.get("same_a")!] : [],
      },
      "root",
    )

    expect(exported.children.map((node) => node.info.id)).toEqual(["same_a", "same_b", "later"])
  })
})
