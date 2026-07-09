import { describe, expect, test } from "bun:test"
import { directoryPickerKind } from "./directory-picker-policy"

const local = {
  type: "http",
  http: { url: "http://localhost:4096" },
} as const
const remote = {
  type: "http",
  http: { url: "https://example.test" },
} as const

describe("directoryPickerKind", () => {
  test("uses the server picker for retained web app projects", () => {
    expect(directoryPickerKind("web", local)).toBe("server")
    expect(directoryPickerKind("web", remote)).toBe("server")
  })
})
