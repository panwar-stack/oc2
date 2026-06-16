import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { SessionCompoundConfig } from "../../src/session/compound/config"

const validConfig = {
  branches: [{ model: "anthropic/claude-sonnet-4" }, { model: "openai/gpt-5", toolPolicy: "none" }],
  judge: { model: "openai/gpt-5-mini" },
  synthesizer: { model: "anthropic/claude-sonnet-4" },
}

const accepts = (input: unknown) => Result.isSuccess(Schema.decodeUnknownResult(SessionCompoundConfig.Config)(input))

describe("compound config", () => {
  test("validates and defaults config", () => {
    expect(SessionCompoundConfig.parse(validConfig)).toEqual({
      branches: [
        { model: "anthropic/claude-sonnet-4", toolPolicy: "readonly" },
        { model: "openai/gpt-5", toolPolicy: "none" },
      ],
      judge: { model: "openai/gpt-5-mini" },
      synthesizer: { model: "anthropic/claude-sonnet-4" },
      limits: {
        maxBranches: SessionCompoundConfig.DEFAULT_MAX_BRANCHES,
      },
    })
  })

  test("preserves explicitly configured timeout", () => {
    expect(SessionCompoundConfig.parse({ ...validConfig, limits: { timeout: 120_000 } }).limits).toEqual({
      timeout: 120_000,
      maxBranches: SessionCompoundConfig.DEFAULT_MAX_BRANCHES,
    })
  })

  test("rejects missing judge", () => {
    expect(accepts({ branches: validConfig.branches, synthesizer: validConfig.synthesizer })).toBe(false)
  })

  test("rejects missing synthesizer", () => {
    expect(accepts({ branches: validConfig.branches, judge: validConfig.judge })).toBe(false)
  })

  test("rejects too many branches", () => {
    expect(() =>
      SessionCompoundConfig.parse({
        ...validConfig,
        branches: validConfig.branches,
        limits: { maxBranches: 1 },
      }),
    ).toThrow("maxBranches")
  })

  test("rejects invalid tool policy", () => {
    expect(accepts({ ...validConfig, branches: [{ model: "anthropic/claude-sonnet-4", toolPolicy: "write" }] })).toBe(
      false,
    )
  })

  test("rejects invalid model strings", () => {
    for (const model of ["anthropic", "/claude-sonnet-4", "anthropic/"]) {
      expect(accepts({ ...validConfig, branches: [{ model }] })).toBe(false)
      expect(() => SessionCompoundConfig.parseModel(model)).toThrow("Invalid model string")
    }
  })

  test("allows nested model IDs", () => {
    const parsed = SessionCompoundConfig.parseModel("openrouter/anthropic/claude-sonnet-4")

    expect(String(parsed.providerID)).toBe("openrouter")
    expect(String(parsed.modelID)).toBe("anthropic/claude-sonnet-4")
  })
})
