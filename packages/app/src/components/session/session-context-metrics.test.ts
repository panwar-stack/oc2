import { describe, expect, test } from "bun:test"
import type { Message } from "@oc2-ai/sdk/v2/client"
import { getSessionContextMetrics, getSessionTokenTotal } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.total).toBe(500)
    expect(metrics.context?.usage).toBe(50)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("floors the shared context percentage", () => {
    const messages = [assistant("a1", { input: 15_800, output: 0, reasoning: 0, read: 0, write: 0 }, 0)]
    const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 1_100_000 } } } }]

    expect(getSessionContextMetrics(messages, providers).context?.usage).toBe(1)
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.context).toBeUndefined()
  })

  test("keeps current context invariant when 144 messages are paginated to the latest 80", () => {
    const messages = Array.from({ length: 72 }, (_, index) => [
      user(`u${index}`),
      assistant(
        `a${index}`,
        index === 71
          ? { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }
          : { input: 10, output: 5, reasoning: 0, read: 0, write: 0 },
        index,
      ),
    ]).flat()

    const full = getSessionContextMetrics(messages, [])
    const initialPage = getSessionContextMetrics(messages.slice(-80), [])

    expect(messages).toHaveLength(144)
    expect(initialPage.context?.message.id).toBe("a71")
    expect(initialPage.context?.total).toBe(500)
    expect(initialPage.context?.total).toBe(full.context?.total)
  })

  test("selects the latest assistant with any positive consumed category", () => {
    const messages = [
      assistant("visible", { input: 20, output: 10, reasoning: 0, read: 0, write: 0 }, 1),
      assistant("reasoning", { input: 0, output: 0, reasoning: 9, read: 0, write: 0 }, 2),
      assistant("cache", { input: 0, output: 0, reasoning: 0, read: 0, write: 7 }, 3),
      assistant("zero", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 4),
    ]

    expect(getSessionContextMetrics(messages, []).context?.message.id).toBe("cache")
  })

  test("sums authoritative session aggregate tokens independently of message pages", () => {
    expect(
      getSessionTokenTotal({ input: 1_000, output: 200, reasoning: 50, cache: { read: 300, write: 25 } }),
    ).toBe(1_575)
    expect(getSessionTokenTotal(undefined)).toBe(0)
  })
})
