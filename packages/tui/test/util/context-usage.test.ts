import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@oc2-ai/sdk/v2"
import { consumedTokens, currentContextMessage, formatCacheStatus } from "../../src/util/context-usage"

const empty = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

function assistant(
  id: string,
  tokens: AssistantMessage["tokens"],
  cacheStatus?: AssistantMessage["cacheStatus"],
): AssistantMessage {
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
    cacheStatus,
  }
}

describe("current context usage", () => {
  test("sums all five disjoint categories exactly once and ignores provider total", () => {
    expect(consumedTokens({ total: 999, input: 1, output: 2, reasoning: 4, cache: { read: 8, write: 16 } })).toBe(31)
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

describe("cache status formatting", () => {
  test("shows the cumulative cache-hit percentage with one decimal", () => {
    expect(
      formatCacheStatus([
        assistant(
          "first",
          { ...empty, input: 100 },
          {
            classification: "expected_cache_miss",
            read: 0,
            write: 0,
            metricsAvailable: true,
            eligible: true,
            verified: true,
          },
        ),
        assistant(
          "last",
          { ...empty, input: 100, cache: { read: 114_200, write: 0 } },
          {
            classification: "cache_hit",
            read: 114_200,
            write: 0,
            metricsAvailable: true,
            eligible: true,
            verified: true,
          },
        ),
      ]),
    ).toBe("cache hit · 99.8% cached")
  })

  test("shows a partial cache hit", () => {
    expect(formatCacheStatus([assistant("partial", { ...empty, input: 20, cache: { read: 70, write: 10 } })])).toBe(
      "cache 70.0% cached",
    )
  })

  test("shows zero percent when prompt tokens are not cached", () => {
    expect(formatCacheStatus([assistant("miss", { ...empty, input: 100 })])).toBe("cache 0.0% cached")
  })

  test("does not round a non-perfect cache-hit percentage to 100.0", () => {
    expect(formatCacheStatus([assistant("near-perfect", { ...empty, input: 1, cache: { read: 1999, write: 0 } })])).toBe(
      "cache 99.9% cached",
    )
  })

  test("aggregates token totals instead of per-message percentages", () => {
    expect(
      formatCacheStatus([
        assistant("large", { ...empty, cache: { read: 900, write: 0 } }),
        assistant("small", { ...empty, input: 100 }),
      ]),
    ).toBe("cache 90.0% cached")
  })

  test("shows cumulative net savings and cache-write cost", () => {
    expect(
      formatCacheStatus([
        assistant(
          "write",
          { ...empty, cache: { read: 0, write: 100 } },
          {
            classification: "cache_write",
            read: 0,
            write: 100,
            metricsAvailable: true,
            eligible: true,
            verified: true,
            savings: -0.2,
          },
        ),
        assistant(
          "hit",
          { ...empty, cache: { read: 100, write: 0 } },
          {
            classification: "cache_hit",
            read: 100,
            write: 0,
            metricsAvailable: true,
            eligible: true,
            verified: true,
            savings: 0.9,
          },
        ),
      ]),
    ).toBe("cache hit · 50.0% cached · saved $0.70")
  })

  test("shows net cache cost without counting potential miss savings", () => {
    expect(
      formatCacheStatus([
        assistant(
          "miss",
          { ...empty, input: 100 },
          {
            classification: "unexpected_cache_miss",
            read: 0,
            write: 0,
            metricsAvailable: true,
            eligible: true,
            verified: true,
            savings: 2,
          },
        ),
        assistant(
          "write",
          { ...empty, cache: { read: 0, write: 100 } },
          {
            classification: "cache_write",
            read: 0,
            write: 100,
            metricsAvailable: true,
            eligible: true,
            verified: true,
            savings: -0.2,
          },
        ),
      ]),
    ).toBe("cache write · 0.0% cached · extra $0.20")
  })

  test("omits incomplete savings instead of showing a partial total", () => {
    expect(
      formatCacheStatus([
        assistant(
          "priced",
          { ...empty, cache: { read: 100, write: 0 } },
          {
            classification: "cache_hit",
            read: 100,
            write: 0,
            metricsAvailable: true,
            eligible: true,
            verified: true,
            savings: 1,
          },
        ),
        assistant("unpriced", { ...empty, cache: { read: 100, write: 0 } }),
      ]),
    ).toBe("cache 100.0% cached")
  })
})
