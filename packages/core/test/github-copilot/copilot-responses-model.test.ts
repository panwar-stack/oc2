import { OpenAIResponsesLanguageModel } from "@oc2-ai/core/github-copilot/responses/openai-responses-language-model"
import { describe, expect, mock, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

async function convertReadableStreamToArray<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const result: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

function createMockFetch(chunks: string[]) {
  return mock(async () => {
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk + "\n\n"))
        }
        controller.close()
      },
    })

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  })
}

function createModel(fetchFn: ReturnType<typeof mock>) {
  return new OpenAIResponsesLanguageModel("test-model", {
    provider: "copilot.responses",
    url: () => "https://api.test.com/responses",
    headers: () => ({ Authorization: "Bearer test-token" }),
    fetch: fetchFn as any,
  })
}

describe("responses model usage", () => {
  test("maps cache-write tokens from streamed API usage", async () => {
    const mockFetch = createMockFetch([
      `data: {"type":"response.created","response":{"id":"resp-cache-write","created_at":1677652288,"model":"test-model"}}`,
      `data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"input_tokens_details":{"cached_tokens":3,"cache_write_tokens":7},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":32},"service_tier":"default"}}`,
      `data: [DONE]`,
    ])
    const model = createModel(mockFetch)

    const { stream } = await model.doStream({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })

    const parts = await convertReadableStreamToArray(stream)
    expect(parts.find((p) => p.type === "finish")).toMatchObject({
      type: "finish",
      usage: {
        inputTokens: { total: 20, noCache: 10, cacheRead: 3, cacheWrite: 7 },
        outputTokens: { total: 5, reasoning: 2 },
        raw: {
          input_tokens: 20,
          output_tokens: 5,
          total_tokens: 32,
          input_tokens_details: { cached_tokens: 3, cache_write_tokens: 7 },
        },
      },
    })
  })
})
