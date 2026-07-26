import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CacheHint, LLM, Message } from "../src"
import { Auth, LLMClient } from "../src/route"
import { AmazonBedrock } from "../src/providers"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import * as Gemini from "../src/protocols/gemini"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { applyCachePolicy } from "../src/cache-policy"
import { checkLocalCacheRegression, type LocalCacheRegressionFixture } from "../src/cache/regression-checker"
import { it } from "./lib/effect"

const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-sonnet-4-5" })

const bedrockModel = AmazonBedrock.configure({
  credentials: { region: "us-east-1", accessKeyId: "fixture", secretAccessKey: "fixture" },
}).model("anthropic.claude-3-5-sonnet-20241022-v2:0")

const openaiModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const geminiModel = Gemini.route
  .with({
    endpoint: { baseURL: "https://generativelanguage.test/v1beta/" },
    auth: Auth.header("x-goog-api-key", "test"),
  })
  .model({ id: "gemini-2.5-flash" })

describe("applyCachePolicy", () => {
  it.effect("undefined cache resolves to 'auto' without caching unmarked system content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "You are concise.",
          prompt: "hi",
        }),
      )

      // No explicit cache metadata means both the system string and user turn stay dynamic.
      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "You are concise.", cache_control: undefined }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: undefined }] }],
      })
    }),
  )

  it.effect("'auto' marks stable tools and explicitly stable system but not user messages on Anthropic", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [{ type: "text", text: "Sys A", metadata: { cache: { stable: true, version: 1 } } }],
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [
            Message.user("first user"),
            Message.assistant("assistant reply"),
            Message.user("latest user message"),
          ],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys A", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "first user" }] },
          { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
          {
            role: "user",
            content: [{ type: "text", text: "latest user message", cache_control: undefined }],
          },
        ],
      })
    }),
  )

  it.effect("'auto' is a no-op on OpenAI (implicit caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openaiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { messages: Array<{ content: unknown }> }
      // OpenAI doesn't accept cache_control on messages — policy must skip.
      const flat = JSON.stringify(body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' is a no-op on Gemini (out-of-band caching protocol)", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: geminiModel,
          system: "Sys",
          prompt: "hi",
          cache: "auto",
        }),
      )

      const flat = JSON.stringify(prepared.body)
      expect(flat).not.toContain("cache_control")
      expect(flat).not.toContain("cachePoint")
    }),
  )

  it.effect("'auto' on Bedrock does not cache unmarked system content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: bedrockModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          messages: [Message.user("first user"), Message.assistant("reply"), Message.user("latest user")],
          cache: "auto",
        }),
      )

      expect(prepared.body).toMatchObject({
        toolConfig: {
          tools: [{ toolSpec: { name: "t1" } }, { cachePoint: { type: "default" } }],
        },
        system: [{ text: "Sys" }],
        messages: [
          { role: "user", content: [{ text: "first user" }] },
          { role: "assistant", content: [{ text: "reply" }] },
          { role: "user", content: [{ text: "latest user" }] },
        ],
      })
    }),
  )

  it.effect("'none' disables auto placement even when manual hints exist", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          cache: "none",
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: undefined }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("granular object form: tools-only marks just tools", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: "Sys",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          prompt: "hi",
          cache: { tools: true },
        }),
      )

      expect(prepared.body).toMatchObject({
        tools: [{ name: "t1", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "Sys", cache_control: undefined }],
      })
    }),
  )

  it.effect("auto policy preserves manual CacheHints on other parts", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [
            { type: "text", text: "first system", cache: new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }) },
            { type: "text", text: "last system" },
          ],
          prompt: "hi",
          cache: "auto",
        }),
      )

      const body = prepared.body as { system: Array<{ text: string; cache_control?: unknown }> }
      expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(body.system[1]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("ttlSeconds in the policy flows through to wire markers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          system: [{ type: "text", text: "Sys", metadata: { cache: { stable: true, version: 1 } } }],
          prompt: "hi",
          cache: { system: true, ttlSeconds: 3600 },
        }),
      )

      expect(prepared.body).toMatchObject({
        system: [{ type: "text", text: "Sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      })
    }),
  )

  it.effect("messages: { tail: 2 } only marks explicitly stable message boundaries", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [
            Message.user("u1"),
            new Message({
              role: "system",
              metadata: { cache: { stable: true, version: 1 } },
              content: [{ type: "text", text: "stable system message" }],
            }),
            Message.user("u2"),
            Message.assistant("a2"),
          ],
          cache: { messages: { tail: 2 } },
        }),
      )

      const body = prepared.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[2]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[3]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  it.effect("'latest-assistant' does not mark dynamic assistant messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: anthropicModel,
          messages: [Message.user("u1"), Message.assistant("a1"), Message.user("u2")],
          cache: { messages: "latest-assistant" },
        }),
      )

      const body = prepared.body as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> }
      expect(body.messages[0]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[1]?.content[0]?.cache_control).toBeUndefined()
      expect(body.messages[2]?.content[0]?.cache_control).toBeUndefined()
    }),
  )

  test("attaches cache plan metadata when policy has no wire mutations", () => {
    const request = LLM.request({
      model: anthropicModel,
      prompt: "hi",
      cache: "none",
    })
    const planned = applyCachePolicy(request)

    expect(planned).not.toBe(request)
    expect(planned.messages).toEqual(request.messages)
    expect(planned.metadata?.cachePlan).toMatchObject({ mode: "disabled", eligible: false })
  })

  test("plans default Anthropic request caching without an explicit 5m ttl field", () => {
    const planned = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
        prompt: "hi",
        cache: "auto",
      }),
    )

    expect(planned.metadata?.cachePlan).toMatchObject({
      mode: "automatic_and_explicit",
      duration: "5m",
      requestCacheControl: { type: "ephemeral" },
    })
    expect((planned.metadata?.cachePlan as { requestCacheControl?: object }).requestCacheControl).not.toHaveProperty("ttl")
  })

  test("preserves four explicit Anthropic slots by skipping automatic request caching", () => {
    const planned = applyCachePolicy(
      LLM.request({
        model: anthropicModel,
        system: Array.from({ length: 4 }, (_, index) => ({
          type: "text" as const,
          text: `stable-${index}`,
          cache: new CacheHint({ type: "ephemeral" }),
          metadata: { cache: { stable: true, version: 1 } },
        })),
        prompt: "hi",
        cache: "auto",
      }),
    )

    expect(planned.metadata?.cachePlan).toMatchObject({ mode: "explicit", requestCacheControl: undefined })
  })

  test("does not attach Anthropic request cache control to non-Anthropic plans", () => {
    const planned = applyCachePolicy(
      LLM.request({
        model: openaiModel,
        system: [{ type: "text", text: "stable", metadata: { cache: { stable: true, version: 1 } } }],
        prompt: "hi",
        cache: "auto",
      }),
    )

    expect(planned.metadata?.cachePlan).toMatchObject({ mode: "automatic" })
    expect((planned.metadata?.cachePlan as { requestCacheControl?: object }).requestCacheControl).toBeUndefined()
  })
})

describe("local cache regression checker", () => {
  test("returns a machine-readable pass report for stable local cache fixtures", () => {
    const fixtures: ReadonlyArray<LocalCacheRegressionFixture> = [
      {
        name: "stable-openai-cache-key",
        build: () =>
          LLM.request({
            model: openaiModel,
            system: [
              { type: "text", text: "stable openai prefix secret", metadata: { cache: { stable: true, version: 1 } } },
            ],
            prompt: "dynamic openai tail secret",
            cache: "auto",
          }),
        expect: {
          stablePrefix: "same",
          cacheKey: "same",
          components: { system: "same", modelConfig: "same" },
          stableBoundary: { system: [0] },
          dynamicBoundary: { messages: [0] },
        },
      },
      {
        name: "stable-tool-schema-ordering",
        build: (run) =>
          LLM.request({
            model: anthropicModel,
            system: [
              { type: "text", text: "stable tool prefix secret", metadata: { cache: { stable: true, version: 1 } } },
            ],
            tools: [
              {
                name: "read",
                description: "Read a file",
                inputSchema:
                  run === "first"
                    ? {
                        type: "object",
                        properties: { path: { type: "string" }, mode: { type: "string" } },
                        required: ["path"],
                      }
                    : {
                        required: ["path"],
                        properties: { mode: { type: "string" }, path: { type: "string" } },
                        type: "object",
                      },
              },
            ],
            prompt: "dynamic tool tail secret",
            cache: "auto",
          }),
        expect: {
          stablePrefix: "same",
          cacheKey: "absent",
          components: { tools: "same" },
          stableBoundary: { system: [0], tools: [0] },
          dynamicBoundary: { messages: [0] },
        },
      },
      {
        name: "stable-provider-model-config-fingerprint",
        build: (run) =>
          LLM.request({
            model: openaiModel,
            system: [
              { type: "text", text: "stable config prefix secret", metadata: { cache: { stable: true, version: 1 } } },
            ],
            prompt: "dynamic config tail secret",
            generation: run === "first" ? { temperature: 0, maxTokens: 128 } : { maxTokens: 128, temperature: 0 },
            providerOptions:
              run === "first"
                ? { openai: { store: false, metadata: { b: 2, a: 1 } } }
                : { openai: { metadata: { a: 1, b: 2 }, store: false } },
            cache: "auto",
          }),
        expect: {
          stablePrefix: "same",
          cacheKey: "same",
          components: { providerConfig: "same", modelConfig: "same" },
        },
      },
      {
        name: "dynamic-user-tail-excluded-from-stable-prefix",
        build: (run) =>
          LLM.request({
            model: openaiModel,
            system: [
              { type: "text", text: "stable tail prefix secret", metadata: { cache: { stable: true, version: 1 } } },
            ],
            prompt: run === "first" ? "dynamic tail first secret" : "dynamic tail second secret",
            cache: "auto",
          }),
        expect: {
          stablePrefix: "same",
          cacheKey: "same",
          components: { messages: "same" },
          stableBoundary: { system: [0], messages: [] },
          dynamicBoundary: { messages: [0] },
        },
      },
    ]

    const report = checkLocalCacheRegression(fixtures)

    expect(report).toMatchObject({
      version: 1,
      status: "pass",
      summary: { pass: 4, fail: 0, skip: 0, inconclusive: 0 },
    })
    expect(report.checks).toHaveLength(4)
    for (const check of report.checks) {
      expect(check.status).toBe("pass")
      expect(check.reasonCodes).toEqual([])
      expect(check.first?.stablePrefixFingerprint).toBe(check.second?.stablePrefixFingerprint)
    }

    const openai = report.checks.find((check) => check.name === "stable-openai-cache-key")
    expect(openai?.first?.cacheKey).toMatch(/^oc2-v1-[0-9a-f]{64}$/)
    expect(openai?.first?.cacheKey).toBe(openai?.second?.cacheKey)

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("dynamic tail first")
    expect(serialized).not.toContain("dynamic tail second")
    expect(serialized).not.toContain("stable openai prefix")
  })

  test("reports fail, skip, and inconclusive without raw prompt text", () => {
    const report = checkLocalCacheRegression([
      {
        name: "changed-stable-prefix",
        build: (run) =>
          LLM.request({
            model: openaiModel,
            system: [
              {
                type: "text",
                text: run === "first" ? "stable first failure secret" : "stable second failure secret",
                metadata: { cache: { stable: true, version: 1 } },
              },
            ],
            prompt: "dynamic failure tail secret",
            cache: "auto",
          }),
      },
      {
        name: "ineligible-cache-plan",
        build: () => LLM.request({ model: openaiModel, prompt: "skip prompt secret", cache: "auto" }),
      },
      {
        name: "fixture-error",
        build: () => {
          throw new Error("inconclusive prompt secret")
        },
      },
    ])

    expect(report.status).toBe("fail")
    expect(report.summary).toEqual({ pass: 0, fail: 1, skip: 1, inconclusive: 1 })
    expect(report.checks.find((check) => check.name === "changed-stable-prefix")).toMatchObject({
      status: "fail",
      reasonCodes: ["stable_prefix_changed"],
    })
    expect(report.checks.find((check) => check.name === "ineligible-cache-plan")).toMatchObject({
      status: "skip",
      reasonCodes: ["cache_plan_ineligible"],
    })
    expect(report.checks.find((check) => check.name === "fixture-error")).toMatchObject({
      status: "inconclusive",
      reasonCodes: ["fixture_build_or_plan_error", "Error"],
    })
    expect(JSON.stringify(report)).not.toContain("secret")
  })
})
