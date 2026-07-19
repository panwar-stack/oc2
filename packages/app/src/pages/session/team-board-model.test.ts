import { describe, expect, test } from "bun:test"
import {
  acceptBoardSnapshot,
  boardStateRank,
  moveBoardFocus,
  orderBoardItems,
  visibleBoardFocusIDs,
} from "./team-board-model"

describe("team board model", () => {
  test("uses the authoritative state priority and keeps unknown states last", () => {
    expect(
      ["completed", "working", "unknown", "needs_you", "blocked", "errored", "idle"].sort(
        (a, b) => boardStateRank(a) - boardStateRank(b),
      ),
    ).toEqual(["needs_you", "errored", "working", "blocked", "idle", "completed", "unknown"])
  })

  test("orders equal-state items by stable identity", () => {
    const items = [
      { key: "b", status: "working" },
      { key: "c", status: "idle" },
      { key: "a", status: "working" },
    ]
    expect(
      orderBoardItems(
        items,
        (item) => item.status,
        (item) => item.key,
      ).map((item) => item.key),
    ).toEqual(["a", "b", "c"])
  })

  test("accepts higher revisions and only the newest request for equal revisions", () => {
    const current = { revision: 4, generation: 3, value: "current" }
    expect(acceptBoardSnapshot(current, { revision: 3, generation: 9, value: "stale revision" })).toBe(current)
    expect(acceptBoardSnapshot(current, { revision: 4, generation: 2, value: "stale request" })).toBe(current)
    expect(acceptBoardSnapshot(current, { revision: 4, generation: 4, value: "new request" }).value).toBe("new request")
    expect(acceptBoardSnapshot(current, { revision: 5, generation: 1, value: "new revision" }).value).toBe(
      "new revision",
    )
  })

  test("excludes collapsed groups from the focus order", () => {
    expect(
      visibleBoardFocusIDs([
        { collapsed: false, items: [{ id: "working-a" }, { id: "working-b" }] },
        { collapsed: true, items: [{ id: "completed-a" }] },
      ]),
    ).toEqual(["working-a", "working-b"])
  })

  test("wraps roving focus across rows and supports boundaries", () => {
    expect(moveBoardFocus({ current: 0, count: 5, columns: 2, key: "ArrowLeft" })).toBe(4)
    expect(moveBoardFocus({ current: 4, count: 5, columns: 2, key: "ArrowRight" })).toBe(0)
    expect(moveBoardFocus({ current: 1, count: 5, columns: 2, key: "ArrowDown" })).toBe(3)
    expect(moveBoardFocus({ current: 1, count: 5, columns: 2, key: "ArrowUp" })).toBe(4)
    expect(moveBoardFocus({ current: 3, count: 5, columns: 2, key: "Home" })).toBe(0)
    expect(moveBoardFocus({ current: 1, count: 5, columns: 2, key: "End" })).toBe(4)
    expect(moveBoardFocus({ current: 0, count: 0, columns: 1, key: "Home" })).toBe(-1)
  })
})
