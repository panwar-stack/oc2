export * as SessionV1 from "./session"

import { Effect, Schema, Types } from "effect"
import { CanonicalUsage, ProviderMetadata } from "@oc2-ai/llm"
import { EventV2 } from "../event"
import { PermissionV1 } from "./permission"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"
import { optionalOmitUndefined, withStatics } from "../schema"
import { Identifier } from "../util/identifier"
import { NonNegativeInt } from "../schema"
import { NamedError } from "../util/error"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"

const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(
  Schema.brand("MessageID"),
  withStatics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "msg_" + Identifier.ascending()) })),
)
export type MessageID = typeof MessageID.Type

export const PartID = Schema.String.check(Schema.isStartsWith("prt")).pipe(
  Schema.brand("PartID"),
  withStatics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "prt_" + Identifier.ascending()) })),
)
export type PartID = typeof PartID.Type

export const OutputLengthError = NamedError.create("MessageOutputLengthError", {})

export const AuthError = NamedError.create("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})

export const AbortedError = NamedError.create("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = NamedError.create("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = NamedError.create("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {}

export const Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export type OutputFormat = Schema.Schema.Type<typeof Format>

const partBase = {
  id: PartID,
  sessionID: SessionSchema.ID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
}).annotate({ identifier: "SnapshotPart" })
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
}).annotate({ identifier: "PatchPart" })
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPart" })
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "ReasoningPart" })
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: Schema.Finite,
    end: Schema.Finite,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const Range = Schema.Struct({
  start: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
  end: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
}).annotate({ identifier: "FileSource" })

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: Range,
  name: Schema.String,
  kind: NonNegativeInt,
}).annotate({ identifier: "SymbolSource" })

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "ResourceSource" })

export const FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePart" })
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPart" })
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  tail_start_id: Schema.optional(MessageID),
}).annotate({ identifier: "CompactionPart" })
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPart" })
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
}).annotate({ identifier: "RetryPart" })
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
}).annotate({ identifier: "StepStartPart" })
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

const StepFinishCanonicalUsage = Schema.Struct(CanonicalUsage.fields).annotate({
  identifier: "StepFinishCanonicalUsage",
})
const profileNumbers = new Set([
  "input_tokens",
  "output_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "cost",
  "cost_in_usd_ticks",
])
const anthropicUsageNumbers = new Set([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
])
const googleNumbers = new Set([
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
])
const bedrockNumbers = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "cacheCreationInputTokens",
])
const openrouterNumbers = new Set([
  "inputTokens",
  "outputTokens",
  "promptTokens",
  "completionTokens",
  "reasoningTokens",
  "totalTokens",
  "cachedInputTokens",
  "cost",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isBillingNumber(value: unknown, nullable = false) {
  return (nullable && value === null) || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function isNumberRecord(value: unknown, fields: ReadonlySet<string>, nullable: ReadonlySet<string> = new Set()) {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  return Object.entries(value).every(([key, item]) => fields.has(key) && isBillingNumber(item, nullable.has(key)))
}

function isBillingIteration(value: unknown) {
  if (!isRecord(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (key === "type") {
      if (item !== "message" && item !== "compaction" && item !== "advisor_message") return false
      continue
    }
    if (key === "model") {
      if (typeof item !== "string") return false
      continue
    }
    if (!anthropicUsageNumbers.has(key) || !isBillingNumber(item, key.startsWith("cache_"))) return false
  }
  if (
    (value.type !== "message" && value.type !== "compaction" && value.type !== "advisor_message") ||
    !isBillingNumber(value.input_tokens) ||
    !isBillingNumber(value.output_tokens)
  )
    return false
  return value.type === "advisor_message" ? typeof value.model === "string" : value.model === undefined
}

function isAnthropicUsage(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  for (const [key, item] of Object.entries(value)) {
    if (anthropicUsageNumbers.has(key)) {
      if (!isBillingNumber(item, key.startsWith("cache_"))) return false
      continue
    }
    if (key === "iterations") {
      if (!Array.isArray(item) || item.length === 0 || !item.every(isBillingIteration)) return false
      continue
    }
    return false
  }
  return true
}

function isAnthropicBilling(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  for (const [key, item] of Object.entries(value)) {
    if (key === "usage") {
      if (!isAnthropicUsage(item)) return false
      continue
    }
    if (key === "cacheCreationInputTokens") {
      if (!isBillingNumber(item)) return false
      continue
    }
    if (!isAnthropicUsage({ [key]: item })) return false
  }
  return true
}

function isProfileBilling(value: unknown, openai = false): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  for (const [key, item] of Object.entries(value)) {
    if (profileNumbers.has(key) || (openai && (key === "acceptedPredictionTokens" || key === "rejectedPredictionTokens"))) {
      if (!isBillingNumber(item, key === "cost")) return false
      continue
    }
    if (key === "is_byok") {
      if (typeof item !== "boolean") return false
      continue
    }
    if (key === "input_tokens_details" || key === "prompt_tokens_details") {
      if (item !== null && !isNumberRecord(item, new Set(["cached_tokens", "cache_write_tokens"]), new Set(["cache_write_tokens"]))) return false
      continue
    }
    if (key === "output_tokens_details" || key === "completion_tokens_details") {
      if (item !== null && !isNumberRecord(item, new Set(["reasoning_tokens"]))) return false
      continue
    }
    if (key === "cost_details") {
      if (
        item !== null &&
        !isNumberRecord(
          item,
          new Set([
            "upstream_inference_cost",
            "upstream_inference_prompt_cost",
            "upstream_inference_completions_cost",
          ]),
          new Set([
            "upstream_inference_cost",
            "upstream_inference_prompt_cost",
            "upstream_inference_completions_cost",
          ]),
        )
      )
        return false
      continue
    }
    return false
  }
  return true
}

function isOpenRouterBilling(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("usage" in value)) return false
  const usage = value.usage
  if (!isRecord(usage) || Object.keys(usage).length === 0) return false
  for (const [key, item] of Object.entries(usage)) {
    if (openrouterNumbers.has(key) || profileNumbers.has(key)) {
      if (!isBillingNumber(item, key === "cost")) return false
      continue
    }
    if (key === "costDetails") {
      if (!isNumberRecord(item, new Set(["upstreamInferenceCost"]))) return false
      continue
    }
    if (key === "promptTokensDetails") {
      if (!isNumberRecord(item, new Set(["cachedTokens"]))) return false
      continue
    }
    if (key === "completionTokensDetails") {
      if (!isNumberRecord(item, new Set(["reasoningTokens"]))) return false
      continue
    }
    if (key === "input_tokens_details" || key === "prompt_tokens_details") {
      if (item !== null && !isNumberRecord(item, new Set(["cached_tokens", "cache_write_tokens"]), new Set(["cache_write_tokens"]))) return false
      continue
    }
    if (key === "output_tokens_details" || key === "completion_tokens_details") {
      if (item !== null && !isNumberRecord(item, new Set(["reasoning_tokens"]))) return false
      continue
    }
    if (key === "cost_details") {
      if (
        item !== null &&
        !isNumberRecord(
          item,
          new Set([
            "upstream_inference_cost",
            "upstream_inference_prompt_cost",
            "upstream_inference_completions_cost",
          ]),
          new Set([
            "upstream_inference_cost",
            "upstream_inference_prompt_cost",
            "upstream_inference_completions_cost",
          ]),
        )
      )
        return false
      continue
    }
    if (key !== "is_byok" || typeof item !== "boolean") return false
  }
  return true
}

function isProviderBilling(provider: string, value: unknown) {
  if (provider === "anthropic" || provider === "vertex") return isAnthropicBilling(value)
  if (provider === "google" || provider === "google-vertex") {
    if (!isRecord(value) || Object.keys(value).length === 0) return false
    return Object.entries(value).every(([key, item]) =>
      key === "usageMetadata" ? isNumberRecord(item, googleNumbers) : googleNumbers.has(key) && isBillingNumber(item),
    )
  }
  if (provider === "bedrock" || provider === "venice") {
    if (!isRecord(value) || Object.keys(value).length === 0) return false
    return Object.entries(value).every(([key, item]) =>
      key === "usage" ? isNumberRecord(item, bedrockNumbers) : bedrockNumbers.has(key) && isBillingNumber(item),
    )
  }
  if (provider === "openrouter") return isOpenRouterBilling(value)
  if (provider === "copilot") return isNumberRecord(value, new Set(["totalNanoAiu"]))
  if (provider === "openai") return isProfileBilling(value, true)
  if (provider === "xai" || provider === "deepinfra" || provider === "deepseek") return isProfileBilling(value)
  return false
}

const BillingProviderMetadataWrite = ProviderMetadata.check(
  Schema.makeFilter((metadata) =>
    Object.keys(metadata).length > 0 && Object.entries(metadata).every(([provider, value]) => isProviderBilling(provider, value))
      ? undefined
      : "providerMetadata must contain only supported usage and billing fields",
  ),
).annotate({ identifier: "BillingProviderMetadataWrite" })
const StepFinishCanonicalUsageWrite = Schema.Struct({
  ...CanonicalUsage.fields,
  providerMetadata: Schema.optional(BillingProviderMetadataWrite),
})
const stepFinishAccountingBase = {
  mode: Schema.Literal("aggregate"),
  purpose: Schema.Literal("assistant"),
  model: ModelV2.Ref,
  usage: Schema.Struct({
    authoritative: StepFinishCanonicalUsage,
    source: Schema.Literal("provider-error"),
  }),
}

export const StepFinishAccounting = Schema.Struct({
  ...stepFinishAccountingBase,
  time: Schema.Struct({
    started: Schema.Finite,
    completed: Schema.Finite,
    duration: Schema.Finite,
  }),
  pricing: Schema.Struct({
    source: Schema.Literals(["provider", "catalog"]),
    amount: Schema.Finite,
    providerAmount: Schema.optional(Schema.Finite),
    estimateAmount: Schema.optional(Schema.Finite),
    rate: Schema.optional(ModelV2.Cost),
  }).pipe(Schema.optional),
}).annotate({ identifier: "StepFinishAccounting" })
export type StepFinishAccounting = typeof StepFinishAccounting.Type

const AccountingAmountWrite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const AccountingRateWrite = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: NonNegativeInt,
  }).pipe(Schema.optional),
  input: AccountingAmountWrite,
  output: AccountingAmountWrite,
  cache: Schema.Struct({
    read: AccountingAmountWrite,
    write: AccountingAmountWrite,
  }),
})
const AccountingPricingWrite = Schema.Struct({
  source: Schema.Literals(["provider", "catalog"]),
  amount: AccountingAmountWrite,
  providerAmount: Schema.optional(AccountingAmountWrite),
  estimateAmount: Schema.optional(AccountingAmountWrite),
  rate: Schema.optional(AccountingRateWrite),
}).check(
  Schema.makeFilter((pricing) => {
    if (pricing.source === "provider") {
      if (pricing.providerAmount === undefined) return { path: ["providerAmount"], issue: "providerAmount is required" }
      if (pricing.amount !== pricing.providerAmount) {
        return { path: ["amount"], issue: "provider pricing amount must equal providerAmount" }
      }
      return
    }
    if (pricing.estimateAmount === undefined) return { path: ["estimateAmount"], issue: "estimateAmount is required" }
    if (pricing.amount !== pricing.estimateAmount) {
      return { path: ["amount"], issue: "catalog pricing amount must equal estimateAmount" }
    }
  }),
)
const StepFinishAccountingWrite = Schema.Struct({
  ...stepFinishAccountingBase,
  time: Schema.Struct({
    started: NonNegativeInt,
    completed: NonNegativeInt,
    duration: NonNegativeInt,
  }).check(
    Schema.makeFilter((time) => {
      const issues: Array<Schema.FilterIssue> = []
      if (time.completed < time.started) {
        issues.push({ path: ["completed"], issue: "completed must be greater than or equal to started" })
      }
      if (time.duration > time.completed - time.started) {
        issues.push({ path: ["duration"], issue: "duration must not exceed completed minus started" })
      }
      return issues
    }),
  ),
  usage: Schema.Struct({
    authoritative: StepFinishCanonicalUsageWrite,
    source: Schema.Literal("provider-error"),
  }),
  pricing: AccountingPricingWrite.pipe(Schema.optional),
}).annotate({ identifier: "StepFinishAccountingWrite" })

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  duration: Schema.optional(NonNegativeInt),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  accounting: Schema.optional(StepFinishAccounting),
}).annotate({ identifier: "StepFinishPart" })
export type StepFinishPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>, "accounting"> & {
  accounting?: StepFinishAccounting
}

const StepFinishPartWrite = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  duration: Schema.optional(NonNegativeInt),
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  tokens: Schema.Struct({
    total: Schema.optional(NonNegativeInt),
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  }),
  accounting: Schema.optional(StepFinishAccountingWrite),
})
  .check(
    Schema.makeFilter((part) => {
      const accounting = part.accounting
      if (!accounting) return
      const authoritative = accounting.usage.authoritative
      const issues: Array<Schema.FilterIssue> = []
      if (part.duration !== accounting.time.duration) {
        issues.push({ path: ["duration"], issue: "duration must equal accounting time duration" })
      }
      if (part.cost !== (accounting.pricing?.amount ?? 0)) {
        issues.push({ path: ["cost"], issue: "cost must equal accounting pricing amount" })
      }
      if (part.tokens.total !== authoritative.providerTotal) {
        issues.push({ path: ["tokens", "total"], issue: "total must equal authoritative providerTotal" })
      }
      for (const [path, actual, expected] of [
        [["tokens", "input"], part.tokens.input, authoritative.input],
        [["tokens", "output"], part.tokens.output, authoritative.output],
        [["tokens", "reasoning"], part.tokens.reasoning, authoritative.reasoning],
        [["tokens", "cache", "read"], part.tokens.cache.read, authoritative.cache.read],
        [["tokens", "cache", "write"], part.tokens.cache.write, authoritative.cache.write],
      ] satisfies Array<[ReadonlyArray<PropertyKey>, number, number]>) {
        if (actual !== expected) issues.push({ path, issue: "token value must equal authoritative accounting" })
      }
      return issues
    }),
  )
  .annotate({ identifier: "StepFinishPartWrite" })

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
}).annotate({ identifier: "ToolStatePending" })
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateRunning" })
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
}).annotate({ identifier: "ToolStateCompleted" })
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
}).annotate({ identifier: "ToolStateError" })
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

export const ToolState = Schema.Union([
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "ToolPart" })
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: partBase.sessionID,
}

const FileDiff = Schema.Struct({
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: Timestamp,
  }),
  format: Schema.optional(Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(FileDiff),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
}).annotate({ identifier: "UserMessage" })
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

export const Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

export const PartWrite = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPartWrite,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "PartWrite" })
export type PartWrite = Types.DeepMutable<Schema.Schema.Type<typeof PartWrite>>

const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  NamedError.Unknown.EffectSchema,
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })
type AssistantError = Schema.Schema.Type<typeof AssistantErrorSchema>

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "TextPartInput" })
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(FilePartSource),
}).annotate({ identifier: "FilePartInput" })
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
}).annotate({ identifier: "AgentPartInput" })
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderV2.ID,
      modelID: ModelV2.ID,
    }),
  ),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "SubtaskPartInput" })
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  modelID: ModelV2.ID,
  providerID: ProviderV2.ID,
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(Schema.Finite),
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
}).annotate({ identifier: "AssistantMessage" })
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

export const Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export type Info = User | Assistant

export const WithParts = Schema.Struct({
  info: Info,
  parts: Schema.Array(Part),
})
export type WithParts = {
  info: Info
  parts: Part[]
}

const options = {
  sync: {
    aggregate: "sessionID",
    version: 1,
  },
} as const

const SessionSummary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: optionalOmitUndefined(Schema.Array(FileDiff)),
})

const SessionTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

const SessionRevert = Schema.Struct({
  messageID: MessageID,
  partID: optionalOmitUndefined(PartID),
  snapshot: optionalOmitUndefined(Schema.String),
  diff: optionalOmitUndefined(Schema.String),
})

const SessionModel = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  variant: optionalOmitUndefined(Schema.String),
})

export const SessionInfo = Schema.Struct({
  id: SessionSchema.ID,
  slug: Schema.String,
  projectID: ProjectV2.ID,
  workspaceID: optionalOmitUndefined(WorkspaceV2.ID),
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionSchema.ID),
  summary: optionalOmitUndefined(SessionSummary),
  cost: optionalOmitUndefined(Schema.Finite),
  tokens: optionalOmitUndefined(SessionTokens),
  title: Schema.String,
  agent: optionalOmitUndefined(Schema.String),
  model: optionalOmitUndefined(SessionModel),
  version: Schema.String,
  metadata: optionalOmitUndefined(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
    compacting: optionalOmitUndefined(NonNegativeInt),
    archived: optionalOmitUndefined(Schema.Finite),
    processing: optionalOmitUndefined(NonNegativeInt),
  }),
  permission: optionalOmitUndefined(PermissionV1.Ruleset),
  revert: optionalOmitUndefined(SessionRevert),
}).annotate({ identifier: "Session" })
export type SessionInfo = typeof SessionInfo.Type

export const Event = {
  Created: EventV2.define({
    type: "session.created",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      info: SessionInfo,
    },
  }),
  Updated: EventV2.define({
    type: "session.updated",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      info: SessionInfo,
    },
  }),
  Deleted: EventV2.define({
    type: "session.deleted",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      info: SessionInfo,
    },
  }),
  MessageUpdated: EventV2.define({
    type: "message.updated",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      info: Info,
    },
  }),
  MessageRemoved: EventV2.define({
    type: "message.removed",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      messageID: MessageID,
    },
  }),
  PartUpdated: EventV2.define({
    type: "message.part.updated",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      part: Part,
      time: Schema.Finite,
    },
  }),
  PartRemoved: EventV2.define({
    type: "message.part.removed",
    ...options,
    schema: {
      sessionID: SessionSchema.ID,
      messageID: MessageID,
      partID: PartID,
    },
  }),
}
