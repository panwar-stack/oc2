import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { assistantTurnTokenCount } from "./turn-footer"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("assistantTurnTokenCount", () => {
  test("aggregates every provider step and respects authoritative totals", () => {
    expect(
      assistantTurnTokenCount([
        { tokens: { total: 100, input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
        { tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } },
      ]),
    ).toBe(250)
  })

  test("uses actual permission requests and one shared duration interval", async () => {
    const source = await Bun.file(new URL("./message-part.tsx", import.meta.url)).text()
    expect(source).toContain("data.store.permission?.")
    expect(source).toContain("approval: approvals().has(`${part.messageID}:${part.callID}`)")
    expect(source).not.toContain("props.busy")
    expect(source).toContain("const elapsedSubscribers = new Set")
    expect(source.match(/window\.setInterval/g)?.length).toBe(1)
  })
})
