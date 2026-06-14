import type { Diagnostic } from "../diagnostics/diagnostics"
import { createDiagnostic } from "../diagnostics/diagnostics"
import { logLevelSchema, type Oc2ConfigInput } from "./schema"

export interface EnvOverrideResult {
  overrides: Oc2ConfigInput
  diagnostics: Diagnostic[]
  providerSecretsPresent: string[]
  experimentalDockerSandbox: boolean
}

/**
 * Converts supported OC2_* environment variables into config overrides and
 * reports invalid values without throwing during startup.
 */
export function loadEnvOverrides(env: Record<string, string | undefined> = process.env): EnvOverrideResult {
  const overrides: Oc2ConfigInput = {}
  const diagnostics: Diagnostic[] = []

  if (env.OC2_MODEL) {
    const separator = env.OC2_MODEL.indexOf("/")
    if (separator > 0 && separator < env.OC2_MODEL.length - 1) {
      overrides.model = {
        provider: env.OC2_MODEL.slice(0, separator),
        model: env.OC2_MODEL.slice(separator + 1),
      }
    } else {
      diagnostics.push(
        createDiagnostic("warning", "config.env.invalid_model", "OC2_MODEL must use provider/model format", {
          path: "env.OC2_MODEL",
        }),
      )
    }
  }

  if (env.OC2_LOG_LEVEL) {
    const parsedLogLevel = logLevelSchema.safeParse(env.OC2_LOG_LEVEL)
    if (parsedLogLevel.success) {
      overrides.runtime = { logLevel: parsedLogLevel.data }
    } else {
      diagnostics.push(
        createDiagnostic("warning", "config.env.invalid_log_level", "OC2_LOG_LEVEL must be debug, info, warn, or error", {
          path: "env.OC2_LOG_LEVEL",
        }),
      )
    }
  }

  return {
    overrides,
    diagnostics,
    providerSecretsPresent: Object.keys(env).filter(isProviderSecretEnv),
    experimentalDockerSandbox: env.OC2_EXPERIMENTAL_DOCKER_SANDBOX === "1",
  }
}

function isProviderSecretEnv(key: string): boolean {
  return (
    key === "OPENAI_API_KEY" ||
    key === "ANTHROPIC_API_KEY" ||
    key === "AZURE_OPENAI_API_KEY" ||
    key === "GROQ_API_KEY" ||
    key === "MISTRAL_API_KEY" ||
    key === "COHERE_API_KEY" ||
    key === "XAI_API_KEY" ||
    key === "DEEPSEEK_API_KEY" ||
    key === "PERPLEXITY_API_KEY" ||
    key === "GOOGLE_GENERATIVE_AI_API_KEY" ||
    key === "OPENROUTER_API_KEY" ||
    (key.startsWith("OC2_") && key.endsWith("_API_KEY"))
  )
}
