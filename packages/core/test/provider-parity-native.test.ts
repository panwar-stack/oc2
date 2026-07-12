import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionRunnerModel } from "@oc2-ai/core/session/runner/model"
import { DateTime, Effect } from "effect"
import inventory from "./fixtures/provider-parity-inventory.json"
import { it } from "./lib/effect"

const batchID = "bespoke-sdk-gateway-01"
const issue = "specs/minimal-baseline.md#pr-11-record-provider-parity-in-capped-batches"
const expected = {
  aihubmix: {
    package: "@aihubmix/ai-sdk-provider",
    credentials: [{ id: "env:AIHUBMIX_API_KEY", allOf: ["AIHUBMIX_API_KEY"] }],
    scenarios: {
      text: "claude-opus-4-6",
      tools: "claude-opus-4-6",
      "structured-output": "claude-opus-4-7-think",
      "input-audio": "gemini-2.5-flash",
      "input-image": "claude-opus-4-6",
      "input-video": "gemini-2.5-flash",
      "input-pdf": "claude-opus-4-6",
      abort: "claude-opus-4-6",
      "provider-error": "claude-opus-4-6",
    },
    notApplicable: [],
  },
  "cloudflare-ai-gateway": {
    package: "ai-gateway-provider",
    credentials: [
      {
        id: "env:cloudflare-ai-gateway",
        allOf: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
      },
    ],
    scenarios: {
      text: "anthropic/claude-3-5-haiku",
      tools: "anthropic/claude-3-5-haiku",
      "structured-output": "openai/gpt-4o",
      "input-image": "anthropic/claude-3-5-haiku",
      "input-pdf": "anthropic/claude-3-5-haiku",
      abort: "anthropic/claude-3-5-haiku",
      "provider-error": "anthropic/claude-3-5-haiku",
    },
    notApplicable: ["input-audio", "input-video"],
  },
  gitlab: {
    package: "gitlab-ai-provider",
    credentials: [{ id: "env:GITLAB_TOKEN", allOf: ["GITLAB_TOKEN"] }],
    scenarios: {
      text: "duo-chat-gpt-5-1",
      tools: "duo-chat-gpt-5-1",
      "structured-output": "duo-chat-gpt-5-1",
      "input-image": "duo-chat-gpt-5-1",
      "input-pdf": "duo-chat-gpt-5-2-codex",
      abort: "duo-chat-gpt-5-1",
      "provider-error": "duo-chat-gpt-5-1",
    },
    notApplicable: ["input-audio", "input-video"],
  },
}

describe("bespoke provider parity native batch", () => {
  test("locks the exact manifest, credentials, effective APIs, and scenarios", () => {
    expect(inventory.batches.find((batch) => batch.id === batchID)).toEqual({
      id: batchID,
      family: "bespoke-sdk-gateway",
      providerIDs: ["aihubmix", "cloudflare-ai-gateway", "gitlab"],
      providerCount: 3,
      applicableCellCount: 23,
    })

    const providers = inventory.providers.filter((provider) => provider.batchID === batchID)
    expect(providers.map((provider) => provider.id)).toEqual(Object.keys(expected))
    for (const [providerID, selected] of Object.entries(expected)) {
      const provider = providers.find((candidate) => candidate.id === providerID)
      if (!provider) throw new Error(`Missing provider ${providerID}`)
      const applicable = provider.scenarios.filter((scenario) => scenario.status !== "not-applicable")
      expect(Object.fromEntries(applicable.map((scenario) => [scenario.id, scenario.modelID]))).toEqual(
        selected.scenarios,
      )
      expect(
        provider.scenarios.filter((scenario) => scenario.status === "not-applicable").map((scenario) => scenario.id),
      ).toEqual(selected.notApplicable)
      for (const scenario of applicable) {
        expect(scenario.api).toMatchObject({
          package: selected.package,
          url: null,
          urlSource: "provider-runtime",
        })
        expect(scenario.recordingCredentials).toEqual(selected.credentials)
        expect(scenario.status).toBe("unsupported")
        expect("reason" in scenario ? scenario.reason : undefined).toBe(
          `Native direct execution does not support provider package ${selected.package}.`,
        )
        expect("issue" in scenario ? scenario.issue : undefined).toBe(issue)
      }
    }
  })

  test("maps text preflight to unavailable streamed text, usage, and one terminal finish", () => {
    const providers = inventory.providers.filter((provider) => provider.batchID === batchID)
    expect(
      providers.map((provider) => {
        const text = provider.scenarios.find((scenario) => scenario.id === "text")
        return {
          providerID: provider.id,
          scenarioID: text?.id,
          status: text?.status,
          unavailable: ["streamed-text", "usage", "single-terminal-finish"],
        }
      }),
    ).toEqual(
      Object.keys(expected).map((providerID) => ({
        providerID,
        scenarioID: "text",
        status: "unsupported",
        unavailable: ["streamed-text", "usage", "single-terminal-finish"],
      })),
    )
  })

  it.effect("returns typed UnsupportedApiError for every applicable cell", () =>
    Effect.gen(function* () {
      const providers = inventory.providers.filter((provider) => provider.batchID === batchID)
      let checked = 0
      for (const provider of providers) {
        for (const scenario of provider.scenarios) {
          if (scenario.status === "not-applicable") continue
          if (!scenario.modelID || !scenario.api) throw new Error(`Incomplete cell ${provider.id}/${scenario.id}`)
          const failure = yield* SessionRunnerModel.fromCatalogModel(
            new ModelV2.Info({
              id: ModelV2.ID.make(scenario.modelID),
              providerID: ProviderV2.ID.make(provider.id),
              name: scenario.modelID,
              api: {
                id: ModelV2.ID.make(scenario.modelID),
                type: "aisdk",
                package: scenario.api.package,
                ...(scenario.api.url === null ? {} : { url: scenario.api.url }),
              },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              request: { headers: {}, body: {}, generation: {}, options: {} },
              variants: [],
              time: { released: DateTime.makeUnsafe(0) },
              cost: [],
              status: "active",
              enabled: true,
              limit: { context: 1, output: 1 },
            }),
          ).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(SessionRunnerModel.UnsupportedApiError)
          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.UnsupportedApiError",
            providerID: provider.id,
            modelID: scenario.modelID,
            api: `aisdk:${scenario.api.package}`,
          })
          checked++
        }
      }
      expect(checked).toBe(23)
    }),
  )
})
