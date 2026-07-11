import { LLMEvent, type Usage } from "@oc2-ai/llm"
import type { HttpRecorder } from "@oc2-ai/http-recorder"
import { HttpRecorderInternal } from "@oc2-ai/http-recorder/internal"
import { Option, Schema } from "effect"
import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"

const REDACTED = "[REDACTED]"
const VOLATILE = "[VOLATILE]"
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
  api: Schema.NullOr(Schema.Struct({ package: Schema.String, url: Schema.String })),
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
const Inventory = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    path: Schema.String,
    sha256: Schema.String,
    providerCount: Schema.Number,
    modelCount: Schema.Number,
  }),
  providers: Schema.Array(Provider),
})

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeInventory = Schema.decodeUnknownSync(Inventory)
const decodeCassette = Schema.decodeUnknownSync(Cassette)

export type ProviderParityInventory = Schema.Schema.Type<typeof Inventory>
export type ProviderParityProvider = Schema.Schema.Type<typeof Provider>
export type ProviderParityScenario = Schema.Schema.Type<typeof Scenario>
export type ProviderParityCassette = Schema.Schema.Type<typeof Cassette>

export type ParityRun = {
  readonly requests: ReadonlyArray<HttpRecorder.RequestSnapshot>
  readonly events: ReadonlyArray<LLMEvent>
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

export function auditParityCassettes(
  inventory: ProviderParityInventory,
  committed: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const required: string[] = []
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
      required.push(name)
    }
  }

  const counts = new Map<string, number>()
  for (const name of committed) counts.set(name, (counts.get(name) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name)
  const missing = required.filter((name) => !counts.has(name))
  const extra = [...counts.keys()].filter((name) => !required.includes(name))
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
  const providerFilter = exactFilter("PROVIDER_PARITY_PROVIDER", env.PROVIDER_PARITY_PROVIDER)
  const scenarioFilter = exactFilter("PROVIDER_PARITY_SCENARIO", env.PROVIDER_PARITY_SCENARIO)
  const provider = inventory.providers.find((item) => item.id === providerFilter)
  if (!provider) throw new Error(`Unknown provider parity provider "${providerFilter}"`)
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
  readonly aiSdk: (replay: ReturnType<typeof makeReplay>) => Promise<ParityRun>
  readonly nativeDirect: (replay: ReturnType<typeof makeReplay>) => Promise<ParityRun>
}): Promise<ParityResult> {
  const aiReplay = makeReplay(input.cassette)
  const nativeReplay = makeReplay(input.cassette)
  const aiSdk = await input.aiSdk(aiReplay)
  aiReplay.assertConsumed()
  const native = await input.nativeDirect(nativeReplay)
  nativeReplay.assertConsumed()
  const result = {
    aiSdk: { requests: aiSdk.requests.map(canonicalRequest), events: normalizeEvents(aiSdk.events) },
    native: { requests: native.requests.map(canonicalRequest), events: normalizeEvents(native.events) },
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
  const url = new URL(snapshot.url)
  for (const key of [...url.searchParams.keys()]) {
    if (sensitiveKey(key)) url.searchParams.set(key, REDACTED)
  }
  url.searchParams.sort()
  const headers = Object.fromEntries(
    Object.entries(snapshot.headers)
      .map(([key, value]) => [key.toLowerCase(), sensitiveHeader(key) ? REDACTED : value] as const)
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
      result.push({ type: event.type, index: event.index, reason: event.reason, usage: normalizeUsage(event.usage) })
    if (LLMEvent.is.finish(event))
      result.push({ type: event.type, reason: event.reason, usage: normalizeUsage(event.usage) })
    if (LLMEvent.is.providerError(event))
      result.push({
        type: event.type,
        message: redactString(event.message),
        classification: event.classification,
        retryable: event.retryable,
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
  const residual = (
    [
      [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/, "timestamp"],
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
  if (findings.length || residual.length)
    throw new Error(
      `Provider parity cassette contains possible secrets: ${[
        ...findings.map((item) => `${item.path} (${item.reason})`),
        ...residual,
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
  return /(?:^|_)(?:access|api_?key|authorization|continuation|cookie|credential|encrypted|password|refresh|secret|signature|token)(?:$|_)/i.test(
    key,
  )
}

function volatileKey(key: string) {
  return /(?:^|_)(?:account|created|date|event|fingerprint|idempotency|obfuscation|organization|project|request|timestamp|updated|workspace)(?:$|_)/i.test(
    key,
  )
}

function redactString(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]+\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(
      /\b(?:acct|call|event|fc|item|msg|org|proj|project|req|request|resp|rs|run|thread|trace|user|workspace|wrk)_[A-Za-z0-9_-]+\b/gi,
      VOLATILE,
    )
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, VOLATILE)
}

function stableHeader(key: string) {
  return sensitiveHeader(key) || /^(?:accept|anthropic-version|content-type|openai-beta|x-goog-api-client)$/i.test(key)
}

function sensitiveHeader(key: string) {
  return /^(?:authorization|cookie|proxy-authorization|x-api-key|x-amz-security-token|x-goog-api-key)$/i.test(key)
}

function normalizeUsage(usage: Usage | undefined) {
  if (!usage) return undefined
  return compact({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    nonCachedInputTokens: usage.nonCachedInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
  })
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
    Object.entries(headers).map(([key, value]) => [key, sensitiveHeader(key) ? REDACTED : redactString(value)]),
  )
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
