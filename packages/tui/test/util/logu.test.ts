import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { isLoguChildSession, loguChildLabel, loguPromptLabel } from "../../src/util/logu"

function session(input: Pick<Session, "id" | "title"> & Partial<Session>): Session {
  return input as Session
}

describe("util.logu", () => {
  test("labels direct logu child sessions with model and variant", () => {
    const child = session({
      id: "child",
      title: "Logu branch #2",
      metadata: { logu: { stage: "branch", index: 1, model: "openai/gpt-5.5", variant: "medium" } },
    })

    expect(isLoguChildSession(child)).toBe(true)
    expect(loguChildLabel(child)).toBe("Logu branch #2 - openai/gpt-5.5 (medium)")
  })

  test("labels branch-spawned subagents with nearest logu branch", () => {
    const sessions = [
      session({ id: "parent", title: "Parent" }),
      session({
        id: "branch",
        parentID: "parent",
        title: "Logu branch #1",
        metadata: { logu: { stage: "branch", index: 0, model: "anthropic/claude" } },
      }),
      session({ id: "subagent", parentID: "branch", title: "Explore subagent" }),
    ]

    expect(loguPromptLabel(sessions, "subagent")).toBe("Explore subagent - Logu branch #1 - anthropic/claude")
  })

  test("ignores non-logu sessions", () => {
    expect(loguPromptLabel([session({ id: "plain", title: "Plain child" })], "plain")).toBeUndefined()
  })
})
