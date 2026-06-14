import { expect, test } from "bun:test"

import { loadEnvOverrides } from "../../src/config/env"

test("maps supported environment overrides", () => {
  const loaded = loadEnvOverrides({
    OC2_MODEL: "anthropic/claude",
    OC2_LOG_LEVEL: "error",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    GROQ_API_KEY: "secret",
    AZURE_OPENAI_API_KEY: "secret",
    OC2_EXPERIMENTAL_DOCKER_SANDBOX: "1",
  })

  expect(loaded.overrides.model).toEqual({ provider: "anthropic", model: "claude" })
  expect(loaded.overrides.runtime).toEqual({ logLevel: "error" })
  expect(loaded.providerSecretsPresent).toEqual([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
    "AZURE_OPENAI_API_KEY",
  ])
  expect(loaded.experimentalDockerSandbox).toBe(true)
})

test("warns for invalid environment overrides", () => {
  const loaded = loadEnvOverrides({ OC2_MODEL: "missing-separator", OC2_LOG_LEVEL: "trace" })

  expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "config.env.invalid_model",
    "config.env.invalid_log_level",
  ])
})
