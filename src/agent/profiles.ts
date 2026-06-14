import type { Oc2Config } from "../config/schema"
import { mainAgentSystemPrompt } from "./prompts"

export type AgentProfileMode = "primary" | "subagent" | "all"

export interface AgentProfile {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly mode: AgentProfileMode
  readonly systemPrompt: string
  readonly defaultModel?: string
  readonly allowedTools: Oc2Config["agents"][string]["allowedTools"]
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
    mode: configured?.mode ?? "all",
    systemPrompt: configured?.systemPrompt ?? mainAgentSystemPrompt,
    defaultModel: configured?.defaultModel,
    allowedTools: configured?.allowedTools ?? [],
    maxIterations: configured?.maxIterations ?? 20,
    timeoutMs: configured?.timeoutMs,
  }
}

/** Resolves a configured agent profile for a subagent child session. */
export function resolveSubAgentProfile(config: Pick<Oc2Config, "agents">, agentId: string): AgentProfile | undefined {
  const configured = config.agents[agentId]
  if (!configured) return undefined
  const mode = configured.mode ?? "all"
  if (mode === "primary") return undefined
  return {
    id: configured.id ?? agentId,
    name: configured.name ?? agentId,
    description: configured.description ?? "Subagent profile",
    mode,
    systemPrompt: configured.systemPrompt ?? mainAgentSystemPrompt,
    defaultModel: configured.defaultModel,
    allowedTools: configured.allowedTools ?? [],
    maxIterations: configured.maxIterations ?? 20,
    timeoutMs: configured.timeoutMs,
  }
}
