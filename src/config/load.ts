import { parse, type ParseError, printParseErrorCode } from "jsonc-parser"
import { dirname } from "node:path"

import type { Diagnostic } from "../diagnostics/diagnostics"
import { createDiagnostic } from "../diagnostics/diagnostics"
import { loadEnvOverrides } from "./env"
import { getConfigPaths, resolvePath } from "./paths"
import {
  agentProfileSchema,
  defaultConfig,
  knownConfigKeys,
  mcpServerConfigSchema,
  oc2ConfigSchema,
  toolConfigSchema,
  type LogLevel,
  type Oc2Config,
  type Oc2ConfigInput,
} from "./schema"

export interface LoadConfigOptions {
  cwd?: string
  homeDir?: string
  env?: Record<string, string | undefined>
  cliOverrides?: Oc2ConfigInput
  readFile?: (path: string) => Promise<string>
  fileExists?: (path: string) => Promise<boolean>
}

export interface LoadedConfig {
  config: Oc2Config
  diagnostics: Diagnostic[]
  files: string[]
}

type ConfigLayer = {
  path: string
  value: Oc2ConfigInput
}

const defaultReadFile = (path: string) => Bun.file(path).text()
const defaultFileExists = (path: string) => Bun.file(path).exists()

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const paths = getConfigPaths({ cwd: options.cwd, homeDir: options.homeDir, env })
  const readFile = options.readFile ?? defaultReadFile
  const fileExists = options.fileExists ?? defaultFileExists
  const diagnostics: Diagnostic[] = []
  const files: string[] = []
  const configLayers: ConfigLayer[] = []
  const candidatePaths = [paths.userConfigPath, ...paths.projectConfigPaths]

  if (paths.explicitConfigPath) {
    candidatePaths.push(paths.explicitConfigPath)
  }

  for (const path of candidatePaths) {
    if (!(await fileExists(path))) continue

    files.push(path)
    const parsed = parseConfigFile(await readFile(path), path)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.value) {
      warnUnknownKeys(parsed.value, path, diagnostics)
      configLayers.push({ path, value: parsed.value })
    }
  }

  const envOverrides = loadEnvOverrides(env)
  diagnostics.push(...envOverrides.diagnostics)
  if (envOverrides.experimentalDockerSandbox) {
    diagnostics.push(
      createDiagnostic(
        "warning",
        "config.env.docker_sandbox_deferred",
        "OC2_EXPERIMENTAL_DOCKER_SANDBOX is recognized but Docker sandboxing is deferred",
        { path: "env.OC2_EXPERIMENTAL_DOCKER_SANDBOX" },
      ),
    )
  }

  const merged = deepMerge(
    defaultConfig,
    ...configLayers.map((layer) => normalizeConfigInput(layer.value, layer.path, paths.cwd, paths.homeDir)),
    envOverrides.overrides,
    options.cliOverrides ?? {},
  )

  const validated = oc2ConfigSchema.safeParse(merged)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      diagnostics.push(
        createDiagnostic("warning", "config.invalid", issue.message, { path: issue.path.join(".") || undefined }),
      )
    }
  }

  const config = validated.success ? validated.data : repairConfig(merged)
  warnConfigState(config, diagnostics)

  return { config, diagnostics, files }
}

function parseConfigFile(source: string, path: string): { value?: Oc2ConfigInput; diagnostics: Diagnostic[] } {
  const errors: ParseError[] = []
  const value = parse(source, errors, { allowTrailingComma: true }) as unknown
  const diagnostics = errors.map((error) =>
    createDiagnostic("warning", "config.invalid_jsonc", printParseErrorCode(error.error), {
      path,
      details: { offset: error.offset, length: error.length },
    }),
  )

  if (errors.length > 0 || !isRecord(value)) {
    return { diagnostics }
  }

  return { value: value as Oc2ConfigInput, diagnostics }
}

function normalizeConfigInput(value: Oc2ConfigInput, sourcePath: string, cwd: string, homeDir: string): Oc2ConfigInput {
  const sourceDir = sourcePath.endsWith("oc2.jsonc") || sourcePath.endsWith("config.jsonc") ? dirname(sourcePath) : cwd
  const normalized = deepMerge({}, value) as Oc2ConfigInput

  for (const server of Object.values(normalized.mcp ?? {})) {
    if (server.cwd) {
      server.cwd = resolvePath(server.cwd, sourceDir, homeDir)
    }
  }

  return normalized
}

function warnUnknownKeys(value: Oc2ConfigInput, sourcePath: string, diagnostics: Diagnostic[]) {
  warnSet(value, knownConfigKeys.top, sourcePath, diagnostics)
  warnSet(value.model, knownConfigKeys.model, `${sourcePath}:model`, diagnostics)
  warnSet(value.runtime, knownConfigKeys.runtime, `${sourcePath}:runtime`, diagnostics)
  warnSet(value.tui, knownConfigKeys.tui, `${sourcePath}:tui`, diagnostics)

  for (const [name, tool] of Object.entries(value.tools ?? {})) {
    warnSet(tool, knownConfigKeys.tool, `${sourcePath}:tools.${name}`, diagnostics)
  }

  for (const [name, server] of Object.entries(value.mcp ?? {})) {
    warnSet(server, knownConfigKeys.mcp, `${sourcePath}:mcp.${name}`, diagnostics)
    warnSet(server.oauth, knownConfigKeys.mcpOauth, `${sourcePath}:mcp.${name}.oauth`, diagnostics)
  }

  for (const [name, agent] of Object.entries(value.agents ?? {})) {
    warnSet(agent, knownConfigKeys.agent, `${sourcePath}:agents.${name}`, diagnostics)
  }
}

function warnSet(
  value: unknown,
  known: Set<string>,
  path: string,
  diagnostics: Diagnostic[],
) {
  if (!isRecord(value)) return
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      diagnostics.push(createDiagnostic("warning", "config.unknown_key", `Unknown config key ${key}`, { path: `${path}.${key}` }))
    }
  }
}

function warnConfigState(config: Oc2Config, diagnostics: Diagnostic[]) {
  for (const [serverId, server] of Object.entries(config.mcp)) {
    if (!server.enabled) {
      diagnostics.push(
        createDiagnostic("warning", "config.mcp.disabled", `MCP server ${serverId} is disabled`, { path: `mcp.${serverId}` }),
      )
    }
  }
}

function repairConfig(value: unknown): Oc2Config {
  const candidate = isRecord(value) ? value : {}
  return {
    model: oc2ConfigSchema.shape.model.safeParse(candidate.model).success
      ? oc2ConfigSchema.shape.model.parse(candidate.model)
      : defaultConfig.model,
    tools: parseRecordEntries(candidate.tools, toolConfigSchema),
    mcp: parseRecordEntries(candidate.mcp, mcpServerConfigSchema),
    agents: parseRecordEntries(candidate.agents, agentProfileSchema),
    runtime: {
      maxConcurrentTools: parsePositiveIntegerField(
        candidate.runtime,
        "maxConcurrentTools",
        defaultConfig.runtime.maxConcurrentTools,
      ),
      maxConcurrentSubAgents: parsePositiveIntegerField(
        candidate.runtime,
        "maxConcurrentSubAgents",
        defaultConfig.runtime.maxConcurrentSubAgents,
      ),
      maxConcurrentTeamMembers: parsePositiveIntegerField(
        candidate.runtime,
        "maxConcurrentTeamMembers",
        defaultConfig.runtime.maxConcurrentTeamMembers,
      ),
      defaultTimeoutMs: parsePositiveIntegerField(candidate.runtime, "defaultTimeoutMs", defaultConfig.runtime.defaultTimeoutMs),
      logLevel: parseLogLevelField(candidate.runtime, "logLevel", defaultConfig.runtime.logLevel),
    },
    tui: {
      sidePanel: parseBooleanField(candidate.tui, "sidePanel", defaultConfig.tui.sidePanel),
      theme: parseOptionalField(candidate.tui, "theme", defaultConfig.tui.theme),
    },
  }
}

function parseRecordEntries<T>(
  value: unknown,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): Record<string, T> {
  if (!isRecord(value)) return {}
  const output: Record<string, T> = {}
  for (const [key, entry] of Object.entries(value)) {
    const parsed = schema.safeParse(entry)
    if (parsed.success && parsed.data !== undefined) {
      output[key] = parsed.data
    }
  }
  return output
}

function parsePositiveIntegerField(record: unknown, key: string, fallback: number): number {
  if (!isRecord(record)) return fallback
  return Number.isInteger(record[key]) && (record[key] as number) > 0 ? (record[key] as number) : fallback
}

function parseLogLevelField(record: unknown, key: string, fallback: LogLevel): LogLevel {
  if (!isRecord(record)) return fallback
  return record[key] === "debug" || record[key] === "info" || record[key] === "warn" || record[key] === "error"
    ? record[key]
    : fallback
}

function parseBooleanField(record: unknown, key: string, fallback: boolean): boolean {
  if (!isRecord(record)) return fallback
  return typeof record[key] === "boolean" ? record[key] : fallback
}

function parseOptionalField<T>(record: unknown, key: string, fallback: T): T {
  if (!isRecord(record) || !(key in record)) return fallback
  return typeof record[key] === "string" ? (record[key] as T) : fallback
}

function deepMerge<T>(base: T, ...overrides: unknown[]): T {
  let output = clone(base)

  for (const override of overrides) {
    if (!isRecord(override) || !isRecord(output)) {
      output = clone(override) as T
      continue
    }

    output = mergeRecords(output, override) as T
  }

  return output
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    output[key] = isRecord(value) && isRecord(output[key]) ? mergeRecords(output[key], value) : clone(value)
  }
  return output
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) as T
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
