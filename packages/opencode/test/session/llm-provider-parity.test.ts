import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@oc2-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@oc2-ai/llm/route"
import type { HttpRecorder } from "@oc2-ai/http-recorder"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { createOpenAI } from "@ai-sdk/openai"
import type { Provider } from "@/provider/provider"
import { Effect, Layer } from "effect"
import {
  assertCassetteSafe,
  auditParityCassettes,
  canonicalRequest,
  compareParityRuns,
  listParityCassettes,
  loadProviderParityInventory,
  makeReplay,
  NativeDirectUnsupportedError,
  normalizeEvents,
  providerParityPaths,
  redactCassette,
  selectRecording,
  writeRecordedCassette,
  type ProviderParityCassette,
  type ProviderParityInventory,
} from "../lib/provider-parity"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const inventory = (status: "parity" | "unsupported" | "not-applicable" = "parity") =>
  ({
    version: 2,
    source: { path: "synthetic", sha256: "synthetic", providerCount: 1, modelCount: 1 },
    providers: [
      {
        id: "synthetic",
        source: "synthetic",
        classification: "generic-factory",
        family: "openai-compatible",
        batchID: "openai-compatible-001",
        credentialSources: { catalogEnv: ["SYNTHETIC_API_KEY"] },
        scenarios: [
          status === "parity"
            ? {
                id: "text",
                modelID: "synthetic-model",
                api: {
                  package: "@ai-sdk/openai-compatible",
                  url: "https://api.example.test/v1",
                  urlSource: "catalog",
                  urlEvidence: "synthetic fixture",
                },
                status,
                evidence: "provider-parity/openai-compatible/synthetic/text.json",
                recordingCredentials: [{ id: "api-key", allOf: ["SYNTHETIC_API_KEY"] }],
              }
            : status === "unsupported"
              ? {
                  id: "text",
                  modelID: "synthetic-model",
                  api: {
                    package: "@ai-sdk/openai-compatible",
                    url: "https://api.example.test/v1",
                    urlSource: "catalog",
                    urlEvidence: "synthetic fixture",
                  },
                  status,
                  evidence: "native adapter inventory",
                  reason: "not implemented",
                  issue: "https://example.test/issues/1",
                  recordingCredentials: [],
                }
              : {
                  id: "text",
                  modelID: null,
                  api: null,
                  status,
                  evidence: "catalog declares no text output",
                  recordingCredentials: [],
                },
        ],
      },
    ],
  }) satisfies ProviderParityInventory

const request = (body: Record<string, unknown> = { model: "synthetic-model", input: "hello" }) =>
  ({
    method: "POST",
    url: "https://api.example.test/v1/responses?request_id=req_live&api_key=secret",
    headers: {
      authorization: "Bearer live-secret-token",
      "content-type": "application/json",
      "x-request-id": "req_live",
    },
    body: JSON.stringify(body),
  }) satisfies HttpRecorder.RequestSnapshot

const cassette = (): ProviderParityCassette => ({
  version: 1,
  metadata: { recordedAt: "2026-07-11T12:34:56.000Z", account: "acct_live" },
  interactions: [
    {
      transport: "http",
      request: request(),
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": "req_live" },
        body: 'data: {"id":"resp_live","created_at":1783773296,"text":"hello"}\n\n',
      },
    },
  ],
})

const nativeModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const nativeProvider: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const runtimeCassette = (): ProviderParityCassette => ({
  version: 1,
  interactions: [
    {
      transport: "http",
      request: {
        method: "POST",
        url: "https://api.openai.com/v1/responses",
        headers: { authorization: "Bearer test-openai-key", "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5-mini",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "medium", summary: "auto" },
          store: false,
          stream: true,
        }),
      },
      response: {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          {
            type: "response.created",
            response: { id: "resp_live", created_at: 1783773296, model: "gpt-5-mini", service_tier: null },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg_live", status: "in_progress", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "msg_live",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          },
          { type: "response.output_text.delta", item_id: "msg_live", delta: "hello", logprobs: null },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 1,
                input_tokens_details: null,
                output_tokens: 1,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}`)
          .join("\n\n")
          .concat("\n\ndata: [DONE]\n\n"),
      },
    },
  ],
})

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
)

describe("provider parity inventory and cassettes", () => {
  test("the Core inventory is the sole matrix source and has exact cassette coverage", async () => {
    const core = await loadProviderParityInventory(providerParityPaths.inventory)
    const committed = await listParityCassettes(providerParityPaths.recordings)
    expect(() => auditParityCassettes(core, committed)).not.toThrow()
  })

  test("fails on missing, extra, and duplicate cassettes", () => {
    expect(() => auditParityCassettes(inventory(), [])).toThrow("Missing provider parity cassettes")
    expect(() => auditParityCassettes(inventory("unsupported"), ["provider-parity/stale/provider/text"])).toThrow(
      "Extra provider parity cassettes",
    )
    expect(() =>
      auditParityCassettes(inventory(), [
        "provider-parity/openai-compatible/synthetic/text",
        "provider-parity/openai-compatible/synthetic/text",
      ]),
    ).toThrow("Duplicate provider parity cassettes")
  })

  test("fails when two inventory cells target one cassette", () => {
    const duplicate = inventory()
    duplicate.providers[0].scenarios.push({
      id: "text",
      modelID: "synthetic-model",
      api: {
        package: "@ai-sdk/openai-compatible",
        url: "https://api.example.test/v1",
        urlSource: "catalog",
        urlEvidence: "synthetic fixture",
      },
      status: "parity",
      evidence: "provider-parity/openai-compatible/synthetic/text.json",
      recordingCredentials: [{ id: "api-key", allOf: ["SYNTHETIC_API_KEY"] }],
    })
    expect(() => auditParityCassettes(duplicate, [])).toThrow("Duplicate provider parity cell")
  })
})

describe("provider parity recording gate", () => {
  test("requires RECORD=true plus exact provider and scenario filters", () => {
    expect(selectRecording(inventory(), {})).toBeUndefined()
    expect(() => selectRecording(inventory(), { RECORD: "true" })).toThrow("PROVIDER_PARITY_PROVIDER")
    expect(() =>
      selectRecording(inventory(), {
        RECORD: "true",
        PROVIDER_PARITY_PROVIDER: "synthetic,other",
        PROVIDER_PARITY_SCENARIO: "text",
      }),
    ).toThrow("one exact PROVIDER_PARITY_PROVIDER")
  })

  test("fails selected recording when credentials are missing", () => {
    expect(() =>
      selectRecording(inventory(), {
        RECORD: "true",
        PROVIDER_PARITY_PROVIDER: "synthetic",
        PROVIDER_PARITY_SCENARIO: "text",
      }),
    ).toThrow("Missing recording credentials")
    expect(
      selectRecording(inventory(), {
        RECORD: "true",
        PROVIDER_PARITY_PROVIDER: "synthetic",
        PROVIDER_PARITY_SCENARIO: "text",
        SYNTHETIC_API_KEY: "present",
      })?.name,
    ).toBe("provider-parity/openai-compatible/synthetic/text")
  })

  test("requires every credential in one selected alternative", () => {
    const compound = inventory()
    compound.providers[0].scenarios[0].recordingCredentials = [
      { id: "azure-resource-api-key", allOf: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
    ]
    const selected = {
      RECORD: "true",
      PROVIDER_PARITY_PROVIDER: "synthetic",
      PROVIDER_PARITY_SCENARIO: "text",
    }
    expect(() => selectRecording(compound, { ...selected, AZURE_RESOURCE_NAME: "resource" })).toThrow(
      "AZURE_RESOURCE_NAME + AZURE_API_KEY",
    )
    expect(
      selectRecording(compound, { ...selected, AZURE_RESOURCE_NAME: "resource", AZURE_API_KEY: "key" })?.name,
    ).toBe("provider-parity/openai-compatible/synthetic/text")
  })

  test("redacts, scans, writes atomically, and refuses to overwrite a recording", async () => {
    await using directory = await tmpdir()
    const selection = selectRecording(inventory(), {
      RECORD: "true",
      PROVIDER_PARITY_PROVIDER: "synthetic",
      PROVIDER_PARITY_SCENARIO: "text",
      SYNTHETIC_API_KEY: "present",
    })
    if (!selection) throw new Error("Expected recording selection")
    const target = await writeRecordedCassette({ directory: directory.path, selection, cassette: cassette() })
    expect(await Bun.file(target).text()).not.toContain("acct_live")
    await expect(writeRecordedCassette({ directory: directory.path, selection, cassette: cassette() })).rejects.toThrow(
      "Refusing to overwrite",
    )
  })
})

describe("provider parity replay and comparison", () => {
  test("uses independent fail-closed replay cursors", async () => {
    const first = makeReplay(cassette())
    const second = makeReplay(cassette())
    await first.fetch(request().url, { method: "POST", headers: request().headers, body: request().body })
    await second.fetch(request().url, { method: "POST", headers: request().headers, body: request().body })
    first.assertConsumed()
    second.assertConsumed()
    await expect(first.fetch(request().url, { method: "POST", body: request().body })).rejects.toThrow(
      "cassette is exhausted",
    )
  })

  it.effect("compares production AI SDK and fallback-disabled native direct execution", () =>
    Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      const result = yield* Effect.promise(() =>
        compareParityRuns({
          cassette: runtimeCassette(),
          aiSdk: (replay) => ({
            model: createOpenAI({ apiKey: "test-openai-key", fetch: replay.fetch }).responses("gpt-5-mini"),
            messages: [{ role: "user", content: "hello" }],
            providerOptions: {
              openai: {
                include: ["reasoning.encrypted_content"],
                reasoningEffort: "medium",
                reasoningSummary: "auto",
                store: false,
              },
            },
            maxRetries: 0,
          }),
          nativeDirect: (replay) => ({
            model: nativeModel,
            provider: { ...nativeProvider, options: { apiKey: "test-openai-key", fetch: replay.fetch } },
            auth: { type: "oauth", refresh: "fixture", access: "fixture", expires: 1 },
            llmClient,
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            headers: {},
            abort: new AbortController().signal,
          }),
        }),
      )
      expect(result.aiSdk).toEqual(result.native)
      expect(result.aiSdk.events).toContainEqual({ type: "text", text: "hello" })
    }),
  )

  it.effect("returns typed context instead of falling back for unsupported native direct execution", () =>
    Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      let aiSdkCalled = false
      const error = yield* Effect.promise(() =>
        compareParityRuns({
          cassette: runtimeCassette(),
          aiSdk: (replay) => {
            aiSdkCalled = true
            return {
              model: createOpenAI({ apiKey: "test-openai-key", fetch: replay.fetch }).responses("gpt-5-mini"),
              messages: [{ role: "user", content: "hello" }],
              providerOptions: {
                openai: {
                  include: ["reasoning.encrypted_content"],
                  reasoningEffort: "medium",
                  reasoningSummary: "auto",
                  store: false,
                },
              },
              maxRetries: 0,
            }
          },
          nativeDirect: () => ({
            model: { ...nativeModel, providerID: ProviderV2.ID.make("cloudflare") },
            provider: { ...nativeProvider, id: ProviderV2.ID.make("cloudflare") },
            auth: undefined,
            llmClient,
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            headers: {},
            abort: new AbortController().signal,
          }),
        }).catch((cause: unknown) => cause),
      )
      expect(aiSdkCalled).toBeFalse()
      expect(error).toBeInstanceOf(NativeDirectUnsupportedError)
      expect((error as NativeDirectUnsupportedError).context).toEqual({
        providerID: "cloudflare",
        modelID: "gpt-5-mini",
        effectiveAPI: { package: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
        reason: "provider is not openai or anthropic",
      })
    }),
  )
})

describe("provider parity normalization and redaction", () => {
  test("canonicalizes request JSON, query order, headers, secrets, accounts, IDs, and timestamps", () => {
    const canonical = canonicalRequest(
      request({
        z: 1,
        api_key: "sk-secret-value-that-must-not-survive",
        project_id: "proj_live",
        created_at: "2026-07-11T12:34:56.000Z",
        a: { request_id: "req_live" },
      }),
    )
    const text = JSON.stringify(canonical)
    expect(text).not.toContain("sk-secret")
    expect(text).not.toContain("proj_live")
    expect(text).not.toContain("req_live")
    expect(text).not.toContain("2026-07-11")
    expect(text).not.toContain("1783773296")
    expect(text).toContain("[REDACTED]")
    expect(text).toContain("[VOLATILE]")
  })

  test("retains material auth header names while redacting their values", () => {
    const canonical = JSON.stringify(
      canonicalRequest({
        method: "POST",
        url: "https://example.test/v1",
        headers: {
          "api-key": "azure-secret",
          "cf-aig-authorization": "Bearer cloudflare-secret",
          "private-token": "gitlab-secret",
        },
        body: "{}",
      }),
    )
    expect(canonical).toContain('"api-key":"[REDACTED]"')
    expect(canonical).toContain('"cf-aig-authorization":"[REDACTED]"')
    expect(canonical).toContain('"private-token":"[REDACTED]"')
    expect(canonical).not.toContain("azure-secret")
    expect(canonical).not.toContain("cloudflare-secret")
  })

  test("preserves routing structure and rejects the final-review identifier reproduction", () => {
    const raw: ProviderParityCassette = {
      version: 1,
      interactions: [
        {
          transport: "http",
          request: {
            method: "POST",
            url: "https://example.test/v1",
            headers: {
              authorization: "Bearer test-secret",
              "chatgpt-account-id": "acc-123",
              "x-tenant-id": "tenant-123",
            },
            body: "{}",
          },
          response: {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: 'data: {"responseId":"NyTxaYuTJ_OW_uMPgIPKgAg","tenantId":"tenant-customer","profile":"arn:aws:bedrock:us-east-1:123456789012:inference-profile/customer"}\n\n',
          },
        },
      ],
    }
    expect(canonicalRequest(raw.interactions[0].request)).toEqual({
      body: {},
      headers: {
        authorization: "[REDACTED]",
        "chatgpt-account-id": "[VOLATILE]",
        "x-tenant-id": "[VOLATILE]",
      },
      method: "POST",
      url: "https://example.test/v1",
    })
    expect(() => assertCassetteSafe(raw)).toThrow("possible secrets")
    const redacted = redactCassette(raw)
    const text = JSON.stringify(redacted)
    expect(text).not.toContain("NyTxaYuTJ_OW_uMPgIPKgAg")
    expect(text).not.toContain("tenant-customer")
    expect(text).not.toContain("123456789012")
    expect(text).toContain("arn:aws:bedrock:us-east-1:[VOLATILE]:inference-profile/customer")
    expect(() => assertCassetteSafe(redacted)).not.toThrow()
  })

  test("fails closed across provider identifier key, path, and header forms", () => {
    for (const [key, value] of [
      ["responseId", "opaqueResponseValue"],
      ["response_id", "opaque-response-value"],
      ["tenantId", "customerTenantValue"],
      ["tenant_id", "customer-tenant-value"],
      ["subscriptionId", "billingSubscriptionValue"],
      ["subscription_id", "billing-subscription-value"],
      ["resourceId", "inferenceResourceValue"],
      ["resource_id", "inference-resource-value"],
    ] as const) {
      const raw: ProviderParityCassette = {
        version: 1,
        interactions: [
          {
            transport: "http",
            request: { method: "POST", url: "https://example.test/v1", headers: {}, body: "{}" },
            response: {
              status: 200,
              headers: {},
              body: `data: ${JSON.stringify({ [key]: value, resourceType: "inference_profile", responseFormat: "json" })}\n\n`,
            },
          },
        ],
      }
      expect(() => assertCassetteSafe(raw)).toThrow("possible secrets")
      const redacted = redactCassette(raw)
      expect(redacted.interactions[0].response.body).not.toContain(value)
      expect(redacted.interactions[0].response.body).toContain('"resourceType":"inference_profile"')
      expect(redacted.interactions[0].response.body).toContain('"responseFormat":"json"')
      expect(() => assertCassetteSafe(redacted)).not.toThrow()
    }

    for (const [url, identifiers] of [
      ["https://example.test/v1/responses/opaque-response-value", ["opaque-response-value"]],
      ["https://example.test/v1/tenants/customer-tenant-value", ["customer-tenant-value"]],
      ["https://example.test/v1/subscriptions/billing-subscription-value", ["billing-subscription-value"]],
      [
        "https://example.test/v1/resourceGroups/production-group/resources/inference-resource-value",
        ["production-group", "inference-resource-value"],
      ],
    ] as const) {
      const raw: ProviderParityCassette = {
        version: 1,
        interactions: [
          {
            transport: "http",
            request: { method: "POST", url, headers: {}, body: "{}" },
            response: { status: 200, headers: {}, body: "" },
          },
        ],
      }
      expect(() => assertCassetteSafe(raw)).toThrow("sensitive identifier")
      const redacted = redactCassette(raw)
      for (const identifier of identifiers) expect(redacted.interactions[0].request.url).not.toContain(identifier)
      expect(() => assertCassetteSafe(redacted)).not.toThrow()
    }

    const headerValues = {
      "chatgpt-account-id": "customer-account",
      "x-tenant-id": "customer-tenant",
      "x-subscription-id": "customer-subscription",
      "x-resource-id": "customer-resource",
    }
    const headers = canonicalRequest({
      method: "POST",
      url: "https://example.test/v1",
      headers: headerValues,
      body: "{}",
    })
    expect(headers).toEqual({
      body: {},
      headers: {
        "chatgpt-account-id": "[VOLATILE]",
        "x-resource-id": "[VOLATILE]",
        "x-subscription-id": "[VOLATILE]",
        "x-tenant-id": "[VOLATILE]",
      },
      method: "POST",
      url: "https://example.test/v1",
    })
    const rawHeaders: ProviderParityCassette = {
      version: 1,
      interactions: [
        {
          transport: "http",
          request: { method: "POST", url: "https://example.test/v1", headers: headerValues, body: "{}" },
          response: { status: 200, headers: headerValues, body: "" },
        },
      ],
    }
    expect(() => assertCassetteSafe(rawHeaders)).toThrow("possible secrets")
    const redactedHeaders = redactCassette(rawHeaders)
    for (const value of Object.values(headerValues)) expect(JSON.stringify(redactedHeaders)).not.toContain(value)
    expect(() => assertCassetteSafe(redactedHeaders)).not.toThrow()
  })

  test("redacts URL userinfo and resource identifiers in path, query, and host", () => {
    const source = cassette()
    const adversarial: ProviderParityCassette = {
      ...source,
      interactions: source.interactions.map((interaction, index) =>
        index
          ? interaction
          : {
              ...interaction,
              request: {
                ...interaction.request,
                url: "https://user:provider-password@workspace_customer.example.test/client/v4/accounts/0123456789abcdef0123456789abcdef/projects/project_live/events/123e4567-e89b-42d3-a456-426614174000?workspaceId=workspace_live&projectId=customer-project&request_id=req_live&timestamp=1783773296",
              },
            },
      ),
    }
    const redacted = redactCassette(adversarial)
    const text = JSON.stringify(redacted)
    expect(text).not.toContain("user")
    expect(text).not.toContain("provider-password")
    expect(text).not.toContain("0123456789abcdef0123456789abcdef")
    expect(text).not.toContain("workspace_customer")
    expect(text).not.toContain("project_live")
    expect(text).not.toContain("workspace_live")
    expect(text).not.toContain("customer-project")
    expect(text).not.toContain("req_live")
    expect(text).not.toContain("123e4567-e89b-42d3-a456-426614174000")
    expect(text).not.toContain("1783773296")
    expect(() => assertCassetteSafe(redacted)).not.toThrow()
  })

  test("redacts and rejects raw Azure resource and Databricks workspace hostnames", () => {
    for (const url of [
      "https://acme-prod.openai.azure.com/v1/responses",
      "https://adb-1234567890123456.7.azuredatabricks.net/serving-endpoints/model/invocations",
    ]) {
      const source = cassette()
      const adversarial: ProviderParityCassette = {
        ...source,
        interactions: source.interactions.map((interaction) => ({
          ...interaction,
          request: { ...interaction.request, url },
        })),
      }
      expect(() => assertCassetteSafe(adversarial)).toThrow("sensitive identifier")
      const redacted = redactCassette(adversarial)
      expect(redacted.interactions[0].request.url).not.toContain(new URL(url).hostname.split(".")[0])
      expect(() => assertCassetteSafe(redacted)).not.toThrow()
    }
  })

  test("normalizes IDs and chunk boundaries while retaining lifecycle, tools, errors, and usage", () => {
    const events = normalizeEvents([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolInputStart({ id: "live-call", name: "weather" }),
      LLMEvent.toolInputDelta({ id: "live-call", name: "weather", text: '{"city":' }),
      LLMEvent.toolInputDelta({ id: "live-call", name: "weather", text: '"Paris"}' }),
      LLMEvent.toolInputEnd({ id: "live-call", name: "weather" }),
      LLMEvent.toolCall({ id: "live-call", name: "weather", input: { city: "Paris" } }),
      LLMEvent.toolResult({ id: "live-call", name: "weather", result: { type: "json", value: { temperature: 22 } } }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 4, outputTokens: 2 } }),
      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 4, outputTokens: 2 } }),
    ])
    expect(events).toContainEqual({
      type: "tool-input",
      id: "tool-1",
      name: "weather",
      text: '{"city":"Paris"}',
    })
    expect(events).toContainEqual({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 4, outputTokens: 2, nonCachedInputTokens: 4 },
    })
  })

  test("redacts and scans the complete cassette before recording", () => {
    const redacted = redactCassette(cassette())
    const text = JSON.stringify(redacted)
    expect(text).not.toContain("acct_live")
    expect(text).not.toContain("req_live")
    expect(text).not.toContain("2026-07-11")
    expect(text).not.toContain("1783773296")
    expect(() => assertCassetteSafe(redacted)).not.toThrow()
    expect(() =>
      assertCassetteSafe({
        ...redacted,
        metadata: { leaked: "sk-abcdefghijklmnopqrstuvwxyz123456" },
      }),
    ).toThrow("possible secrets")
  })
})
