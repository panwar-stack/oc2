import { describe, expect, test } from "bun:test"
import { projectSessionContext } from "./session-projection"

describe("session context projection", () => {
  test("uses one floor, compact-label, and eight-cell projection", () => {
    expect(projectSessionContext(15_800, 1_100_000)).toMatchObject({
      tokensLabel: "15.8K",
      limitLabel: "1.1M",
      percent: 1,
      cells: 0,
      gauge: "▱▱▱▱▱▱▱▱",
      level: "success",
    })
  })

  test("clamps percent and owns warning actions", () => {
    expect(projectSessionContext(70, 100)).toMatchObject({ percent: 70, level: "warning", action: "compact" })
    expect(projectSessionContext(120, 100)).toMatchObject({ percent: 100, level: "danger", action: "fork" })
    expect(projectSessionContext(20)).toEqual({ tokens: 20, tokensLabel: "20", level: "success" })
  })
})
