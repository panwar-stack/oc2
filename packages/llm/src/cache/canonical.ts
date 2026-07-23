import { Buffer } from "node:buffer"
import type { CacheDuration } from "./capability"

export const CACHE_CANONICAL_SERIALIZATION_VERSION = 1

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CanonicalJson>
  | { readonly [key: string]: CanonicalJson }

export interface CacheBreakpointInput {
  readonly component: string
  readonly contentType: string
  readonly index: number
  readonly duration?: CacheDuration | null
  readonly ttlSeconds?: number | null
}

export interface CacheSystemPartInput {
  readonly type?: string
  readonly text?: string
  readonly cache?: unknown
  readonly metadata?: unknown
}

export interface CacheContentPartInput {
  readonly type?: string
  readonly [key: string]: unknown
}

export interface CacheMessageInput {
  readonly id?: string
  readonly role: string
  readonly content: ReadonlyArray<CacheContentPartInput>
  readonly metadata?: unknown
  readonly native?: unknown
}

export interface CacheToolDefinitionInput {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  readonly cache?: unknown
  readonly metadata?: unknown
  readonly native?: unknown
}

export interface CacheModelConfigInput {
  readonly provider?: string
  readonly model?: string
  readonly generation?: unknown
  readonly responseFormat?: unknown
  readonly cachePolicy?: unknown
  readonly [key: string]: unknown
}

export type CacheImageInput = CacheContentPartInput | Record<string, unknown>
export type CacheFileRefInput = Record<string, unknown>

export const canonicalSerialize = (value: unknown) => JSON.stringify(canonicalizeCacheValue(value))

export const canonicalizeCacheValue = (value: unknown): CanonicalJson => {
  if (value === null) return null
  if (value === undefined) return canonicalizeRecord({ type: "undefined" })
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : canonicalizeRecord({ type: "number", value: String(value) })
  if (typeof value === "bigint") return canonicalizeRecord({ type: "bigint", value: value.toString() })
  if (typeof value === "symbol") return canonicalizeRecord({ type: "symbol", value: value.description ?? null })
  if (typeof value === "function") return canonicalizeRecord({ type: "function", name: value.name })
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return canonicalizeRecord({
      type: "bytes",
      base64: Buffer.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).toString("base64"),
    })
  }
  if (value instanceof ArrayBuffer)
    return canonicalizeRecord({ type: "bytes", base64: Buffer.from(value).toString("base64") })
  if (value instanceof Date) return canonicalizeRecord({ type: "date", value: value.toISOString() })
  if (value instanceof URL) return canonicalizeRecord({ type: "url", value: value.href })
  if (Array.isArray(value)) return value.map((item) => canonicalizeCacheValue(item))
  if (typeof value === "object") return canonicalizeRecord(value as Record<string, unknown>)
  return canonicalizeRecord({ type: "unsupported", value: String(value) })
}

export const canonicalizeSystemParts = (system: ReadonlyArray<CacheSystemPartInput> = []) =>
  system.map((part) =>
    canonicalizeRecord({
      type: part.type,
      text: part.text,
      cache: part.cache,
      metadata: part.metadata,
    }),
  )

export const canonicalizeCacheableMessages = (messages: ReadonlyArray<CacheMessageInput> = []) =>
  messages.map((message) =>
    canonicalizeRecord({
      id: message.id,
      role: message.role,
      metadata: message.metadata,
      content: message.content.map(canonicalizeContentPart),
      native: message.native,
    }),
  )

export const canonicalizeCacheableTools = (tools: ReadonlyArray<CacheToolDefinitionInput> = []) =>
  tools.map((tool) =>
    canonicalizeRecord({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      cache: tool.cache,
      metadata: tool.metadata,
      native: tool.native,
    }),
  )

export const canonicalizeCacheableSchemas = (schemas: ReadonlyArray<unknown> = []) =>
  schemas.map((schema) => canonicalizeCacheValue(schema))

export const canonicalizeCacheableImages = (images: ReadonlyArray<CacheImageInput> = []) =>
  images.map((image) => canonicalizeCacheValue(image))

export const canonicalizeCacheableFileRefs = (fileRefs: ReadonlyArray<CacheFileRefInput> = []) =>
  fileRefs.map((fileRef) => canonicalizeCacheValue(fileRef))

export const canonicalizeProviderConfig = (providerConfig?: Record<string, unknown> | null) =>
  canonicalizeCacheValue(providerConfig ?? null)

export const canonicalizeModelConfig = (modelConfig?: CacheModelConfigInput | Record<string, unknown> | null) =>
  canonicalizeCacheValue(modelConfig ?? null)

export const canonicalizeCacheBreakpoints = (breakpoints: ReadonlyArray<CacheBreakpointInput> = []) =>
  breakpoints.map((breakpoint) =>
    canonicalizeRecord({
      component: breakpoint.component,
      contentType: breakpoint.contentType,
      index: breakpoint.index,
      duration: breakpoint.duration,
      ttlSeconds: breakpoint.ttlSeconds,
    }),
  )

const canonicalizeContentPart = (part: CacheContentPartInput) => {
  if (part.type === "text")
    return canonicalizeRecord({
      type: part.type,
      text: part.text,
      cache: part.cache,
      metadata: part.metadata,
      providerMetadata: part.providerMetadata,
    })
  if (part.type === "media")
    return canonicalizeRecord({
      type: part.type,
      mediaType: part.mediaType,
      data: part.data,
      filename: part.filename,
      metadata: part.metadata,
    })
  if (part.type === "tool-call")
    return canonicalizeRecord({
      type: part.type,
      id: part.id,
      name: part.name,
      input: part.input,
      providerExecuted: part.providerExecuted,
      metadata: part.metadata,
      providerMetadata: part.providerMetadata,
    })
  if (part.type === "tool-result")
    return canonicalizeRecord({
      type: part.type,
      id: part.id,
      name: part.name,
      result: part.result,
      providerExecuted: part.providerExecuted,
      cache: part.cache,
      metadata: part.metadata,
      providerMetadata: part.providerMetadata,
    })
  if (part.type === "file")
    return canonicalizeRecord({
      type: part.type,
      source: part.source,
      mime: part.mime,
      name: part.name,
    })
  return canonicalizeRecord({
    type: part.type,
    text: part.text,
    encrypted: part.encrypted,
    metadata: part.metadata,
    providerMetadata: part.providerMetadata,
  })
}

const canonicalizeRecord = (record: Record<string, unknown>): CanonicalJson =>
  Object.fromEntries(
    Object.entries(record)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => [key, canonicalizeCacheValue(value)]),
  )
