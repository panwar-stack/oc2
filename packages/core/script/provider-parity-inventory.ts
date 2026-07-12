#!/usr/bin/env bun

import path from "path"
import { parseArgs } from "util"
import { Effect, Schema } from "effect"
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
  "abort",
  "provider-error",
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
type RecordingCredential = { id: string; allOf: string[] }
type Batch = {
  id: string
  family: Family
  providerIDs: string[]
  providerCount: number
  applicableCellCount: number
}

type Scenario = {
  id: ScenarioID
  modelID: string | null
  api: {
    package: string
    url: string | null
    urlSource: "catalog" | "provider-runtime"
    urlEvidence: string
  } | null
  status: Status
  reason?: string
  issue?: string
  evidence: string
  recordingCredentials: RecordingCredential[]
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
  "structured-output": 72,
  "input-audio": 46,
  "input-image": 94,
  "input-video": 62,
  "input-pdf": 43,
  abort: 120,
  "provider-error": 120,
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

const compoundRecordingCredentials: Record<string, RecordingCredential[]> = {
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

const runtimeURLEvidence: Record<string, string> = {
  "amazon-bedrock":
    "packages/core/src/plugin/provider/amazon-bedrock.ts derives the endpoint from provider options or the AWS SDK runtime",
  azure: "packages/core/src/plugin/provider/azure.ts delegates resource-based endpoint derivation to @ai-sdk/azure",
  "azure-cognitive-services":
    "packages/core/src/plugin/provider/azure.ts delegates configured resource endpoint derivation to @ai-sdk/azure",
  "cloudflare-ai-gateway":
    "packages/core/src/plugin/provider/cloudflare-ai-gateway.ts derives the gateway endpoint from account and gateway options",
  "google-vertex":
    "packages/core/src/plugin/provider/google-vertex.ts delegates regional endpoint derivation to @ai-sdk/google-vertex",
  "google-vertex-anthropic":
    "packages/core/src/plugin/provider/google-vertex.ts delegates regional endpoint derivation to @ai-sdk/google-vertex/anthropic",
}

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
const structuredOutputCatalog = Schema.decodeUnknownSync(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      models: Schema.Record(Schema.String, Schema.Struct({ structured_output: Schema.optional(Schema.Boolean) })),
    }),
  ),
)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(sourceBytes)))

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

const inventory = buildInventory(catalog, structuredOutputCatalog)
const rendered = `${JSON.stringify(inventory, null, 2)}\n`

const selectedBatch = args.values.batch ? inventory.batches.find((batch) => batch.id === args.values.batch) : undefined
if (args.values.batch && !selectedBatch) throw new Error(`Unknown provider parity batch: ${args.values.batch}`)

if (args.values.check) {
  if (!(await Bun.file(outputPath).exists())) throw new Error(`Missing generated inventory: ${outputPath}`)
  if ((await Bun.file(outputPath).text()) !== rendered) {
    throw new Error(
      "Provider parity inventory is stale. Run `bun script/provider-parity-inventory.ts` from packages/core.",
    )
  }
  console.log(
    `provider parity inventory is current (${inventory.providers.length} providers${selectedBatch ? `; ${batchSummary(selectedBatch)}` : ""})`,
  )
  process.exit(0)
}

await Bun.write(outputPath, rendered)
console.log(`wrote ${path.relative(root, outputPath)} (${inventory.providers.length} providers)`)
if (selectedBatch) console.log(batchSummary(selectedBatch))

function buildInventory(
  providers: Record<string, ModelsDev.Provider>,
  capabilities: Record<string, { models: Record<string, { structured_output?: boolean }> }>,
) {
  const ids = Object.keys(providers).sort()
  if (ids.length !== 120) throw new Error(`Expected 120 canonical catalog providers, found ${ids.length}`)
  if (providers.opencode || !providers.oc2)
    throw new Error("Production ModelsDev canonicalization must replace opencode with oc2")

  const modelCount = Object.values(providers).reduce(
    (total, provider) => total + Object.keys(provider.models).length,
    0,
  )
  if (modelCount !== 4490) throw new Error(`Expected 4490 catalog models, found ${modelCount}`)

  const rows = ids
    .map((id) => catalogRow(id, providers[id], capabilities[id === "oc2" ? "opencode" : id]))
    .concat(syntheticRows(), [fuguRow()])
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

  const batchByProviderID = new Map<string, string>()
  const batches: Batch[] = []
  for (const family of allFamilies) {
    const members = rows.filter((row) => row.family === family).sort((a, b) => a.id.localeCompare(b.id))
    let providerIDs: string[] = []
    let applicableCellCount = 0
    const finish = () => {
      if (providerIDs.length === 0) return
      const id = `${family}-${String(batches.filter((batch) => batch.family === family).length + 1).padStart(2, "0")}`
      const batch = {
        id,
        family,
        providerIDs,
        providerCount: providerIDs.length,
        applicableCellCount,
      }
      batches.push(batch)
      for (const providerID of providerIDs) batchByProviderID.set(providerID, id)
      providerIDs = []
      applicableCellCount = 0
    }
    for (const row of members) {
      const cells = row.scenarios.filter((scenario) => scenario.status !== "not-applicable").length
      if (cells > 30) throw new Error(`Provider ${row.id} has ${cells} applicable parity cells and cannot fit a batch`)
      if (providerIDs.length > 0 && (providerIDs.length === 10 || applicableCellCount + cells > 30)) finish()
      providerIDs.push(row.id)
      applicableCellCount += cells
    }
    finish()
  }
  const batched = rows
    .map((row) => {
      const batchID = batchByProviderID.get(row.id)
      if (!batchID) throw new Error(`Missing batch for ${row.id}`)
      return { ...row, batchID }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  validateBatches(batched, batches)

  return {
    version: 2,
    source: {
      path: sourceName,
      sha256: sourceSHA256,
      providerCount: 120,
      modelCount: 4490,
    },
    familyCounts,
    scenarioCounts: expectedScenarioCounts,
    batches,
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

function catalogRow(
  id: string,
  provider: ModelsDev.Provider,
  capabilities: { models: Record<string, { structured_output?: boolean }> },
): Row {
  const catalogID = id === "oc2" ? "opencode" : id
  const family = familyFor(provider.npm ?? defaultPackage)
  const recordingCredentials = credentialsFor(catalogID, provider.env)
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
    scenarios: scenarioIDs.map((scenarioID) =>
      catalogScenario(catalogID, provider, capabilities.models, scenarioID, recordingCredentials),
    ),
  }
}

function catalogScenario(
  catalogID: string,
  provider: ModelsDev.Provider,
  capabilities: Record<string, { structured_output?: boolean }>,
  scenarioID: ScenarioID,
  recordingCredentials: RecordingCredential[],
): Scenario {
  const model = Object.values(provider.models)
    .filter((candidate) => applicable(candidate, capabilities[candidate.id], scenarioID))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.id.localeCompare(b.id))[0]
  if (!model) {
    return {
      id: scenarioID,
      modelID: null,
      api: null,
      status: "not-applicable",
      evidence:
        scenarioID === "structured-output"
          ? `${sourceName}#${catalogID}.models declares no model with structured_output: true`
          : `${sourceName}#${catalogID}.models declares no ${scenarioID} model`,
      recordingCredentials: [],
    }
  }
  const modelURL = model.provider?.api
  const providerURL = provider.api
  const url = modelURL ?? providerURL ?? null
  const apiPackage = model.provider?.npm ?? provider.npm ?? defaultPackage
  return {
    id: scenarioID,
    modelID: model.id,
    api: {
      package: apiPackage,
      url,
      urlSource: url === null ? "provider-runtime" : "catalog",
      urlEvidence:
        modelURL !== undefined
          ? `${sourceName}#${catalogID}.models.${model.id}.provider.api`
          : providerURL !== undefined
            ? `${sourceName}#${catalogID}.api`
            : (runtimeURLEvidence[catalogID] ??
              `${apiPackage} derives its endpoint at runtime; ${sourceName}#${catalogID} declares no model or provider URL`),
    },
    status: "unsupported",
    reason: "Parity evidence has not been recorded for this provider and scenario.",
    issue: tracker,
    evidence: `${sourceName}#${catalogID}.models.${model.id}`,
    recordingCredentials,
  }
}

function credentialsFor(providerID: string, env: readonly string[]): RecordingCredential[] {
  const compound = compoundRecordingCredentials[providerID]
  if (env.length > 1 && !compound) throw new Error(`Missing compound credential rule for ${providerID}`)
  const result = compound ?? env.map((name) => ({ id: `env:${name}`, allOf: [name] }))
  const undeclared = result.flatMap((alternative) => alternative.allOf).filter((name) => !env.includes(name))
  if (undeclared.length > 0) {
    throw new Error(`Credential rule for ${providerID} uses undeclared catalog env: ${undeclared.join(", ")}`)
  }
  return result
}

function applicable(
  model: ModelsDev.Model,
  capabilities: { structured_output?: boolean } | undefined,
  scenarioID: ScenarioID,
) {
  const inputs = model.modalities?.input ?? ["text"]
  if (scenarioID === "tools") return model.tool_call
  if (scenarioID === "structured-output") return capabilities?.structured_output === true
  if (scenarioID === "text" || scenarioID === "abort" || scenarioID === "provider-error") return inputs.includes("text")
  return inputs.includes(scenarioID.slice("input-".length) as "audio" | "image" | "video" | "pdf")
}

function validateBatches(rows: Row[], batches: Batch[]) {
  const assigned = new Set<string>()
  for (const batch of batches) {
    const members = rows.filter((row) => row.batchID === batch.id).sort((a, b) => a.id.localeCompare(b.id))
    const providerIDs = members.map((row) => row.id)
    const applicableCellCount = members.reduce(
      (total, row) => total + row.scenarios.filter((scenario) => scenario.status !== "not-applicable").length,
      0,
    )
    if (batch.providerCount === 0 || batch.providerCount > 10)
      throw new Error(`Provider parity batch ${batch.id} has invalid provider count ${batch.providerCount}`)
    if (batch.applicableCellCount > 30)
      throw new Error(`Provider parity batch ${batch.id} has ${batch.applicableCellCount} applicable cells`)
    if (members.some((row) => row.family !== batch.family))
      throw new Error(`Provider parity batch ${batch.id} mixes protocol families`)
    if (
      batch.providerCount !== providerIDs.length ||
      batch.applicableCellCount !== applicableCellCount ||
      batch.providerIDs.join("\0") !== providerIDs.join("\0")
    )
      throw new Error(`Provider parity batch ${batch.id} manifest does not match its providers`)
    for (const providerID of providerIDs) {
      if (assigned.has(providerID)) throw new Error(`Provider ${providerID} appears in multiple parity batches`)
      assigned.add(providerID)
    }
  }
  if (assigned.size !== rows.length)
    throw new Error(`Expected ${rows.length} batched providers, found ${assigned.size}`)
}

function batchSummary(batch: Batch) {
  return `batch ${batch.id}: family ${batch.family}, ${batch.providerCount} providers, ${batch.applicableCellCount} applicable cells [${batch.providerIDs.join(", ")}]`
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
