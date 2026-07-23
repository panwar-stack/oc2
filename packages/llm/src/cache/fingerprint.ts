import { createHash } from "node:crypto"
import {
  CACHE_CANONICAL_SERIALIZATION_VERSION,
  canonicalSerialize,
  canonicalizeCacheBreakpoints,
  canonicalizeCacheValue,
  canonicalizeCacheableFileRefs,
  canonicalizeCacheableImages,
  canonicalizeCacheableMessages,
  canonicalizeCacheableSchemas,
  canonicalizeCacheableTools,
  canonicalizeModelConfig,
  canonicalizeProviderConfig,
  canonicalizeSystemParts,
  type CacheBreakpointInput,
  type CacheFileRefInput,
  type CacheImageInput,
  type CacheMessageInput,
  type CacheModelConfigInput,
  type CacheSystemPartInput,
  type CacheToolDefinitionInput,
  type CanonicalJson,
} from "./canonical"

export const CACHE_FINGERPRINT_ALGORITHM = "sha256"

export const cacheFingerprintComponentNames = [
  "system",
  "tools",
  "schemas",
  "images",
  "fileRefs",
  "providerConfig",
  "modelConfig",
  "breakpoints",
  "messages",
] as const

export type CacheFingerprintComponentName = (typeof cacheFingerprintComponentNames)[number]

export interface CacheStablePrefixFingerprintInput {
  readonly system?: ReadonlyArray<CacheSystemPartInput>
  readonly tools?: ReadonlyArray<CacheToolDefinitionInput>
  readonly schemas?: ReadonlyArray<unknown>
  readonly images?: ReadonlyArray<CacheImageInput>
  readonly fileRefs?: ReadonlyArray<CacheFileRefInput>
  readonly providerConfig?: Record<string, unknown> | null
  readonly modelConfig?: CacheModelConfigInput | Record<string, unknown> | null
  readonly breakpoints?: ReadonlyArray<CacheBreakpointInput>
  readonly messages?: ReadonlyArray<CacheMessageInput>
}

export interface CacheStablePrefixFingerprint {
  readonly stablePrefixFingerprint: string
  readonly componentFingerprints: Record<CacheFingerprintComponentName, string>
}

export const fingerprintCanonical = (kind: string, value: unknown) => {
  const input = canonicalSerialize({
    serializationVersion: CACHE_CANONICAL_SERIALIZATION_VERSION,
    kind,
    value: canonicalizeCacheValue(value),
  })
  return `cache:${kind}:v${CACHE_CANONICAL_SERIALIZATION_VERSION}:${CACHE_FINGERPRINT_ALGORITHM}:${sha256(input)}`
}

export const createComponentFingerprints = (input: CacheStablePrefixFingerprintInput) => {
  const components = canonicalizeStablePrefixComponents(input)
  return Object.fromEntries(
    cacheFingerprintComponentNames.map((component) => [
      component,
      fingerprintCanonical(`component:${component}`, components[component]),
    ]),
  ) as Record<CacheFingerprintComponentName, string>
}

export const fingerprintStablePrefix = (input: CacheStablePrefixFingerprintInput): CacheStablePrefixFingerprint => {
  const componentFingerprints = createComponentFingerprints(input)
  const stablePrefixFingerprint = fingerprintCanonical(
    "stable-prefix",
    cacheFingerprintComponentNames.map((component) => [component, componentFingerprints[component]]),
  )
  return { stablePrefixFingerprint, componentFingerprints }
}

export const canonicalizeStablePrefixComponents = (
  input: CacheStablePrefixFingerprintInput,
): Record<CacheFingerprintComponentName, CanonicalJson> => ({
  system: canonicalizeSystemParts(input.system),
  tools: canonicalizeCacheableTools(input.tools),
  schemas: canonicalizeCacheableSchemas(input.schemas),
  images: canonicalizeCacheableImages(input.images),
  fileRefs: canonicalizeCacheableFileRefs(input.fileRefs),
  providerConfig: canonicalizeProviderConfig(input.providerConfig),
  modelConfig: canonicalizeModelConfig(input.modelConfig),
  breakpoints: canonicalizeCacheBreakpoints(input.breakpoints),
  messages: canonicalizeCacheableMessages(input.messages),
})

const sha256 = (value: string) => createHash(CACHE_FINGERPRINT_ALGORITHM).update(value).digest("hex")
