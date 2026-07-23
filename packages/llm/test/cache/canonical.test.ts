import { describe, expect, test } from "bun:test"
import {
  CACHE_CANONICAL_SERIALIZATION_VERSION,
  canonicalSerialize,
  canonicalizeCacheBreakpoints,
  canonicalizeCacheableMessages,
  canonicalizeCacheableTools,
  canonicalizeModelConfig,
  canonicalizeProviderConfig,
} from "@oc2-ai/llm/cache/canonical"

describe("cache canonical serialization", () => {
  test("sorts object keys deterministically without reordering arrays", () => {
    const value = {
      schema: {
        required: ["z", "a"],
        properties: {
          z: { type: "string" },
          a: { enum: ["beta", "alpha"] },
        },
      },
      provider: "openai",
    }

    expect(canonicalSerialize(value)).toBe(
      '{"provider":"openai","schema":{"properties":{"a":{"enum":["beta","alpha"]},"z":{"type":"string"}},"required":["z","a"]}}',
    )
  })

  test("does not mutate caller-owned objects", () => {
    const input = {
      b: { d: 1, c: [3, 2, 1] },
      a: "stable",
    }
    const before = structuredClone(input)

    canonicalSerialize(input)

    expect(input).toEqual(before)
    expect(Object.keys(input)).toEqual(["b", "a"])
    expect(Object.keys(input.b)).toEqual(["d", "c"])
  })

  test("normalizes bytes and non-finite numbers explicitly", () => {
    expect(canonicalSerialize({ data: new Uint8Array([1, 2, 3]), value: Number.NaN })).toBe(
      '{"data":{"base64":"AQID","type":"bytes"},"value":{"type":"number","value":"NaN"}}',
    )
  })

  test("canonicalizes cacheable messages while preserving semantic content order", () => {
    const messages = [
      {
        id: "msg-1",
        role: "user",
        metadata: { stable: true },
        content: [
          { type: "text", text: "first", metadata: { source: "fixture" } },
          { type: "text", text: "second" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", id: "call-1", name: "read", input: { path: "a.ts" }, metadata: { ok: true } }],
      },
    ]

    expect(canonicalSerialize(canonicalizeCacheableMessages(messages))).toBe(
      '[{"content":[{"metadata":{"source":"fixture"},"text":"first","type":"text"},{"text":"second","type":"text"}],"id":"msg-1","metadata":{"stable":true},"role":"user"},{"content":[{"id":"call-1","input":{"path":"a.ts"},"metadata":{"ok":true},"name":"read","type":"tool-call"}],"role":"assistant"}]',
    )
  })

  test("canonicalizes tools, provider config, model config, and breakpoints", () => {
    const tool = {
      name: "search",
      description: "Search files",
      metadata: { source: "test" },
      inputSchema: {
        type: "object",
        required: ["query", "path"],
        properties: {
          query: { type: "string" },
          path: { type: "string" },
        },
      },
    }

    const value = {
      serializationVersion: CACHE_CANONICAL_SERIALIZATION_VERSION,
      tools: canonicalizeCacheableTools([tool]),
      providerConfig: canonicalizeProviderConfig({ openai: { store: false, reasoning: { effort: "low" } } }),
      modelConfig: canonicalizeModelConfig({ provider: "openai", model: "gpt-5", generation: { temperature: 0 } }),
      breakpoints: canonicalizeCacheBreakpoints([
        { component: "system", contentType: "system", index: 0, duration: "5m" },
        { component: "messages", contentType: "message", index: 2 },
      ]),
    }

    expect(canonicalSerialize(value)).toBe(
      '{"breakpoints":[{"component":"system","contentType":"system","duration":"5m","index":0},{"component":"messages","contentType":"message","index":2}],"modelConfig":{"generation":{"temperature":0},"model":"gpt-5","provider":"openai"},"providerConfig":{"openai":{"reasoning":{"effort":"low"},"store":false}},"serializationVersion":1,"tools":[{"description":"Search files","inputSchema":{"properties":{"path":{"type":"string"},"query":{"type":"string"}},"required":["query","path"],"type":"object"},"metadata":{"source":"test"},"name":"search"}]}',
    )
  })

  test("canonicalizes file content references without dropping stable fields", () => {
    expect(
      canonicalSerialize(
        canonicalizeCacheableMessages([
          {
            role: "tool",
            content: [
              {
                type: "file",
                source: { type: "file", uri: "file:///repo/a.ts" },
                mime: "text/typescript",
                name: "a.ts",
              },
            ],
          },
        ]),
      ),
    ).toBe(
      '[{"content":[{"mime":"text/typescript","name":"a.ts","source":{"type":"file","uri":"file:///repo/a.ts"},"type":"file"}],"role":"tool"}]',
    )
  })
})
