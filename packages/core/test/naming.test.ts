import { describe, expect, test } from "bun:test"
import { Naming } from "../src/naming"

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

describe("Naming env compatibility", () => {
  test("prefers OC2 env vars over OPENCODE fallbacks", () => {
    withEnv("OC2_CONFIG", "new", () => {
      withEnv("OPENCODE_CONFIG", "old", () => {
        expect(Naming.env("OPENCODE_CONFIG")).toBe("new")
      })
    })
  })

  test("falls back to OPENCODE env vars", () => {
    withEnv("OC2_CONFIG", undefined, () => {
      withEnv("OPENCODE_CONFIG", "old", () => {
        expect(Naming.env("OPENCODE_CONFIG")).toBe("old")
      })
    })
  })
})
