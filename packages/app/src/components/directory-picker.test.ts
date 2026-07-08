import { describe, expect, test } from "bun:test"
import { directoryPickerKind } from "./directory-picker-policy"

const local = {
  type: "sidecar",
  variant: "base",
  http: { url: "http://localhost:4096" },
} as const
const remote = {
  type: "ssh",
  host: "example.test",
  http: { url: "http://localhost:4096" },
} as const

describe("directoryPickerKind", () => {
  test("uses the server picker for retained web app projects", () => {
    expect(directoryPickerKind("web", local)).toBe("server")
    expect(directoryPickerKind("web", remote)).toBe("server")
  })
})
