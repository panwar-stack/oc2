import { describe, expect, test } from "bun:test"
import { reasoningSummary } from "../../../src/context/thinking"

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })
  })

  test.each(["<!---->", "<!-- -->"])("removes empty comments globally: %s", (comment) => {
    expect(reasoningSummary(`${comment}\nDetails ${comment} only.\n${comment}`)).toEqual({
      title: null,
      body: "Details  only.",
    })
  })

  test("unwraps a boundary comment while preserving its reasoning", () => {
    expect(reasoningSummary("<!--\n**Inspecting output**\n\nDetails.\n-->")).toEqual({
      title: "Inspecting output",
      body: "Details.",
    })
  })

  test("preserves non-empty inline comments", () => {
    expect(reasoningSummary("Before <!-- keep this --> after.")).toEqual({
      title: null,
      body: "Before <!-- keep this --> after.",
    })
  })

  test("does not combine separate non-empty comments into a wrapper", () => {
    expect(reasoningSummary("<!-- first -->\nDetails.\n<!-- second -->")).toEqual({
      title: null,
      body: "<!-- first -->\nDetails.\n<!-- second -->",
    })
  })
})
