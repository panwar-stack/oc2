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

describe("Naming env", () => {
  test("reads OC2 env vars", () => {
    withEnv("OC2_CONFIG", "new", () => {
      expect(Naming.env("OC2_CONFIG")).toBe("new")
    })
  })

  test("returns undefined for unset OC2 env vars", () => {
    withEnv("OC2_CONFIG", undefined, () => {
      expect(Naming.env("OC2_CONFIG")).toBeUndefined()
    })
  })
})
