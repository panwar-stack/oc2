export const appSlug = "oc2"
export const legacyAppSlug = "opencode"
export const displayName = "OC2"
export const legacyDisplayName = "OpenCode"

export const envPrefix = "OC2"
export const legacyEnvPrefix = "OPENCODE"

export const configDirs = [".oc2", ".opencode"] as const
export const configFiles = ["oc2.json", "oc2.jsonc", "opencode.json", "opencode.jsonc"] as const
export const configFileLoadOrder = ["opencode.json", "opencode.jsonc", "oc2.json", "oc2.jsonc"] as const
export const configFileSearchTargets = ["oc2.jsonc", "oc2.json", "opencode.jsonc", "opencode.json"] as const
export const globalConfigFiles = ["oc2.jsonc", "oc2.json", "opencode.jsonc", "opencode.json", "config.json"] as const
export const globalConfigLoadOrder = ["config.json", "opencode.json", "opencode.jsonc", "oc2.json", "oc2.jsonc"] as const

export const configSchemaURL = "https://opencode.ai/config.json"
export const wellKnownPath = "/.well-known/oc2"
export const legacyWellKnownPath = "/.well-known/opencode"

export const domains = {
  app: "oc2.ai",
  legacyApp: "opencode.ai",
} as const

export const headers = {
  directory: ["x-oc2-directory", "x-opencode-directory"],
  workspace: ["x-oc2-workspace", "x-opencode-workspace"],
  sync: ["x-oc2-sync", "x-opencode-sync"],
  ticket: ["x-oc2-ticket", "x-opencode-ticket"],
  project: ["x-oc2-project", "x-opencode-project"],
  session: ["x-oc2-session", "x-opencode-session"],
  request: ["x-oc2-request", "x-opencode-request"],
  client: ["x-oc2-client", "x-opencode-client"],
} as const

export function canonicalEnv(name: string) {
  if (!name.startsWith(`${legacyEnvPrefix}_`)) return name
  return `${envPrefix}_${name.slice(legacyEnvPrefix.length + 1)}`
}

export function env(name: string) {
  const canonical = canonicalEnv(name)
  if (canonical === name) return process.env[name]
  return process.env[canonical] ?? process.env[name]
}

export function truthyEnv(name: string) {
  const value = env(name)?.toLowerCase()
  return value === "true" || value === "1"
}

export function header(headers: Headers, names: readonly [string, string]) {
  return headers.get(names[0]) ?? headers.get(names[1])
}

export function recordHeader(headers: Record<string, string | undefined>, names: readonly [string, string]) {
  return headers[names[0]] ?? headers[names[1]]
}

export function deleteHeaders(headers: Headers, names: readonly string[]) {
  for (const name of names) headers.delete(name)
}

export * as Naming from "./naming"
