export * as SessionCompoundConfig from "./config"

import { PositiveInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { Provider } from "@/provider/provider"

export const DEFAULT_MAX_BRANCHES = 3
export const DEFAULT_TIMEOUT = 30_000

const Model = Schema.String.check(Schema.isPattern(/^[^/]+\/.+$/))

export const ToolPolicy = Schema.Literals(["readonly", "none"])
export type ToolPolicy = Schema.Schema.Type<typeof ToolPolicy>

export const Branch = Schema.Struct({
  model: Model,
  agent: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  toolPolicy: Schema.optional(ToolPolicy),
  timeout: Schema.optional(PositiveInt),
})
export type Branch = Schema.Schema.Type<typeof Branch> & { toolPolicy: ToolPolicy }

export const Judge = Schema.Struct({
  model: Model,
  prompt: Schema.optional(Schema.String),
})
export type Judge = Schema.Schema.Type<typeof Judge>

export const Synthesizer = Schema.Struct({
  model: Model,
  prompt: Schema.optional(Schema.String),
})
export type Synthesizer = Schema.Schema.Type<typeof Synthesizer>

export const Limits = Schema.Struct({
  timeout: Schema.optional(PositiveInt),
  maxBranches: Schema.optional(PositiveInt),
})
export type Limits = Required<Schema.Schema.Type<typeof Limits>>

export const Config = Schema.Struct({
  branches: Schema.Array(Branch),
  judge: Judge,
  synthesizer: Synthesizer,
  limits: Schema.optional(Limits),
})
export type Config = Omit<Schema.Schema.Type<typeof Config>, "branches" | "limits"> & {
  branches: Branch[]
  limits: Limits
}

export function parse(input: unknown): Config {
  const config = Schema.decodeUnknownSync(Config)(input)
  const limits = {
    timeout: config.limits?.timeout ?? DEFAULT_TIMEOUT,
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
    judge: config.judge,
    synthesizer: config.synthesizer,
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
