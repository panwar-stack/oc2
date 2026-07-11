#!/usr/bin/env bun

import path from "path"
import { parseArgs } from "util"
import { Effect } from "effect"
import { Flag } from "../src/flag/flag"
import { ModelsDev } from "../src/models-dev"

const root = path.resolve(import.meta.dirname, "../../..")
const sourcePath = path.join(root, "packages/opencode/test/tool/fixtures/models-api.json")
const outputPath = path.join(root, "packages/core/test/fixtures/provider-parity-inventory.json")
const sourceName = "packages/opencode/test/tool/fixtures/models-api.json"
const sourceSHA256 = "d2ea47cabebb5a683cd5d23677dd8f0d597186986da272cc754fda506f7be99b"
const tracker = "specs/minimal-baseline.md#pr-11a-n-record-provider-parity-in-capped-batches"
const defaultPackage = "@ai-sdk/openai-compatible"
const scenarioIDs = [
  "text",
  "tools",
  "structured-output",
  "input-audio",
  "input-image",
  "input-video",
  "input-pdf",
] as const
const catalogFamilies = [
  "openai-compatible",
  "openai-direct",
  "anthropic",
  "google-vertex",
  "aws-azure",
  "dedicated-ai-sdk",
  "bespoke-sdk-gateway",
] as const
const allFamilies = [...catalogFamilies, "synthetic", "virtual"] as const

type Family = (typeof allFamilies)[number]
type ScenarioID = (typeof scenarioIDs)[number]
type Classification = "catalog-mapped" | "generic-factory" | "config-only" | "virtual"
type Source = "catalog" | "synthetic" | "virtual"
type Status = "parity" | "unsupported" | "not-applicable"

type Scenario = {
  id: ScenarioID
  modelID: string | null
  api: { package: string; url: string } | null
  status: Status
  reason?: string
  issue?: string
  evidence: string
  recordingCredentials: { id: string; allOf: string[] }[]
}

type Row = {
  id: string
  source: Source
  catalogID: string | null
  classification: Classification
  family: Family
  batchID: string
  credentialSources: {
    catalogEnv: string[]
    account: boolean
    config: boolean
    evidence: string[]
  }
  scenarios: Scenario[]
}

const familyPackages: Record<(typeof catalogFamilies)[number], readonly string[]> = {
  "openai-compatible": [defaultPackage],
  "openai-direct": ["@ai-sdk/openai"],
  anthropic: ["@ai-sdk/anthropic"],
  "google-vertex": ["@ai-sdk/google", "@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic"],
  "aws-azure": ["@ai-sdk/amazon-bedrock", "@ai-sdk/azure"],
  "dedicated-ai-sdk": [
    "@ai-sdk/cerebras",
    "@ai-sdk/cohere",
    "@ai-sdk/deepinfra",
    "@ai-sdk/gateway",
    "@ai-sdk/groq",
    "@ai-sdk/mistral",
    "@ai-sdk/perplexity",
    "@ai-sdk/togetherai",
    "@ai-sdk/vercel",
    "@ai-sdk/xai",
  ],
  "bespoke-sdk-gateway": [
    "@aihubmix/ai-sdk-provider",
    "@jerome-benoit/sap-ai-provider-v2",
    "@openrouter/ai-sdk-provider",
    "ai-gateway-provider",
    "gitlab-ai-provider",
    "venice-ai-sdk-provider",
  ],
}

const expectedFamilyCounts: Record<(typeof catalogFamilies)[number], number> = {
  "openai-compatible": 89,
  "openai-direct": 3,
  anthropic: 6,
  "google-vertex": 3,
  "aws-azure": 3,
  "dedicated-ai-sdk": 10,
  "bespoke-sdk-gateway": 6,
}

const expectedScenarioCounts: Record<ScenarioID, number> = {
  text: 120,
  tools: 118,
  "structured-output": 120,
  "input-audio": 46,
  "input-image": 94,
  "input-video": 62,
  "input-pdf": 43,
}

const catalogPluginIDs = [
  "alibaba",
  "amazon-bedrock",
  "anthropic",
  "azure",
  "azure-cognitive-services",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "cohere",
  "deepinfra",
  "github-copilot",
  "gitlab",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "groq",
  "kilo",
  "llmgateway",
  "mistral",
  "nvidia",
  "openai",
  "openrouter",
  "perplexity",
  "sap-ai-core",
  "togetherai",
  "venice",
  "vercel",
  "xai",
  "zenmux",
]

const syntheticPlugins: { id: string; classification: Classification; evidence: string; env: string[] }[] = [
  {
    id: "dynamic-provider",
    classification: "generic-factory",
    evidence: "packages/core/src/plugin/provider/dynamic.ts",
    env: [],
  },
  {
    id: "gateway",
    classification: "generic-factory",
    evidence: "packages/core/src/plugin/provider/gateway.ts",
    env: [],
  },
  {
    id: "openai-compatible",
    classification: "generic-factory",
    evidence: "packages/core/src/plugin/provider/openai-compatible.ts",
    env: [],
  },
  {
    id: "snowflake-cortex",
    classification: "config-only",
    evidence: "packages/core/src/plugin/provider/snowflake-cortex.ts",
    env: ["SNOWFLAKE_CORTEX_PAT"],
  },
]

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    batch: { type: "string" },
  },
  strict: true,
})

const source = Bun.file(sourcePath)
const sourceBytes = await source.bytes()
const actualSHA256 = new Bun.CryptoHasher("sha256").update(sourceBytes).digest("hex")
if (actualSHA256 !== sourceSHA256) throw new Error(`Unexpected models.dev fixture SHA-256: ${actualSHA256}`)

const previousPath = Flag.OC2_MODELS_PATH
const previousDisabled = Flag.OC2_DISABLE_MODELS_FETCH
const catalog = await Effect.runPromise(
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Flag.OC2_MODELS_PATH = sourcePath
        Flag.OC2_DISABLE_MODELS_FETCH = true
      }),
      () =>
        ModelsDev.Service.pipe(
          Effect.flatMap((service) => service.get()),
          Effect.provide(ModelsDev.defaultLayer),
        ),
      () =>
        Effect.sync(() => {
          Flag.OC2_MODELS_PATH = previousPath
          Flag.OC2_DISABLE_MODELS_FETCH = previousDisabled
        }),
    ),
  ),
)

const inventory = buildInventory(catalog)
const rendered = `${JSON.stringify(inventory, null, 2)}\n`

if (args.values.batch && !inventory.providers.some((row) => row.batchID === args.values.batch)) {
  throw new Error(`Unknown provider parity batch: ${args.values.batch}`)
}

if (args.values.check) {
  if (!(await Bun.file(outputPath).exists())) throw new Error(`Missing generated inventory: ${outputPath}`)
  if ((await Bun.file(outputPath).text()) !== rendered) {
    throw new Error(
      "Provider parity inventory is stale. Run `bun script/provider-parity-inventory.ts` from packages/core.",
    )
  }
  console.log(
    `provider parity inventory is current (${inventory.providers.length} providers${args.values.batch ? `, batch ${args.values.batch}` : ""})`,
  )
  process.exit(0)
}

await Bun.write(outputPath, rendered)
console.log(`wrote ${path.relative(root, outputPath)} (${inventory.providers.length} providers)`)

function buildInventory(providers: Record<string, ModelsDev.Provider>) {
  const ids = Object.keys(providers).sort()
  if (ids.length !== 120) throw new Error(`Expected 120 canonical catalog providers, found ${ids.length}`)
  if (providers.opencode || !providers.oc2)
    throw new Error("Production ModelsDev canonicalization must replace opencode with oc2")

  const modelCount = Object.values(providers).reduce(
    (total, provider) => total + Object.keys(provider.models).length,
    0,
  )
  if (modelCount !== 4490) throw new Error(`Expected 4490 catalog models, found ${modelCount}`)

  const rows = ids.map((id) => catalogRow(id, providers[id])).concat(syntheticRows(), [fuguRow()])
  const familyCounts = Object.fromEntries(catalogFamilies.map((family) => [family, 0])) as Record<
    (typeof catalogFamilies)[number],
    number
  >
  for (const row of rows) {
    if (row.source !== "catalog") continue
    if (row.family === "synthetic" || row.family === "virtual")
      throw new Error(`Catalog provider ${row.id} has no family`)
    familyCounts[row.family]++
  }
  for (const family of catalogFamilies) {
    if (familyCounts[family] !== expectedFamilyCounts[family]) {
      throw new Error(`Expected ${expectedFamilyCounts[family]} ${family} providers, found ${familyCounts[family]}`)
    }
  }

  for (const scenarioID of scenarioIDs) {
    const count = rows.filter(
      (row) =>
        row.source === "catalog" && row.scenarios.find((scenario) => scenario.id === scenarioID)?.modelID !== null,
    ).length
    if (count !== expectedScenarioCounts[scenarioID]) {
      throw new Error(`Expected ${expectedScenarioCounts[scenarioID]} ${scenarioID} representatives, found ${count}`)
    }
  }

  const batchByID = new Map<string, string>()
  for (const family of allFamilies) {
    const members = rows.filter((row) => row.family === family).sort((a, b) => a.id.localeCompare(b.id))
    members.forEach((row, index) =>
      batchByID.set(row.id, `${family}-${String(Math.floor(index / 10) + 1).padStart(2, "0")}`),
    )
  }
  const batched = rows
    .map((row) => {
      const batchID = batchByID.get(row.id)
      if (!batchID) throw new Error(`Missing batch for ${row.id}`)
      return { ...row, batchID }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  return {
    version: 1,
    source: {
      path: sourceName,
      sha256: sourceSHA256,
      providerCount: 120,
      modelCount: 4490,
    },
    familyCounts,
    scenarioCounts: expectedScenarioCounts,
    plugins: [
      ...catalogPluginIDs.map((id) => ({
        id,
        classification: "catalog-mapped" as const,
        providerID: id,
        evidence: "packages/core/src/plugin/provider.ts",
      })),
      ...syntheticPlugins.map((plugin) => ({
        id: plugin.id,
        classification: plugin.classification,
        providerID: plugin.id,
        evidence: plugin.evidence,
      })),
      {
        id: "fugu",
        classification: "virtual" as const,
        providerID: "fugu",
        evidence: "packages/core/src/plugin/fugu.ts",
      },
    ].sort((a, b) => a.id.localeCompare(b.id)),
    providers: batched,
  }
}

function catalogRow(id: string, provider: ModelsDev.Provider): Row {
  const catalogID = id === "oc2" ? "opencode" : id
  const family = familyFor(provider.npm ?? defaultPackage)
  const credentialEvidence = [
    `${sourceName}#${catalogID}.env`,
    "packages/core/src/plugin/account.ts",
    "packages/core/src/config/provider.ts",
  ]
  return {
    id,
    source: "catalog",
    catalogID,
    classification: "catalog-mapped",
    family,
    batchID: "",
    credentialSources: {
      catalogEnv: [...provider.env],
      account: true,
      config: true,
      evidence: credentialEvidence,
    },
    scenarios: scenarioIDs.map((scenarioID) => catalogScenario(catalogID, provider, scenarioID)),
  }
}

function catalogScenario(catalogID: string, provider: ModelsDev.Provider, scenarioID: ScenarioID): Scenario {
  const model = Object.values(provider.models)
    .filter((candidate) => applicable(candidate, scenarioID))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.id.localeCompare(b.id))[0]
  if (!model) {
    return {
      id: scenarioID,
      modelID: null,
      api: null,
      status: "not-applicable",
      evidence: `${sourceName}#${catalogID}.models declares no ${scenarioID} model`,
      recordingCredentials: [],
    }
  }
  return {
    id: scenarioID,
    modelID: model.id,
    api: {
      package: model.provider?.npm ?? provider.npm ?? defaultPackage,
      url: model.provider?.api ?? provider.api ?? "",
    },
    status: "unsupported",
    reason: "Parity evidence has not been recorded for this provider and scenario.",
    issue: tracker,
    evidence: `${sourceName}#${catalogID}.models.${model.id}`,
    recordingCredentials: provider.env.map((name) => ({ id: `env:${name}`, allOf: [name] })),
  }
}

function applicable(model: ModelsDev.Model, scenarioID: ScenarioID) {
  const inputs = model.modalities?.input ?? ["text"]
  if (scenarioID === "tools") return model.tool_call
  if (scenarioID === "structured-output") return inputs.includes("text")
  if (scenarioID === "text") return inputs.includes("text")
  return inputs.includes(scenarioID.slice("input-".length) as "audio" | "image" | "video" | "pdf")
}

function statusRank(status: ModelsDev.Model["status"]) {
  if (status === "deprecated") return 3
  if (status === "alpha") return 2
  if (status === "beta") return 1
  return 0
}

function familyFor(npm: string): (typeof catalogFamilies)[number] {
  for (const family of catalogFamilies) {
    if (familyPackages[family].includes(npm)) return family
  }
  throw new Error(`Unclassified provider package: ${npm}`)
}

function syntheticRows(): Row[] {
  return syntheticPlugins.map((plugin) => ({
    id: plugin.id,
    source: "synthetic",
    catalogID: null,
    classification: plugin.classification,
    family: "synthetic",
    batchID: "",
    credentialSources: {
      catalogEnv: plugin.env,
      account: plugin.id === "snowflake-cortex",
      config: true,
      evidence: [plugin.evidence],
    },
    scenarios: scenarioIDs.map((scenarioID) => ({
      id: scenarioID,
      modelID: null,
      api: null,
      status: "not-applicable",
      evidence: `${plugin.evidence} is ${plugin.classification} and has no deterministic catalog model`,
      recordingCredentials: plugin.env.map((name) => ({ id: `env:${name}`, allOf: [name] })),
    })),
  }))
}

function fuguRow(): Row {
  return {
    id: "fugu",
    source: "virtual",
    catalogID: null,
    classification: "virtual",
    family: "virtual",
    batchID: "",
    credentialSources: {
      catalogEnv: [],
      account: false,
      config: false,
      evidence: ["packages/core/src/plugin/fugu.ts"],
    },
    scenarios: scenarioIDs.map((scenarioID) => ({
      id: scenarioID,
      modelID: "fugu",
      api: null,
      status: "not-applicable",
      evidence: "packages/core/src/plugin/fugu.ts defines a local virtual model and no remote parity claim",
      recordingCredentials: [],
    })),
  }
}
