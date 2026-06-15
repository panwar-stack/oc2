import { z } from "zod"

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"])

export const toolPermissionRuleSchema = z.object({
  match: z.string().optional(),
  decision: z.enum(["allow", "deny", "ask"]).optional(),
})

export const toolConfigSchema = z.object({
  enabled: z.boolean(),
  permissions: z.array(toolPermissionRuleSchema).optional(),
})

export const agentProfileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).default("all"),
  systemPrompt: z.string().optional(),
  defaultModel: z.string().optional(),
  allowedTools: z.array(toolPermissionRuleSchema).default([]),
  maxIterations: z.number().int().positive().default(20),
  timeoutMs: z.number().int().positive().optional(),
})

export const commandConfigSchema = z.object({
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  template: z.string().optional(),
  subtask: z.boolean().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
})

export const mcpServerConfigSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    enabled: z.boolean().default(true),
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    oauth: z
      .object({
        clientId: z.string().optional(),
        clientSecretEnv: z.string().optional(),
        redirectUri: z.string().optional(),
        callbackPort: z.number().int().positive().optional(),
        enabled: z.boolean().default(false),
        scopes: z.array(z.string()).default([]),
      })
      .optional(),
    toolPermissions: z.array(toolPermissionRuleSchema).default([]),
    startupTimeoutMs: z.number().int().positive().default(10_000),
  })
  .superRefine((value, context) => {
    if (value.transport === "stdio" && !value.command) {
      context.addIssue({ code: "custom", path: ["command"], message: "stdio MCP servers require command" })
    }

    if ((value.transport === "http" || value.transport === "sse") && !value.url) {
      context.addIssue({ code: "custom", path: ["url"], message: `${value.transport} MCP servers require url` })
    }
  })

export const oc2ConfigSchema = z.object({
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
  tools: z.record(z.string(), toolConfigSchema),
  mcp: z.record(z.string(), mcpServerConfigSchema),
  agents: z.record(z.string(), agentProfileSchema),
  commands: z.record(z.string(), commandConfigSchema).default({}),
  runtime: z.object({
    maxConcurrentTools: z.number().int().positive(),
    maxConcurrentSubAgents: z.number().int().positive(),
    maxConcurrentTeamMembers: z.number().int().positive(),
    defaultTimeoutMs: z.number().int().positive(),
    logLevel: logLevelSchema,
  }),
  tui: z.object({
    sidePanel: z.boolean(),
    theme: z.string().optional(),
  }),
})

export type LogLevel = z.infer<typeof logLevelSchema>
export type Oc2Config = z.infer<typeof oc2ConfigSchema>
export type Oc2ConfigInput = Partial<{
  model: Partial<Oc2Config["model"]>
  tools: Record<string, Partial<Oc2Config["tools"][string]>>
  mcp: Record<string, Partial<Oc2Config["mcp"][string]>>
  agents: Record<string, Partial<Oc2Config["agents"][string]>>
  commands: Record<string, Partial<Oc2Config["commands"][string]>>
  runtime: Partial<Oc2Config["runtime"]>
  tui: Partial<Oc2Config["tui"]>
}>

export const defaultConfig: Oc2Config = {
  model: {
    provider: "fake",
    model: "test",
  },
  tools: {},
  mcp: {},
  agents: {},
  commands: {},
  runtime: {
    maxConcurrentTools: 4,
    maxConcurrentSubAgents: 2,
    maxConcurrentTeamMembers: 4,
    defaultTimeoutMs: 120_000,
    logLevel: "info",
  },
  tui: {
    sidePanel: true,
  },
}

/** Known top-level and nested config keys used to warn about misspellings. */
export const knownConfigKeys = {
  top: new Set(["model", "tools", "mcp", "agents", "commands", "runtime", "tui"]),
  model: new Set(["provider", "model"]),
  tool: new Set(["enabled", "permissions"]),
  mcp: new Set([
    "id",
    "name",
    "enabled",
    "transport",
    "command",
    "args",
    "cwd",
    "env",
    "url",
    "headers",
    "oauth",
    "toolPermissions",
    "startupTimeoutMs",
  ]),
  mcpOauth: new Set(["clientId", "clientSecretEnv", "redirectUri", "callbackPort", "enabled", "scopes"]),
  agent: new Set([
    "id",
    "name",
    "description",
    "mode",
    "systemPrompt",
    "defaultModel",
    "allowedTools",
    "maxIterations",
    "timeoutMs",
  ]),
  command: new Set(["description", "aliases", "template", "subtask", "agent", "model"]),
  runtime: new Set([
    "maxConcurrentTools",
    "maxConcurrentSubAgents",
    "maxConcurrentTeamMembers",
    "defaultTimeoutMs",
    "logLevel",
  ]),
  tui: new Set(["sidePanel", "theme"]),
}
