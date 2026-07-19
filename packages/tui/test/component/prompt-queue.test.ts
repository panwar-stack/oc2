import { describe, expect, test } from "bun:test"
import {
  acceptPendingSnapshot,
  createQueueInputID,
  nextQueueAttempt,
  toQueuedPrompt,
} from "../../src/component/prompt/queue"

describe("TUI prompt queue", () => {
  test("converts only durable prompt text, files, and agents", () => {
    expect(
      toQueuedPrompt("Review this", [
        {
          type: "file",
          mime: "text/typescript",
          filename: "board.ts",
          url: "file:///board.ts",
          source: { type: "file", path: "/board.ts", text: { start: 0, end: 8, value: "@board.ts" } },
        },
        { type: "agent", name: "reviewer", source: { start: 9, end: 18, value: "@reviewer" } },
        { type: "text", text: "expanded paste" },
      ]),
    ).toEqual({
      text: "Review this",
      files: [
        {
          uri: "file:///board.ts",
          mime: "text/typescript",
          name: "board.ts",
          source: { start: 0, end: 8, text: "@board.ts" },
        },
      ],
      agents: [{ name: "reviewer", source: { start: 9, end: 18, text: "@reviewer" } }],
    })
  })

  test("keeps one stable ID for exact retries and rotates it for changed prompts", () => {
    let sequence = 0
    const createID = () => `input-${++sequence}`
    const first = nextQueueAttempt(undefined, { text: "first" }, createID)
    expect(nextQueueAttempt(first, { text: "first" }, createID)).toBe(first)
    expect(nextQueueAttempt(first, { text: "changed" }, createID)).toEqual({
      id: "input-2",
      key: JSON.stringify({ text: "changed" }),
    })
  })

  test("creates globally unique IDs accepted by the V2 message schema", () => {
    const first = createQueueInputID()
    const second = createQueueInputID()
    expect(first).toMatch(/^msg_[0-9a-fA-Z]{12}[0-9A-Za-z]{14}$/)
    expect(second).not.toBe(first)
  })

  test("does not let an older pending revision replace a newer authoritative list", () => {
    const current = { revision: 4, inputs: ["new"] }
    expect(acceptPendingSnapshot(current, { revision: 3, inputs: ["old"] })).toBe(current)
    expect(acceptPendingSnapshot(current, { revision: 5, inputs: [] })).toEqual({ revision: 5, inputs: [] })
  })

  test("preserves legacy steer and verifies queue admissions before clearing", async () => {
    const source = await Bun.file(new URL("../../src/component/prompt/index.tsx", import.meta.url)).text()
    expect(source).toContain("sdk.client.session")
    expect(source).toContain("sdk.client.v2.session")
    expect(source).toContain('delivery: "queue"')
    expect(source).toMatch(/session\.input\s*\.pending/)
    expect(source).toContain("setQueuedInputs({ sessionID, value: authoritative.data })")
    expect(source).toContain("createQueueInputID")
    expect(source.indexOf("setQueuedInputs({ sessionID, value: authoritative.data })")).toBeLessThan(
      source.indexOf("history.append({"),
    )
    expect(source).toContain("return false")
  })
})
