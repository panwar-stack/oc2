export * as SessionCompoundConfig from "./config"

import { ConfigLocalFusion } from "@opencode-ai/core/config/local-fusion"
import { Schema } from "effect"
import { Provider } from "@/provider/provider"

export const DEFAULT_MAX_BRANCHES = 3

export const ToolPolicy = ConfigLocalFusion.ToolPolicy
export type ToolPolicy = Schema.Schema.Type<typeof ToolPolicy>

export const Branch = ConfigLocalFusion.Branch
export type Branch = Schema.Schema.Type<typeof Branch> & { toolPolicy: ToolPolicy }

export const Judge = ConfigLocalFusion.Judge
export type Judge = Schema.Schema.Type<typeof Judge>

export const Synthesizer = ConfigLocalFusion.Synthesizer
export type Synthesizer = Schema.Schema.Type<typeof Synthesizer>

export const Limits = ConfigLocalFusion.Limits
export type Limits = Schema.Schema.Type<typeof Limits> & { maxBranches: number }

export const Config = ConfigLocalFusion.Info
export type Config = Omit<Schema.Schema.Type<typeof Config>, "branches" | "judge" | "synthesizer" | "limits"> & {
  branches: Branch[]
  judge: Judge & { toolPolicy: ToolPolicy }
  synthesizer: Synthesizer & { toolPolicy: ToolPolicy }
  limits: Limits
}

export function parse(input: unknown): Config {
  const config = Schema.decodeUnknownSync(Config)(input)
  const limits = {
    ...(config.limits?.timeout ? { timeout: config.limits.timeout } : {}),
    maxBranches: config.limits?.maxBranches ?? DEFAULT_MAX_BRANCHES,
  }

  if (config.branches.length > limits.maxBranches) {
    throw new Error(`Compound config has ${config.branches.length} branches, but maxBranches is ${limits.maxBranches}`)
  }

  for (const branch of config.branches) parseModel(branch.model)
  parseModel(config.judge.model)
  parseModel(config.synthesizer.model)

  return {
    branches: config.branches.map((branch) => ({
      ...branch,
      toolPolicy: branch.toolPolicy ?? "readonly",
    })),
    judge: {
      ...config.judge,
      toolPolicy: config.judge.toolPolicy ?? "none",
    },
    synthesizer: {
      ...config.synthesizer,
      toolPolicy: config.synthesizer.toolPolicy ?? "none",
    },
    limits,
  }
}

export function parseModel(model: string) {
  validateModel(model)
  return Provider.parseModel(model)
}

function validateModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  if (!providerID || rest.join("/").length === 0) throw new Error(`Invalid model string: ${model}`)
}
