import type { CachePlan } from "@oc2-ai/llm/cache/planner"
import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"

const plan = (input: {
  provider?: string
  model?: string
  stablePrefixFingerprint?: string
  toolsFingerprint?: string | null
  schemasFingerprint?: string | null
  cacheKey?: string | null
} = {}) =>
  ({
    provider: input.provider ?? "anthropic",
    model: input.model ?? "claude-sonnet-4",
    mode: "explicit",
    cacheKey: input.cacheKey ?? "oc2-v1-stable-a",
    trafficPartition: null,
    stablePrefixFingerprint: input.stablePrefixFingerprint ?? "stable:a",
    componentFingerprints: {
      system: "system:a",
      messages: input.stablePrefixFingerprint ?? "stable:a",
      ...(input.toolsFingerprint === null ? {} : { tools: input.toolsFingerprint ?? "tools:a" }),
      ...(input.schemasFingerprint === null ? {} : { schemas: input.schemasFingerprint ?? "schemas:a" }),
    },
    prefixTokenCount: null,
    minimumPrefixTokens: 1024,
    eligible: true,
    breakpoints: [{ component: "messages", contentType: "message", index: 0 }],
    duration: "5m",
  }) satisfies CachePlan

const use = (input: Parameters<typeof plan>[0] & { requestFormat?: string; promptVersion?: number } = {}) =>
  SessionRetry.cacheUse({
    plan: plan(input),
    requestFormat: input.requestFormat ?? "anthropic-messages",
    promptVersion: input.promptVersion ?? 1,
    repositoryContextVersion: null,
  })

describe("SessionRetry prompt cache lifecycle metadata", () => {
  test("same-prefix conversation retry records no change and preserves no expected miss", () => {
    const previous = use()
    const result = SessionRetry.record({
      metadata: { version: SessionRetry.CACHE_RETRY_METADATA_VERSION, last: previous, changes: [] },
      previous,
      current: use(),
      kind: "retry",
      attempt: 2,
      intent: "conversation",
      observedAt: 123,
    })

    expect(result.change).toBeUndefined()
    expect(result.expectedMiss).toBe(false)
    expect(result.metadata.last).toEqual(previous)
    expect(result.metadata.changes).toEqual([])
  })

  test("records provider, model, request format, tools, schemas, and stable-prefix changes", () => {
    const previous = use()
    const current = use({
      provider: "google",
      model: "gemini-2.5-pro",
      requestFormat: "google-generative-ai",
      stablePrefixFingerprint: "stable:b",
      toolsFingerprint: "tools:b",
      schemasFingerprint: "schemas:b",
      cacheKey: "oc2-v1-stable-b",
    })
    const result = SessionRetry.record({
      metadata: { version: SessionRetry.CACHE_RETRY_METADATA_VERSION, last: previous, changes: [] },
      previous,
      current,
      kind: "resume",
      attempt: 1,
      intent: "conversation",
      observedAt: 456,
    })

    expect(SessionRetry.compare(previous, current)).toEqual([
      "provider",
      "model",
      "request_format",
      "tools",
      "schemas",
      "stable_prefix",
    ])
    expect(result.change).toMatchObject({
      kind: "resume",
      attempt: 1,
      expectedMiss: false,
      observedAt: 456,
      reasons: ["provider", "model", "request_format", "tools", "schemas", "stable_prefix"],
    })
    expect(result.metadata.last).toEqual(current)
    expect(result.metadata.changes).toHaveLength(1)
  })

  test("marks compaction and summary stable-prefix changes as expected misses", () => {
    const previous = use()
    const current = use({ stablePrefixFingerprint: "stable:summary" })

    expect(
      SessionRetry.record({
        metadata: { version: SessionRetry.CACHE_RETRY_METADATA_VERSION, last: previous, changes: [] },
        previous,
        current,
        kind: "resume",
        attempt: 1,
        intent: "compaction",
        observedAt: 789,
      }).expectedMiss,
    ).toBe(true)
    expect(
      SessionRetry.record({
        metadata: { version: SessionRetry.CACHE_RETRY_METADATA_VERSION, last: previous, changes: [] },
        previous,
        current,
        kind: "resume",
        attempt: 1,
        intent: "summary",
        observedAt: 790,
      }).change?.expectedMiss,
    ).toBe(true)
  })

  test("parses only well-formed cache metadata and drops prompt content", () => {
    const valid = use()
    const parsed = SessionRetry.metadata({
      promptCache: {
        version: SessionRetry.CACHE_RETRY_METADATA_VERSION,
        last: {
          ...valid,
          prompt: "secret user prompt",
          messages: [{ content: "secret assistant content" }],
        },
        auxiliary: { ...valid, version: 999 },
        changes: [
          {
            version: SessionRetry.CACHE_RETRY_METADATA_VERSION,
            kind: "retry",
            attempt: 2,
            reasons: ["stable_prefix", "not-a-reason"],
            expectedMiss: false,
            previous: valid,
            current: { ...valid, stablePrefixFingerprint: "stable:c" },
            observedAt: 321,
            prompt: "secret change prompt",
          },
          {
            version: SessionRetry.CACHE_RETRY_METADATA_VERSION,
            kind: "retry",
            attempt: "bad",
            reasons: ["provider"],
            expectedMiss: false,
            previous: valid,
            current: valid,
            observedAt: 322,
          },
        ],
      },
    })

    expect(parsed.last).toEqual(valid)
    expect(parsed.auxiliary).toBeUndefined()
    expect(parsed.changes).toHaveLength(1)
    expect(parsed.changes[0]?.reasons).toEqual(["stable_prefix"])
    expect(JSON.stringify(parsed)).not.toContain("secret")
  })
})
