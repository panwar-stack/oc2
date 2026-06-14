import type { Oc2Config } from "../config/schema"
import { mainAgentSystemPrompt } from "./prompts"

export interface AgentProfile {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly systemPrompt: string
  readonly defaultModel?: string
  readonly maxIterations: number
  readonly timeoutMs?: number
}

/** Resolves a configured profile over the built-in main agent defaults. */
export function resolveMainAgentProfile(config: Pick<Oc2Config, "agents">): AgentProfile {
  const configured = config.agents.main
  return {
    id: configured?.id ?? "main",
    name: configured?.name ?? "Main Agent",
    description: configured?.description ?? "Primary one-shot coding agent",
    systemPrompt: configured?.systemPrompt ?? mainAgentSystemPrompt,
    defaultModel: configured?.defaultModel,
    maxIterations: configured?.maxIterations ?? 20,
    timeoutMs: configured?.timeoutMs,
  }
}
