import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@oc2-ai/sdk/v2"
import { consumedTokens, currentContextMessage } from "../../src/util/context-usage"

const empty = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function assistant(id: string, tokens: AssistantMessage["tokens"]): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    time: { created: 1 },
    parentID: "parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens,
  }
}

describe("current context usage", () => {
  test("sums all five disjoint categories exactly once and ignores provider total", () => {
    expect(consumedTokens({ total: 999, input: 1, output: 2, reasoning: 4, cache: { read: 8, write: 16 } })).toBe(
      31,
    )
  })

  test.each([
    ["input-only", { ...empty, input: 1 }],
    ["output-only", { ...empty, output: 1 }],
    ["reasoning-only", { ...empty, reasoning: 1 }],
    ["cache-read-only", { ...empty, cache: { read: 1, write: 0 } }],
    ["cache-write-only", { ...empty, cache: { read: 0, write: 1 } }],
  ])("selects the latest %s turn with positive consumed usage", (_name, tokens) => {
    expect(currentContextMessage([assistant("used", tokens), assistant("zero", empty)])?.id).toBe("used")
  })

  test("rejects a provider-total-only turn", () => {
    expect(currentContextMessage([assistant("total", { ...empty, total: 999 })])).toBeUndefined()
  })
})
