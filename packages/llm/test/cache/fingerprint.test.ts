import { describe, expect, test } from "bun:test"
import {
  CACHE_CANONICAL_SERIALIZATION_VERSION,
  canonicalSerialize,
  canonicalizeCacheValue,
} from "@oc2-ai/llm/cache/canonical"
import {
  CACHE_FINGERPRINT_ALGORITHM,
  cacheFingerprintComponentNames,
  createComponentFingerprints,
  fingerprintCanonical,
  fingerprintStablePrefix,
} from "@oc2-ai/llm/cache/fingerprint"

const fingerprintPattern = (kind: string) =>
  new RegExp(`^cache:${kind}:v${CACHE_CANONICAL_SERIALIZATION_VERSION}:${CACHE_FINGERPRINT_ALGORITHM}:[0-9a-f]{64}$`)

describe("cache fingerprints", () => {
  test("creates deterministic content-free SHA-256 fingerprints", () => {
    const fingerprint = fingerprintCanonical("fixture", { prompt: "secret prompt content", schema: { b: 1, a: 2 } })

    expect(fingerprint).toMatch(fingerprintPattern("fixture"))
    expect(fingerprint).toBe(fingerprintCanonical("fixture", { schema: { a: 2, b: 1 }, prompt: "secret prompt content" }))
    expect(fingerprint).not.toContain("secret")
    expect(fingerprint).not.toContain("prompt content")
  })

  test("includes serialization version in fingerprint input", () => {
    const versionedInput = canonicalSerialize({
      serializationVersion: CACHE_CANONICAL_SERIALIZATION_VERSION,
      kind: "fixture",
      value: canonicalizeCacheValue({ value: "stable" }),
    })

    expect(fingerprintCanonical("fixture", { value: "stable" })).toBe(
      `cache:fixture:v1:sha256:${new Bun.CryptoHasher("sha256").update(versionedInput).digest("hex")}`,
    )
  })

  test("returns complete component fingerprints and stable-prefix fingerprint", () => {
    const tool = {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }
    const result = fingerprintStablePrefix({
      system: [{ type: "text", text: "You are concise" }],
      tools: [tool],
      schemas: [{ type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } }],
      images: [{ type: "media", mediaType: "image/png", data: new Uint8Array([4, 5, 6]) }],
      fileRefs: [{ type: "file", source: { type: "file", uri: "file:///repo/a.ts" }, mime: "text/typescript" }],
      providerConfig: { openai: { store: false } },
      modelConfig: { provider: "openai", model: "gpt-5", generation: { temperature: 0 } },
      breakpoints: [{ component: "system", contentType: "system", index: 0 }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })

    expect(Object.keys(result.componentFingerprints)).toEqual([...cacheFingerprintComponentNames])
    for (const component of cacheFingerprintComponentNames) {
      expect(result.componentFingerprints[component]).toMatch(fingerprintPattern(`component:${component}`))
    }
    expect(result.stablePrefixFingerprint).toMatch(fingerprintPattern("stable-prefix"))
  })

  test("component fingerprints isolate changes", () => {
    const base = createComponentFingerprints({
      system: [{ type: "text", text: "stable system" }],
      messages: [{ role: "user", content: [{ type: "text", text: "first turn" }] }],
      modelConfig: { provider: "anthropic", model: "claude-sonnet-4-5" },
    })
    const changedMessage = createComponentFingerprints({
      system: [{ type: "text", text: "stable system" }],
      messages: [{ role: "user", content: [{ type: "text", text: "second turn" }] }],
      modelConfig: { provider: "anthropic", model: "claude-sonnet-4-5" },
    })

    expect(changedMessage.system).toBe(base.system)
    expect(changedMessage.modelConfig).toBe(base.modelConfig)
    expect(changedMessage.messages).not.toBe(base.messages)
  })

  test("stable-prefix fingerprint changes when a component fingerprint changes", () => {
    const base = fingerprintStablePrefix({ messages: [{ role: "user", content: [{ type: "text", text: "same" }] }], breakpoints: [] })
    const changed = fingerprintStablePrefix({
      messages: [{ role: "user", content: [{ type: "text", text: "different" }] }],
      breakpoints: [],
    })

    expect(changed.componentFingerprints.breakpoints).toBe(base.componentFingerprints.breakpoints)
    expect(changed.componentFingerprints.messages).not.toBe(base.componentFingerprints.messages)
    expect(changed.stablePrefixFingerprint).not.toBe(base.stablePrefixFingerprint)
  })
})
