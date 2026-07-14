import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { CanonicalUsage, ContentPart, LLMEvent, LLMRequest, Model, ModelID, ProviderID, Usage } from "../src/schema"
import { ProviderShared } from "../src/protocols/shared"

const model = new Model({
  id: ModelID.make("fake-model"),
  provider: ProviderID.make("fake-provider"),
  route: OpenAIChat.route,
})

const decodeLLMRequest = Schema.decodeUnknownSync(LLMRequest as unknown as Schema.Decoder<LLMRequest>)
const decodeLLMEvent = Schema.decodeUnknownSync(LLMEvent as unknown as Schema.Decoder<LLMEvent>)
const decodeUsage = Schema.decodeUnknownSync(Usage)

describe("llm schema", () => {
  test("decodes a minimal request", () => {
    const input: unknown = {
      id: "req_1",
      model,
      system: [{ type: "text", text: "You are terse." }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      generation: {},
    }

    const decoded = decodeLLMRequest(input)

    expect(decoded.id).toBe("req_1")
    expect(decoded.messages[0]?.content[0]?.type).toBe("text")
  })

  test("accepts custom route ids", () => {
    const decoded = decodeLLMRequest({
      model: Model.update(model, { route: OpenAIResponses.route }),
      system: [],
      messages: [],
      tools: [],
      generation: {},
    })

    expect(decoded.model.route.id).toBe("openai-responses")
  })

  test("rejects invalid event type", () => {
    expect(() => decodeLLMEvent({ type: "bogus" })).toThrow()
  })

  test("finish constructors accept usage input", () => {
    expect(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1 } }).usage).toBeInstanceOf(Usage)
    expect(LLMEvent.finish({ reason: "stop", usage: { outputTokens: 2 } }).usage).toBeInstanceOf(Usage)
    expect(LLMEvent.providerError({ message: "failed", usage: { totalTokens: 3 } }).usage).toBeInstanceOf(Usage)
  })

  test("content part tagged union exposes guards", () => {
    expect(ContentPart.guards.text({ type: "text", text: "hi" })).toBe(true)
    expect(ContentPart.guards.media({ type: "text", text: "hi" })).toBe(false)
  })
})

describe("LLM.Usage", () => {
  test("normalizes compatibility usage to the public canonical tuple", () => {
    const canonical = CanonicalUsage.fromUsage({
      inputTokens: 10,
      outputTokens: 7,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 3,
      reasoningTokens: 4,
      totalTokens: 17,
      providerTotalTokens: 17,
      providerMetadata: { provider: { usage: { billed: true } } },
    })

    expect(canonical).toEqual({
      input: 5,
      output: 3,
      reasoning: 4,
      cache: { read: 2, write: 3 },
      providerTotal: 17,
      providerMetadata: { provider: { usage: { billed: true } } },
    })
    expect("inputTokens" in canonical!).toBe(false)
  })

  test("lowers canonical usage through the shared compatibility path", () => {
    const lowered = ProviderShared.usage({
      input: 5,
      output: 3,
      reasoning: 4,
      cache: { read: 2, write: 3 },
      providerTotal: 17,
    })

    expect(lowered).toMatchObject({
      inputTokens: 10,
      outputTokens: 7,
      nonCachedInputTokens: 5,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 3,
      reasoningTokens: 4,
      totalTokens: 17,
      providerTotalTokens: 17,
      providerMetadata: undefined,
    })
    expect(CanonicalUsage.fromUsage(lowered)).toEqual({
      input: 5,
      output: 3,
      reasoning: 4,
      cache: { read: 2, write: 3 },
      providerTotal: 17,
      providerMetadata: undefined,
    })
  })

  test("keeps insufficient compatibility usage absent", () => {
    expect(CanonicalUsage.fromUsage({})).toBeUndefined()
    expect(CanonicalUsage.fromUsage({ totalTokens: 7 })).toBeUndefined()
    expect(CanonicalUsage.fromUsage({ inputTokens: 5, totalTokens: 7 })).toBeUndefined()
  })

  test("does not promote a compatibility total without provider provenance", () => {
    const canonical = CanonicalUsage.fromUsage({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    expect(canonical).toMatchObject({ input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(canonical?.providerTotal).toBeUndefined()

    const lowered = ProviderShared.usage({ input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(lowered.totalTokens).toBe(7)
    expect(lowered.providerTotalTokens).toBeUndefined()
    expect(CanonicalUsage.fromUsage(lowered)?.providerTotal).toBeUndefined()
  })

  test("rejects invalid token counts on every new-write constructor", () => {
    for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => Usage.from({ inputTokens: value })).toThrow()
      expect(() => Usage.from({ providerTotalTokens: value })).toThrow()
      expect(() =>
        CanonicalUsage.from({ input: value, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      ).toThrow()
      expect(() => LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: value } })).toThrow()
      expect(() => LLMEvent.finish({ reason: "stop", usage: { outputTokens: value } })).toThrow()
      expect(() => LLMEvent.providerError({ message: "failed", usage: { reasoningTokens: value } })).toThrow()
    }
  })

  test("keeps permissive compatibility decoding for legacy malformed usage", () => {
    expect(
      decodeUsage({ inputTokens: -1, outputTokens: 0.5, reasoningTokens: Number.POSITIVE_INFINITY }),
    ).toMatchObject({ inputTokens: -1, outputTokens: 0.5, reasoningTokens: Number.POSITIVE_INFINITY })
    expect(
      decodeLLMEvent({ type: "provider-error", message: "failed", usage: { cacheReadInputTokens: -2 } }),
    ).toMatchObject({ type: "provider-error", usage: { cacheReadInputTokens: -2 } })
  })

  test("subtractTokens clamps non-sensical breakdowns to zero", () => {
    // Defense against a provider reporting cached_tokens > prompt_tokens or
    // reasoning_tokens > completion_tokens — the negative would otherwise
    // round-trip through the pipeline and crash strict downstream schemas.
    expect(ProviderShared.subtractTokens(5, 3)).toBe(2)
    expect(ProviderShared.subtractTokens(5, 10)).toBe(0)
    expect(ProviderShared.subtractTokens(5, undefined)).toBe(5)
    expect(ProviderShared.subtractTokens(undefined, 3)).toBeUndefined()
    expect(ProviderShared.subtractTokens(undefined, undefined)).toBeUndefined()
  })

  test("sumTokens returns undefined only when every input is undefined", () => {
    expect(ProviderShared.sumTokens(1, 2, 3)).toBe(6)
    expect(ProviderShared.sumTokens(1, undefined, 3)).toBe(4)
    expect(ProviderShared.sumTokens(undefined, undefined, undefined)).toBeUndefined()
    expect(ProviderShared.sumTokens()).toBeUndefined()
  })

  test("visibleOutputTokens clamps reasoning > output to zero", () => {
    expect(new Usage({ outputTokens: 10, reasoningTokens: 4 }).visibleOutputTokens).toBe(6)
    expect(new Usage({ outputTokens: 10 }).visibleOutputTokens).toBe(10)
    expect(new Usage({ outputTokens: 4, reasoningTokens: 10 }).visibleOutputTokens).toBe(0)
    expect(new Usage({}).visibleOutputTokens).toBe(0)
  })
})
