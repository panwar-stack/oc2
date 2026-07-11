import { describe, expect, test } from "bun:test"
import catalogFixture from "../../opencode/test/tool/fixtures/models-api.json"
import inventory from "./fixtures/provider-parity-inventory.json"

type FixtureModel = {
  id: string
  status?: "alpha" | "beta" | "deprecated"
  tool_call: boolean
  structured_output?: boolean
  modalities?: { input: string[] }
}

const catalog = catalogFixture as unknown as Record<string, { models: Record<string, FixtureModel> }>
const sourcePath = "packages/opencode/test/tool/fixtures/models-api.json"

const familyCounts = {
  "openai-compatible": 89,
  "openai-direct": 3,
  anthropic: 6,
  "google-vertex": 3,
  "aws-azure": 3,
  "dedicated-ai-sdk": 10,
  "bespoke-sdk-gateway": 6,
}
const scenarioCounts = {
  text: 120,
  tools: 118,
  "structured-output": 72,
  "input-audio": 46,
  "input-image": 94,
  "input-video": 62,
  "input-pdf": 43,
}
const scenarioIDs = Object.keys(scenarioCounts)
const compoundRecordingCredentials = {
  databricks: [{ id: "env:databricks", allOf: ["DATABRICKS_HOST", "DATABRICKS_TOKEN"] }],
  "cloudflare-ai-gateway": [
    {
      id: "env:cloudflare-ai-gateway",
      allOf: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
    },
  ],
  "amazon-bedrock": [
    { id: "env:aws-bedrock-bearer-token", allOf: ["AWS_BEARER_TOKEN_BEDROCK"] },
    { id: "env:aws-static-credentials", allOf: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  ],
  "azure-cognitive-services": [
    {
      id: "env:azure-cognitive-services",
      allOf: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
    },
  ],
  "google-vertex-anthropic": [{ id: "env:google-application-credentials", allOf: ["GOOGLE_APPLICATION_CREDENTIALS"] }],
  "google-vertex": [{ id: "env:google-application-credentials", allOf: ["GOOGLE_APPLICATION_CREDENTIALS"] }],
  "cloudflare-workers-ai": [
    { id: "env:cloudflare-workers-ai", allOf: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"] },
  ],
  azure: [{ id: "env:azure", allOf: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] }],
  "privatemode-ai": [{ id: "env:privatemode-ai", allOf: ["PRIVATEMODE_API_KEY"] }],
  google: [
    { id: "env:google-generative-ai", allOf: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
    { id: "env:gemini", allOf: ["GEMINI_API_KEY"] },
  ],
}

describe("provider parity catalog", () => {
  test("pins and exhaustively canonicalizes the models.dev fixture", () => {
    expect(inventory.version).toBe(2)
    expect(inventory.source).toEqual({
      path: "packages/opencode/test/tool/fixtures/models-api.json",
      sha256: "d2ea47cabebb5a683cd5d23677dd8f0d597186986da272cc754fda506f7be99b",
      providerCount: 120,
      modelCount: 4490,
    })
    expect(inventory.providers).toHaveLength(125)
    expect(inventory.providers.map((row) => row.id)).toEqual(
      inventory.providers.map((row) => row.id).toSorted((a, b) => a.localeCompare(b)),
    )
    expect(new Set(inventory.providers.map((row) => row.id)).size).toBe(125)
    expect(inventory.providers.some((row) => row.id === "opencode")).toBe(false)
    expect(inventory.providers.find((row) => row.id === "oc2")?.catalogID).toBe("opencode")
    expect(inventory.providers.filter((row) => row.source === "catalog")).toHaveLength(120)
    expect(inventory.providers.filter((row) => row.source === "synthetic").map((row) => row.id)).toEqual([
      "dynamic-provider",
      "gateway",
      "openai-compatible",
      "snowflake-cortex",
    ])
    expect(inventory.providers.filter((row) => row.source === "virtual").map((row) => row.id)).toEqual(["fugu"])
  })

  test("locks protocol family counts and deterministic capped batches", () => {
    expect(inventory.familyCounts).toEqual(familyCounts)
    for (const [family, count] of Object.entries(familyCounts)) {
      expect(inventory.providers.filter((row) => row.source === "catalog" && row.family === family)).toHaveLength(count)
    }

    const batches = Map.groupBy(inventory.providers, (row) => row.batchID)
    for (const [batchID, rows] of batches) {
      expect(batchID).toMatch(
        /^(openai-compatible|openai-direct|anthropic|google-vertex|aws-azure|dedicated-ai-sdk|bespoke-sdk-gateway|synthetic|virtual)-\d{2}$/,
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(10)
      expect(new Set(rows.map((row) => row.family)).size).toBe(1)
      expect(rows.map((row) => row.id)).toEqual(rows.map((row) => row.id).toSorted((a, b) => a.localeCompare(b)))
    }
  })

  test("classifies every built-in and virtual provider", () => {
    expect(inventory.plugins).toHaveLength(34)
    expect(inventory.plugins.map((plugin) => plugin.id)).toEqual(
      inventory.plugins.map((plugin) => plugin.id).toSorted((a, b) => a.localeCompare(b)),
    )
    expect(inventory.plugins.filter((plugin) => plugin.classification === "catalog-mapped")).toHaveLength(29)
    expect(inventory.plugins.find((plugin) => plugin.id === "dynamic-provider")?.classification).toBe("generic-factory")
    expect(inventory.plugins.find((plugin) => plugin.id === "gateway")?.classification).toBe("generic-factory")
    expect(inventory.plugins.find((plugin) => plugin.id === "openai-compatible")?.classification).toBe(
      "generic-factory",
    )
    expect(inventory.plugins.find((plugin) => plugin.id === "snowflake-cortex")?.classification).toBe("config-only")
    expect(inventory.plugins.find((plugin) => plugin.id === "fugu")?.classification).toBe("virtual")
    expect(
      inventory.providers.find((row) => row.id === "fugu")?.scenarios.every((cell) => cell.status === "not-applicable"),
    ).toBe(true)
  })

  test("has representative models, effective APIs, credentials, and complete cells", () => {
    expect(inventory.scenarioCounts).toEqual(scenarioCounts)
    let parity = false
    for (const row of inventory.providers) {
      expect(row.credentialSources.evidence.length).toBeGreaterThan(0)
      expect(row.scenarios.map((cell) => cell.id)).toEqual(scenarioIDs)
      expect(new Set(row.scenarios.map((cell) => cell.id)).size).toBe(scenarioIDs.length)
      for (const cell of row.scenarios) {
        if (cell.status === "parity") parity = true
        expect(["parity", "unsupported", "not-applicable"]).toContain(cell.status)
        expect(cell.evidence.length).toBeGreaterThan(0)
        expect(
          cell.recordingCredentials.every((credential) => credential.id.length > 0 && credential.allOf.length > 0),
        ).toBe(true)
        if (cell.status === "unsupported") {
          expect(cell.modelID).not.toBeNull()
          expect(cell.api?.package.length).toBeGreaterThan(0)
          expect(cell.api?.url).not.toBe("")
          expect(cell.api?.urlEvidence.length).toBeGreaterThan(0)
          expect(cell.api?.urlSource).toBe(cell.api?.url === null ? "provider-runtime" : "catalog")
          expect(cell.recordingCredentials.length).toBeGreaterThan(0)
          expect("reason" in cell ? cell.reason : undefined).toBe(
            "Parity evidence has not been recorded for this provider and scenario.",
          )
          expect("issue" in cell ? cell.issue : undefined).toBe(
            "specs/minimal-baseline.md#pr-11a-n-record-provider-parity-in-capped-batches",
          )
        }
        if (cell.status === "not-applicable") {
          expect("reason" in cell ? cell.reason : undefined).toBeUndefined()
          expect("issue" in cell ? cell.issue : undefined).toBeUndefined()
        }
      }
    }
    expect(parity).toBe(false)

    for (const [scenarioID, count] of Object.entries(scenarioCounts)) {
      expect(
        inventory.providers.filter(
          (row) => row.source === "catalog" && row.scenarios.find((cell) => cell.id === scenarioID)?.modelID !== null,
        ),
      ).toHaveLength(count)
    }

    const effectiveAPI = (providerID: string) =>
      inventory.providers.find((row) => row.id === providerID)?.scenarios.find((cell) => cell.id === "text")?.api
    expect(effectiveAPI("azure")).toMatchObject({
      package: "@ai-sdk/anthropic",
      url: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1",
      urlSource: "catalog",
    })
    expect(effectiveAPI("google-vertex")?.package).toBe("@ai-sdk/google-vertex/anthropic")
    expect(effectiveAPI("opencode-go")?.url).toBe("https://example.invalid/zen/go/v1")
    expect(effectiveAPI("vivgrid")?.package).toBe("@ai-sdk/openai-compatible")
    expect(effectiveAPI("zenmux")).toMatchObject({
      package: "@ai-sdk/anthropic",
      url: "https://zenmux.ai/api/anthropic/v1",
      urlSource: "catalog",
    })
  })

  test("independently derives every catalog representative and not-applicable cell", () => {
    for (const row of inventory.providers) {
      if (row.source !== "catalog") continue
      if (row.catalogID === null) throw new Error(`Catalog row ${row.id} has no catalog ID`)
      const provider = catalog[row.catalogID]
      if (!provider) throw new Error(`Missing catalog fixture provider ${row.catalogID}`)

      for (const cell of row.scenarios) {
        const model = Object.values(provider.models)
          .filter((candidate) => {
            const inputs = candidate.modalities?.input ?? ["text"]
            if (cell.id === "tools") return candidate.tool_call
            if (cell.id === "structured-output") return candidate.structured_output === true
            if (cell.id === "text") return inputs.includes("text")
            return inputs.includes(cell.id.slice("input-".length))
          })
          .sort((a, b) => {
            const rank = (candidate: FixtureModel) => {
              if (candidate.status === "deprecated") return 3
              if (candidate.status === "alpha") return 2
              if (candidate.status === "beta") return 1
              return 0
            }
            return rank(a) - rank(b) || a.id.localeCompare(b.id)
          })[0]

        expect(cell.modelID).toBe(model?.id ?? null)
        if (model) continue
        expect(cell.status).toBe("not-applicable")
        expect(cell.api).toBeNull()
        expect(cell.recordingCredentials).toEqual([])
        expect(cell.evidence).toBe(
          cell.id === "structured-output"
            ? `${sourcePath}#${row.catalogID}.models declares no model with structured_output: true`
            : `${sourcePath}#${row.catalogID}.models declares no ${cell.id} model`,
        )
      }
    }
  })

  test("models complete credential alternatives for every compound catalog declaration", () => {
    expect(
      inventory.providers
        .filter((row) => row.source === "catalog" && row.credentialSources.catalogEnv.length > 1)
        .map((row) => row.id),
    ).toEqual(Object.keys(compoundRecordingCredentials).toSorted((a, b) => a.localeCompare(b)))

    for (const [providerID, alternatives] of Object.entries(compoundRecordingCredentials)) {
      const row = inventory.providers.find((provider) => provider.id === providerID)
      expect(row).toBeDefined()
      for (const cell of row?.scenarios ?? []) {
        if (cell.status === "not-applicable") continue
        expect(cell.recordingCredentials).toEqual(alternatives)
      }
    }
  })
})
