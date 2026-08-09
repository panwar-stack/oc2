import { describe, expect, test } from "bun:test"
import { collapseToolOutput } from "../../src/util/collapse-tool-output"

describe("collapseToolOutput", () => {
  test("returns text at the line and character limits unchanged", () => {
    expect(collapseToolOutput("alpha\nbeta", 2, 10)).toEqual({
      output: "alpha\nbeta",
      overflow: false,
    })
  })

  test("stops at the first line beyond the limit", () => {
    expect(collapseToolOutput("one\ntwo\nthree", 2, 100)).toEqual({
      output: "one\ntwo\n…",
      overflow: true,
    })
  })

  test("counts Unicode code points for character overflow", () => {
    expect(collapseToolOutput("😀😀abc", 10, 3)).toEqual({
      output: "😀😀…",
      overflow: true,
    })
  })

  test("uses line overflow when both limits are exceeded at a newline", () => {
    expect(collapseToolOutput("ab\ncd", 1, 2)).toEqual({
      output: "ab\n…",
      overflow: true,
    })
  })

  test("counts a trailing newline as another line", () => {
    expect(collapseToolOutput("alpha\n", 1, 100)).toEqual({
      output: "alpha\n…",
      overflow: true,
    })
    expect(collapseToolOutput("alpha\n", 2, 100)).toEqual({
      output: "alpha\n",
      overflow: false,
    })
  })

  test("handles zero and one character limits", () => {
    expect(collapseToolOutput("", 1, 0)).toEqual({ output: "", overflow: false })
    expect(collapseToolOutput("a", 1, 0)).toEqual({ output: "…", overflow: true })
    expect(collapseToolOutput("a", 1, 1)).toEqual({ output: "a", overflow: false })
    expect(collapseToolOutput("ab", 1, 1)).toEqual({ output: "…", overflow: true })
  })

  test("handles a zero line limit", () => {
    expect(collapseToolOutput("a", 0, 10)).toEqual({ output: "…", overflow: true })
  })
})
