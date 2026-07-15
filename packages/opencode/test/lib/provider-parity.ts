import { CanonicalUsage, LLMEvent, type Usage } from "@oc2-ai/llm"
import type { HttpRecorder } from "@oc2-ai/http-recorder"
import { HttpRecorderInternal } from "@oc2-ai/http-recorder/internal"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { streamText } from "ai"
import { Effect, Option, Schema } from "effect"
import * as Stream from "effect/Stream"
import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"

const REDACTED = "[REDACTED]"
const VOLATILE = "[VOLATILE]"
const VOLATILE_HOST = "volatile"
const RECORDINGS_PREFIX = "provider-parity"

const RequestSnapshot = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
})
const ResponseSnapshot = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyEncoding: Schema.optional(Schema.Literals(["text", "base64"])),
})
const HttpInteraction = Schema.Struct({
  transport: Schema.Literal("http"),
  request: RequestSnapshot,
  response: ResponseSnapshot,
})
const Cassette = Schema.Struct({
  version: Schema.Literal(1),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  interactions: Schema.Array(HttpInteraction),
})
const RecordingCredential = Schema.Struct({ id: Schema.String, allOf: Schema.Array(Schema.String) })
const Scenario = Schema.Struct({
  id: Schema.String,
  modelID: Schema.NullOr(Schema.String),
  api: Schema.NullOr(
    Schema.Struct({
      package: Schema.String,
      url: Schema.NullOr(Schema.String),
      urlSource: Schema.Literals(["catalog", "provider-runtime"]),
      urlEvidence: Schema.String,
    }),
  ),
  status: Schema.Literals(["parity", "unsupported", "not-applicable"]),
  evidence: Schema.String,
  reason: Schema.optional(Schema.String),
  issue: Schema.optional(Schema.String),
  recordingCredentials: Schema.Array(RecordingCredential),
})
const Provider = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["catalog", "synthetic", "virtual"]),
  classification: Schema.Literals(["catalog-mapped", "generic-factory", "config-only", "virtual"]),
  family: Schema.String,
  batchID: Schema.String,
  credentialSources: Schema.Struct({
    catalogEnv: Schema.Array(Schema.String),
    account: Schema.optional(Schema.Boolean),
    config: Schema.optional(Schema.Boolean),
    evidence: Schema.optional(Schema.Array(Schema.String)),
  }),
  scenarios: Schema.Array(Scenario),
})
const Batch = Schema.Struct({
  id: Schema.String,
  family: Schema.String,
  providerIDs: Schema.Array(Schema.String),
  providerCount: Schema.Number,
  applicableCellCount: Schema.Number,
})
const Inventory = Schema.Struct({
  version: Schema.Literal(2),
  source: Schema.Struct({
    path: Schema.String,
    sha256: Schema.String,
    providerCount: Schema.Number,
    modelCount: Schema.Number,
  }),
  batches: Schema.Array(Batch),
  providers: Schema.Array(Provider),
})

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeInventory = Schema.decodeUnknownSync(Inventory)
const decodeCassette = Schema.decodeUnknownSync(Cassette)

export type ProviderParityInventory = Schema.Schema.Type<typeof Inventory>
export type ProviderParityProvider = Schema.Schema.Type<typeof Provider>
export type ProviderParityScenario = Schema.Schema.Type<typeof Scenario>
export type ProviderParityBatch = Schema.Schema.Type<typeof Batch>
export type ProviderParityCassette = Schema.Schema.Type<typeof Cassette>

export type AISdkParityInput = Parameters<typeof streamText>[0]
export type NativeDirectParityInput = Parameters<typeof LLMNativeRuntime.stream>[0]

export type NativeDirectUnsupportedContext = {
  readonly providerID: string
  readonly modelID: string
  readonly effectiveAPI: { readonly package: string; readonly url: string | null }
  readonly reason: string
}

export class NativeDirectUnsupportedError extends Error {
  readonly _tag = "ProviderParityNativeDirectUnsupported"

  constructor(readonly context: NativeDirectUnsupportedContext) {
    super(
      `Native direct execution is unsupported for provider ${context.providerID}, model ${context.modelID}, effective API ${context.effectiveAPI.package} at ${context.effectiveAPI.url}: ${context.reason}`,
    )
    this.name = "NativeDirectUnsupportedError"
  }
}

export type ParityResult = {
  readonly aiSdk: {
    readonly requests: ReadonlyArray<unknown>
    readonly events: ReadonlyArray<unknown>
  }
  readonly native: {
    readonly requests: ReadonlyArray<unknown>
    readonly events: ReadonlyArray<unknown>
  }
}

export const cassetteName = (provider: ProviderParityProvider, scenario: ProviderParityScenario) =>
  `${RECORDINGS_PREFIX}/${provider.family}/${provider.id}/${scenario.id}`

export const loadProviderParityInventory = async (file: string) =>
  decodeInventory(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await Bun.file(file).text()))

export const loadProviderParityCassette = async (file: string) =>
  decodeCassette(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(await Bun.file(file).text()))

export const listParityCassettes = async (directory: string) => {
  const glob = new Bun.Glob("provider-parity/**/*.json")
  const files = Array.fromAsync(glob.scan({ cwd: directory, onlyFiles: true }))
  return (await files).map((file) => file.replace(/\\/g, "/").replace(/\.json$/, "")).toSorted()
}

export function selectProviderParityBatch(inventory: ProviderParityInventory, batchID: string) {
  const manifests = inventory.batches.filter((batch) => batch.id === batchID)
  if (manifests.length !== 1) throw new Error(`Unknown or duplicate provider parity batch "${batchID}"`)
  const batch = manifests[0]
  const providers = inventory.providers
    .filter((provider) => provider.batchID === batchID)
    .toSorted((a, b) => a.id.localeCompare(b.id))
  const providerIDs = providers.map((provider) => provider.id)
  const cells = providers.flatMap((provider) =>
    provider.scenarios
      .filter((scenario) => scenario.status !== "not-applicable")
      .map((scenario) => ({ provider, scenario, name: cassetteName(provider, scenario) })),
  )
  if (providers.length === 0 || providers.length > 10)
    throw new Error(`Provider parity batch ${batchID} has invalid provider count ${providers.length}`)
  if (new Set(providers.map((provider) => provider.family)).size !== 1 || providers[0].family !== batch.family)
    throw new Error(`Provider parity batch ${batchID} mixes protocol families`)
  if (
    batch.providerCount !== providers.length ||
    batch.applicableCellCount !== cells.length ||
    batch.providerIDs.join("\0") !== providerIDs.join("\0")
  )
    throw new Error(`Provider parity batch ${batchID} manifest does not match its selected cells`)
  if (cells.length > 30) throw new Error(`Provider parity batch ${batchID} has ${cells.length} applicable cells`)
  return { batch, providers, cells }
}

export function auditParityCassettes(
  inventory: ProviderParityInventory,
  committed: ReadonlyArray<string>,
  batchID?: string,
): ReadonlyArray<string> {
  const selected = batchID ? selectProviderParityBatch(inventory, batchID) : undefined
  const selectedProviders = selected ? new Set(selected.providers.map((provider) => provider.id)) : undefined
  const required: string[] = []
  const parity: string[] = []
  const registered = new Set<string>()
  for (const provider of inventory.providers) {
    for (const scenario of provider.scenarios) {
      const name = cassetteName(provider, scenario)
      if (registered.has(name)) throw new Error(`Duplicate provider parity cell targets cassette "${name}"`)
      registered.add(name)
      if (scenario.status === "unsupported" && (!scenario.reason || !scenario.issue))
        throw new Error(`Unsupported provider parity cell ${provider.id}/${scenario.id} requires a reason and issue`)
      if (scenario.status !== "parity") continue
      if (!scenario.modelID || !scenario.api)
        throw new Error(`Parity cell ${provider.id}/${scenario.id} requires a model and effective API`)
      if (scenario.evidence !== undefined && scenario.evidence !== `${name}.json`)
        throw new Error(
          `Provider parity cell ${provider.id}/${scenario.id} has evidence "${scenario.evidence}", expected "${name}.json"`,
        )
      parity.push(name)
      if (!selectedProviders || selectedProviders.has(provider.id)) required.push(name)
    }
  }

  const counts = new Map<string, number>()
  for (const name of committed) counts.set(name, (counts.get(name) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name)
  const missing = required.filter((name) => !counts.has(name))
  const extra = [...counts.keys()].filter((name) => !parity.includes(name))
  const errors = [
    ...(missing.length ? [`Missing provider parity cassettes: ${missing.join(", ")}`] : []),
    ...(extra.length ? [`Extra provider parity cassettes: ${extra.join(", ")}`] : []),
    ...(duplicates.length ? [`Duplicate provider parity cassettes: ${duplicates.join(", ")}`] : []),
  ]
  if (errors.length) throw new Error(errors.join("\n"))
  return required.toSorted()
}

export function selectRecording(inventory: ProviderParityInventory, env: Readonly<Record<string, string | undefined>>) {
  if (env.RECORD !== "true") return undefined
  const batchFilter = exactFilter("PROVIDER_PARITY_BATCH", env.PROVIDER_PARITY_BATCH)
  const providerFilter = exactFilter("PROVIDER_PARITY_PROVIDER", env.PROVIDER_PARITY_PROVIDER)
  const scenarioFilter = exactFilter("PROVIDER_PARITY_SCENARIO", env.PROVIDER_PARITY_SCENARIO)
  selectProviderParityBatch(inventory, batchFilter)
  const provider = inventory.providers.find((item) => item.id === providerFilter)
  if (!provider) throw new Error(`Unknown provider parity provider "${providerFilter}"`)
  if (provider.batchID !== batchFilter)
    throw new Error(
      `Provider parity provider "${providerFilter}" belongs to batch ${provider.batchID}, not ${batchFilter}`,
    )
  const scenario = provider.scenarios.find((item) => item.id === scenarioFilter)
  if (!scenario) throw new Error(`Unknown provider parity scenario "${providerFilter}/${scenarioFilter}"`)
  if (scenario.status !== "parity")
    throw new Error(`Cannot record ${providerFilter}/${scenarioFilter}: cell status is ${scenario.status}`)
  const alternatives = scenario.recordingCredentials
  if (!alternatives.some((alternative) => alternative.allOf.every((name) => Boolean(env[name])))) {
    const expected = alternatives.map((alternative) => alternative.allOf.join(" + ")).join(" or ") || "a credential set"
    throw new Error(`Missing recording credentials for ${providerFilter}/${scenarioFilter}: expected ${expected}`)
  }
  return { provider, scenario, name: cassetteName(provider, scenario) }
}

export async function writeRecordedCassette(input: {
  readonly directory: string
  readonly selection: NonNullable<ReturnType<typeof selectRecording>>
  readonly cassette: ProviderParityCassette
}) {
  const target = path.join(input.directory, `${input.selection.name}.json`)
  if (await Bun.file(target).exists())
    throw new Error(
      `Refusing to overwrite provider parity cassette "${input.selection.name}"; delete it explicitly first`,
    )
  const cassette = redactCassette({
    ...input.cassette,
    metadata: { ...input.cassette.metadata, name: input.selection.name, recordedAt: VOLATILE },
  })
  assertCassetteSafe(cassette)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, `${JSON.stringify(cassette, null, 2)}\n`)
  await rename(temporary, target).finally(() => rm(temporary, { force: true }))
  return target
}

export function makeReplay(cassette: ProviderParityCassette) {
  let cursor = 0
  const requests: HttpRecorder.RequestSnapshot[] = []
  const replay = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const snapshot = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: request.body ? await request.clone().text() : "",
    }
    requests.push(snapshot)
    const interaction = cassette.interactions[cursor]
    if (!interaction)
      throw new Error(`Unexpected provider request ${request.method} ${request.url}; cassette is exhausted`)
    cursor += 1
    if (!deepEqual(canonicalRequest(snapshot), canonicalRequest(interaction.request)))
      throw new Error(
        `Provider request does not match cassette interaction ${cursor}:\n${JSON.stringify(canonicalRequest(snapshot), null, 2)}\nexpected:\n${JSON.stringify(canonicalRequest(interaction.request), null, 2)}`,
      )
    return new Response(
      interaction.response.bodyEncoding === "base64"
        ? Uint8Array.fromBase64(interaction.response.body)
        : interaction.response.body,
      { status: interaction.response.status, headers: interaction.response.headers },
    )
  }
  return {
    fetch: Object.assign(replay, { preconnect: () => undefined }) satisfies typeof fetch,
    requests,
    assertConsumed: () => {
      if (cursor !== cassette.interactions.length)
        throw new Error(`Cassette has ${cassette.interactions.length - cursor} unconsumed interaction(s)`)
    },
  }
}

export async function compareParityRuns(input: {
  readonly cassette: ProviderParityCassette
  readonly aiSdk: (replay: ReturnType<typeof makeReplay>) => AISdkParityInput
  readonly nativeDirect: (replay: ReturnType<typeof makeReplay>) => NativeDirectParityInput
}): Promise<ParityResult> {
  const aiReplay = makeReplay(input.cassette)
  const nativeReplay = makeReplay(input.cassette)
  const nativeInput = input.nativeDirect(nativeReplay)
  const nativeResult = LLMNativeRuntime.stream(nativeInput)
  if (nativeResult.type === "unsupported")
    throw new NativeDirectUnsupportedError({
      providerID: nativeInput.model.providerID,
      modelID: nativeInput.model.id,
      effectiveAPI: { package: nativeInput.model.api.npm, url: nativeInput.model.api.url || null },
      reason: nativeResult.reason,
    })
  const aiResult = streamText(input.aiSdk(aiReplay))
  const aiEvents: LLMEvent[] = []
  const aiState = LLMAISDK.adapterState({
    providerID: String(nativeInput.model.providerID),
    modelID: String(nativeInput.model.id),
    apiPackage: nativeInput.model.api.npm,
  })
  for await (const event of aiResult.fullStream)
    aiEvents.push(...(await Effect.runPromise(LLMAISDK.toLLMEvents(aiState, event))))
  aiReplay.assertConsumed()
  const nativeEvents = Array.from(await Effect.runPromise(Stream.runCollect(nativeResult.stream)))
  nativeReplay.assertConsumed()
  const result = {
    aiSdk: { requests: aiReplay.requests.map(canonicalRequest), events: normalizeEvents(aiEvents) },
    native: { requests: nativeReplay.requests.map(canonicalRequest), events: normalizeEvents(nativeEvents) },
  }
  const golden = input.cassette.interactions.map((interaction) => canonicalRequest(interaction.request))
  if (!deepEqual(result.aiSdk.requests, golden)) throw new Error("AI SDK requests do not match the cassette golden")
  if (!deepEqual(result.native.requests, golden)) throw new Error("Native requests do not match the cassette golden")
  if (!deepEqual(result.aiSdk.events, result.native.events))
    throw new Error(
      `Normalized LLMEvent transcripts differ:\nAI SDK: ${JSON.stringify(result.aiSdk.events, null, 2)}\nNative: ${JSON.stringify(result.native.events, null, 2)}`,
    )
  assertSuccessfulTerminal(result.aiSdk.events)
  return result
}

export function canonicalRequest(snapshot: HttpRecorder.RequestSnapshot): unknown {
  const url = new URL(HttpRecorderInternal.redactUrl(snapshot.url, undefined, canonicalizeUrlIdentifiers))
  for (const key of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(key)
    url.searchParams.delete(key)
    for (const value of values)
      url.searchParams.append(key, sensitiveKey(key) ? REDACTED : volatileKey(key) ? VOLATILE : redactString(value))
  }
  url.searchParams.sort()
  const headers = Object.fromEntries(
    Object.entries(snapshot.headers)
      .map(
        ([key, value]) =>
          [
            key.toLowerCase(),
            sensitiveHeader(key) ? REDACTED : routingIdentifierHeader(key) ? VOLATILE : value,
          ] as const,
      )
      .filter(([key]) => stableHeader(key))
      .toSorted(([left], [right]) => left.localeCompare(right)),
  )
  const decoded = Option.getOrElse(decodeJson(snapshot.body), () => snapshot.body)
  return canonicalize({ method: snapshot.method.toUpperCase(), url: url.toString(), headers, body: decoded })
}

export function normalizeEvents(events: ReadonlyArray<LLMEvent>): ReadonlyArray<unknown> {
  const result: Array<Record<string, unknown>> = []
  const ids = new Map<string, string>()
  const stableID = (id: string, prefix: string) => {
    const existing = ids.get(`${prefix}:${id}`)
    if (existing) return existing
    const next = `${prefix}-${[...ids.keys()].filter((key) => key.startsWith(`${prefix}:`)).length + 1}`
    ids.set(`${prefix}:${id}`, next)
    return next
  }
  for (const event of events) {
    if (LLMEvent.is.textStart(event) || LLMEvent.is.textEnd(event)) continue
    if (LLMEvent.is.reasoningStart(event) || LLMEvent.is.reasoningEnd(event)) continue
    if (LLMEvent.is.toolInputStart(event) || LLMEvent.is.toolInputEnd(event)) continue
    if (LLMEvent.is.textDelta(event) || LLMEvent.is.reasoningDelta(event)) {
      pushText(result, event.type === "text-delta" ? "text" : "reasoning", event.text)
      continue
    }
    if (LLMEvent.is.toolInputDelta(event)) {
      const id = stableID(event.id, "tool")
      const previous = result.at(-1)
      if (previous?.type === "tool-input" && previous.id === id) previous.text = `${previous.text ?? ""}${event.text}`
      else result.push({ type: "tool-input", id, name: event.name, text: event.text })
      continue
    }
    if (LLMEvent.is.toolCall(event)) {
      result.push({
        type: event.type,
        id: stableID(event.id, "tool"),
        name: event.name,
        input: canonicalize(event.input),
        ...(event.providerExecuted === undefined ? {} : { providerExecuted: event.providerExecuted }),
      })
      continue
    }
    if (LLMEvent.is.toolResult(event)) {
      result.push({
        type: event.type,
        id: stableID(event.id, "tool"),
        name: event.name,
        result: canonicalize(event.result),
        ...(event.output === undefined ? {} : { output: canonicalize(event.output) }),
        ...(event.providerExecuted === undefined ? {} : { providerExecuted: event.providerExecuted }),
      })
      continue
    }
    if (LLMEvent.is.toolError(event)) {
      result.push({
        type: event.type,
        id: stableID(event.id, "tool"),
        name: event.name,
        message: redactString(event.message),
      })
      continue
    }
    if (LLMEvent.is.stepStart(event)) result.push({ type: event.type, index: event.index })
    if (LLMEvent.is.stepFinish(event))
      result.push({
        type: event.type,
        index: event.index,
        reason: event.reason,
        usage: normalizeUsage(event.usage),
      })
    if (LLMEvent.is.finish(event))
      result.push({
        type: event.type,
        reason: event.reason,
        usage: normalizeUsage(event.usage),
      })
    if (LLMEvent.is.providerError(event))
      result.push({
        type: event.type,
        message: redactString(event.message),
        classification: event.classification,
        retryable: event.retryable,
        usage: normalizeUsage(event.usage),
      })
  }
  return result.map(compact)
}

export function redactCassette(cassette: ProviderParityCassette): ProviderParityCassette {
  return {
    ...cassette,
    metadata: cassette.metadata
      ? (canonicalize({ ...cassette.metadata, recordedAt: VOLATILE }) as Record<string, unknown>)
      : undefined,
    interactions: cassette.interactions.map((interaction) => ({
      ...interaction,
      request: redactedRequest(interaction.request),
      response: {
        ...interaction.response,
        headers: redactHeaders(interaction.response.headers),
        body: redactBody(interaction.response.body),
      },
    })),
  }
}

export function assertCassetteSafe(cassette: ProviderParityCassette) {
  const findings = HttpRecorderInternal.secretFindings(cassette)
  const serialized = JSON.stringify(cassette)
  const identifiers = cassetteIdentifierFindings(cassette)
  const unsafeUrls = cassette.interactions.flatMap((interaction, index) => {
    if (!URL.canParse(interaction.request.url)) return [`interactions[${index}].request.url (invalid URL)`]
    const url = new URL(interaction.request.url)
    const credentials = [url.username, url.password].filter((value) => value && decodeURIComponent(value) !== REDACTED)
    const identifiers = urlIdentifiers(url).filter(
      (value) => value !== VOLATILE && value !== VOLATILE_HOST && value !== REDACTED,
    )
    return credentials.length || identifiers.length ? [`interactions[${index}].request.url (sensitive identifier)`] : []
  })
  const residual = (
    [
      [/\b(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|1[5-9]\d{8}(?:\d{3})?)\b/, "timestamp"],
      [
        /\b(?:[0-9a-f]{24,64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i,
        "volatile identifier",
      ],
      [
        /\b(?:acct|call|event|fc|item|msg|org|proj|req|resp|rs|run|thread|trace|user|workspace|wrk)_[A-Za-z0-9_-]+\b/i,
        "volatile identifier",
      ],
      [
        /"(?:access|api_?key|authorization|continuation|cookie|credential|encrypted|password|refresh|secret|signature|token)[^"]*"\s*:\s*"(?!\[REDACTED\])[^" ]+"/i,
        "sensitive field",
      ],
    ] satisfies ReadonlyArray<readonly [RegExp, string]>
  )
    .filter(([pattern]) => pattern.test(serialized))
    .map(([, reason]) => reason)
  if (findings.length || residual.length || unsafeUrls.length || identifiers.length)
    throw new Error(
      `Provider parity cassette contains possible secrets: ${[
        ...findings.map((item) => `${item.path} (${item.reason})`),
        ...residual,
        ...unsafeUrls,
        ...identifiers,
      ].join(", ")}`,
    )
}

function exactFilter(name: string, value: string | undefined) {
  if (!value || value.trim() !== value || value.includes(","))
    throw new Error(`RECORD=true requires one exact ${name} filter`)
  return value
}

function canonicalize(value: unknown, key = ""): unknown {
  if (sensitiveKey(key)) return REDACTED
  if (volatileKey(key)) return VOLATILE
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, child]) => [childKey, canonicalize(child, childKey)] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    )
  if (typeof value !== "string") return value
  return redactString(value)
}

function sensitiveKey(key: string) {
  return /(?:^|_)(?:access|api_?key|authorization|continuation|cookie|credential|encrypted|password|refresh|secret|signature|token)(?:$|_)/.test(
    semanticKey(key),
  )
}

function volatileKey(key: string) {
  return (
    identifierKey(key) ||
    /(?:^|_)(?:created|date|epoch|event|fingerprint|idempotency|obfuscation|request|time|timestamp|ts|updated)(?:$|_)/.test(
      semanticKey(key),
    )
  )
}

function identifierKey(key: string) {
  const normalized = semanticKey(key)
  return (
    /(?:^|_)(?:account|organization|project|workspace)(?:_id)?$/.test(normalized) ||
    /(?:^|_)(?:resource|response|subscription|tenant)_id$/.test(normalized)
  )
}

function routingIdentifierHeader(key: string) {
  const normalized = semanticKey(key)
  return /(?:^|_)(?:account|organization|project|resource|subscription|tenant|workspace)(?:_id)?$/.test(normalized)
}

function volatileResponseHeader(key: string) {
  const normalized = semanticKey(key)
  return (
    routingIdentifierHeader(key) ||
    /(?:^|_)(?:correlation|event|invocation|operation|request|response|trace|transaction)(?:_?id)$/.test(normalized) ||
    /(?:^|_)(?:created|date|epoch|expires|modified|reset|time|timestamp|updated)(?:$|_)/.test(normalized)
  )
}

function semanticKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
}

function redactString(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]+\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\b(arn:(?:aws|aws-cn|aws-us-gov):[^:\s]*:[^:\s]*:)\d{12}(?=:)/gi, `$1${VOLATILE}`)
    .replace(
      /\b(?:acct|account|call|event|fc|item|msg|org|organization|proj|project|req|request|resp|rs|run|thread|trace|user|workspace|wrk)[_-][A-Za-z0-9_-]+\b/gi,
      VOLATILE,
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, VOLATILE)
    .replace(/\b[0-9a-f]{24,64}\b/gi, VOLATILE)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g, VOLATILE)
    .replace(/\b1[5-9]\d{8}(?:\d{3})?\b/g, VOLATILE)
}

function stableHeader(key: string) {
  return (
    sensitiveHeader(key) ||
    routingIdentifierHeader(key) ||
    /^(?:accept|anthropic-version|content-type|openai-beta|x-goog-api-client)$/i.test(key)
  )
}

function sensitiveHeader(key: string) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
  return (
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("privatetoken") ||
    normalized.endsWith("securitytoken") ||
    normalized.endsWith("subscriptionkey")
  )
}

function canonicalizeUrlIdentifiers(value: string) {
  const url = new URL(value)
  const segments = url.pathname.split("/")
  url.pathname = segments
    .map((segment, index) => {
      const decoded = decodeURIComponent(segment)
      if (resourceSegment(segments[index - 1] ?? "")) return VOLATILE
      return redactString(decoded)
    })
    .join("/")
  const labels = url.hostname.split(".")
  url.hostname = labels
    .map((label, index) => (hostnameIdentifier(label, index, labels) ? VOLATILE_HOST : label))
    .join(".")
  return url.toString()
}

function urlIdentifiers(url: URL) {
  const segments = url.pathname.split("/").map((segment) => decodeURIComponent(segment))
  const labels = url.hostname.split(".")
  return [
    ...segments.filter((segment, index) => resourceSegment(segments[index - 1] ?? "") && segment),
    ...labels.filter((label, index) => hostnameIdentifier(label, index, labels)),
    ...[...url.searchParams].flatMap(([key, value]) => (volatileKey(key) ? [value] : [])),
  ]
}

function resourceSegment(value: string) {
  return /^(?:accounts?|organizations?|orgs?|projects?|resources?|resource-?groups?|responses?|subscriptions?|tenants?|workspaces?)$/i.test(
    value,
  )
}

function identifierValue(value: string) {
  return (
    /^(?:acct|account|org|organization|proj|project|workspace|wrk)[_-].+/i.test(value) ||
    /^[0-9a-f]{24,64}$/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function hostnameIdentifier(value: string, index: number, labels: ReadonlyArray<string>) {
  if (identifierValue(value)) return true
  if (index !== 0) return false
  return /^(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com|(?:[^.]+\.)*azuredatabricks\.net|(?:[^.]+\.)*snowflakecomputing\.com)$/.test(
    labels.slice(1).join("."),
  )
}

function normalizeUsage(usage: Usage | undefined) {
  if (!usage) return undefined
  const canonical = CanonicalUsage.fromUsage(usage)
  if (!canonical) return undefined
  return {
    input: canonical.input,
    output: canonical.output,
    reasoning: canonical.reasoning,
    cache: canonical.cache,
  }
}

function pushText(result: Array<Record<string, unknown>>, type: "text" | "reasoning", text: string) {
  const previous = result.at(-1)
  if (previous?.type === type) previous.text = `${previous.text ?? ""}${text}`
  else result.push({ type, text })
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined))
}

function redactedRequest(request: HttpRecorder.RequestSnapshot) {
  const canonical = canonicalRequest(request)
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical))
    throw new Error("Invalid canonical request")
  const record = canonical as Record<string, unknown>
  return {
    method: String(record.method),
    url: String(record.url),
    headers: record.headers as Record<string, string>,
    body: typeof record.body === "string" ? redactBody(record.body) : JSON.stringify(record.body),
  }
}

function redactHeaders(headers: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      sensitiveHeader(key)
        ? REDACTED
        : volatileResponseHeader(key)
          ? VOLATILE
          : key.toLowerCase() === "content-type"
            ? value
            : redactString(value),
    ]),
  )
}

function cassetteIdentifierFindings(cassette: ProviderParityCassette) {
  const result: string[] = []
  const visit = (value: unknown, currentPath: string): void => {
    if (typeof value === "string") {
      if (/\barn:(?:aws|aws-cn|aws-us-gov):[^:\s]*:[^:\s]*:\d{12}(?=:)/i.test(value))
        result.push(`${currentPath} (AWS account identifier)`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${currentPath}[${index}]`))
      return
    }
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      const childPath = currentPath ? `${currentPath}.${key}` : key
      if (
        identifierKey(key) &&
        (typeof child === "string" || typeof child === "number") &&
        child !== "" &&
        child !== REDACTED &&
        child !== VOLATILE
      )
        result.push(`${childPath} (volatile identifier)`)
      visit(child, childPath)
    }
  }
  const visitBody = (body: string, currentPath: string) =>
    Option.match(decodeJson(body), {
      onNone: () =>
        body.split("\n").forEach((line, index) => {
          const eventID = /^id:\s?(.*)\r?$/.exec(line)?.[1]
          if (eventID && eventID !== REDACTED && eventID !== VOLATILE)
            result.push(`${currentPath}.id[${index}] (volatile event identifier)`)
          if (!line.startsWith("data:")) return
          Option.match(decodeJson(line.slice(5).trimStart()), {
            onNone: () => undefined,
            onSome: (value) => visit(value, `${currentPath}.data[${index}]`),
          })
        }),
      onSome: (value) => visit(value, currentPath),
    })

  visit(cassette, "")
  cassette.interactions.forEach((interaction, index) => {
    for (const [key, value] of Object.entries(interaction.response.headers))
      if (volatileResponseHeader(key) && value !== REDACTED && value !== VOLATILE)
        result.push(`interactions[${index}].response.headers.${key} (volatile response metadata)`)
    visitBody(interaction.request.body, `interactions[${index}].request.body`)
    visitBody(interaction.response.body, `interactions[${index}].response.body`)
  })
  return result
}

function redactBody(body: string) {
  const direct = Option.match(decodeJson(body), {
    onNone: () => redactString(body),
    onSome: (value) => JSON.stringify(canonicalize(value)),
  })
  if (direct !== redactString(body)) return direct
  return body
    .split("\n")
    .map((line) => {
      if (/^id:/.test(line)) return /^id:\s*(?:\r)?$/.test(line) ? "id:" : `id: ${VOLATILE}`
      if (!line.startsWith("data:")) return redactString(line)
      const data = line.slice(5).trimStart()
      return Option.match(decodeJson(data), {
        onNone: () => `data: ${redactString(data)}`,
        onSome: (value) => `data: ${JSON.stringify(canonicalize(value))}`,
      })
    })
    .join("\n")
}

function assertSuccessfulTerminal(events: ReadonlyArray<unknown>) {
  const finishes = events.filter((event) =>
    Boolean(event && typeof event === "object" && "type" in event && event.type === "finish"),
  )
  const errors = events.filter((event) =>
    Boolean(event && typeof event === "object" && "type" in event && event.type === "provider-error"),
  )
  if (!errors.length && finishes.length !== 1)
    throw new Error(
      `Successful provider parity transcript must contain exactly one terminal finish, found ${finishes.length}`,
    )
}

function deepEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export const providerParityPaths = {
  inventory: path.resolve(import.meta.dir, "../../../core/test/fixtures/provider-parity-inventory.json"),
  recordings: path.resolve(import.meta.dir, "../fixtures/recordings"),
} as const
