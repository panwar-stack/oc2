import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@oc2-ai/llm"
import type { HttpRecorder } from "@oc2-ai/http-recorder"
import {
  assertCassetteSafe,
  auditParityCassettes,
  canonicalRequest,
  compareParityRuns,
  listParityCassettes,
  loadProviderParityInventory,
  makeReplay,
  normalizeEvents,
  providerParityPaths,
  redactCassette,
  selectRecording,
  writeRecordedCassette,
  type ProviderParityCassette,
  type ProviderParityInventory,
} from "../lib/provider-parity"
import { tmpdir } from "../fixture/fixture"

const inventory = (status: "parity" | "unsupported" | "not-applicable" = "parity") =>
  ({
    version: 1,
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
                api: { package: "@ai-sdk/openai-compatible", url: "https://api.example.test/v1" },
                status,
                evidence: "provider-parity/openai-compatible/synthetic/text.json",
                recordingCredentials: [{ id: "api-key", allOf: ["SYNTHETIC_API_KEY"] }],
              }
            : status === "unsupported"
              ? {
                  id: "text",
                  modelID: "synthetic-model",
                  api: { package: "@ai-sdk/openai-compatible", url: "https://api.example.test/v1" },
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
      api: { package: "@ai-sdk/openai-compatible", url: "https://api.example.test/v1" },
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

  test("compares canonical requests and normalized event transcripts across direct runtimes", async () => {
    const events = (textID: string) => [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: textID }),
      LLMEvent.textDelta({ id: textID, text: "hel" }),
      LLMEvent.textDelta({ id: textID, text: "lo" }),
      LLMEvent.textEnd({ id: textID }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }),
      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }),
    ]
    const run = (textID: string) => async (replay: ReturnType<typeof makeReplay>) => {
      await replay.fetch(request().url, { method: "POST", headers: request().headers, body: request().body })
      return { requests: replay.requests, events: events(textID) }
    }
    const result = await compareParityRuns({
      cassette: cassette(),
      aiSdk: run("ai-random"),
      nativeDirect: run("native-random"),
    })
    expect(result.aiSdk).toEqual(result.native)
    expect(result.aiSdk.events).toContainEqual({ type: "text", text: "hello" })
  })

  test("rejects transcript drift and successful runs without exactly one finish", async () => {
    const run = (events: ReadonlyArray<LLMEvent>) => async (replay: ReturnType<typeof makeReplay>) => {
      await replay.fetch(request().url, { method: "POST", headers: request().headers, body: request().body })
      return { requests: replay.requests, events }
    }
    await expect(
      compareParityRuns({
        cassette: cassette(),
        aiSdk: run([LLMEvent.finish({ reason: "stop" })]),
        nativeDirect: run([LLMEvent.textDelta({ id: "native", text: "drift" }), LLMEvent.finish({ reason: "stop" })]),
      }),
    ).rejects.toThrow("transcripts differ")
    await expect(compareParityRuns({ cassette: cassette(), aiSdk: run([]), nativeDirect: run([]) })).rejects.toThrow(
      "exactly one terminal finish",
    )
  })
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
      usage: { inputTokens: 4, outputTokens: 2 },
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
