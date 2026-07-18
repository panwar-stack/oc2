import { describe, expect, test } from "bun:test"
import { sessionPromptHandoffVersion, setSessionPromptHandoff, takeSessionPromptHandoff } from "./handoff"

describe("session prompt navigation handoff", () => {
  test("is scoped, one-shot, and does not use web storage", () => {
    const target = `target-${crypto.randomUUID()}`
    const other = `other-${crypto.randomUUID()}`
    const before = { local: localStorage.length, session: sessionStorage.length }

    setSessionPromptHandoff(target, "private prompt")

    expect(takeSessionPromptHandoff(other)).toBeUndefined()
    expect(takeSessionPromptHandoff(target)).toBe("private prompt")
    expect(takeSessionPromptHandoff(target)).toBeUndefined()
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(before)
  })

  test("increments the reactive marker for same-route delivery", () => {
    const target = `same-route-${crypto.randomUUID()}`
    const version = sessionPromptHandoffVersion()

    setSessionPromptHandoff(target, "same-route prompt")

    expect(sessionPromptHandoffVersion()).toBe(version + 1)
    expect(takeSessionPromptHandoff(target)).toBe("same-route prompt")
  })
})
