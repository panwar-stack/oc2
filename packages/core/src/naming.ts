export const appSlug = "oc2"
export const displayName = "OC2"

export const envPrefix = "OC2"

export const configDirs = [".oc2"] as const
export const configFiles = ["oc2.json", "oc2.jsonc"] as const
export const configFileLoadOrder = ["oc2.json", "oc2.jsonc"] as const
export const configFileSearchTargets = ["oc2.jsonc", "oc2.json"] as const
export const globalConfigFiles = ["oc2.jsonc", "oc2.json"] as const
export const globalConfigLoadOrder = ["oc2.json", "oc2.jsonc"] as const

export const configSchemaURL = "https://oc2.ai/config.json"
export const wellKnownPath = "/.well-known/oc2"

export const domains = {
  app: "oc2.ai",
} as const

export const headers = {
  directory: "x-oc2-directory",
  workspace: "x-oc2-workspace",
  sync: "x-oc2-sync",
  ticket: "x-oc2-ticket",
  project: "x-oc2-project",
  session: "x-oc2-session",
  request: "x-oc2-request",
  client: "x-oc2-client",
} as const

export function env(name: string) {
  return process.env[name]
}

export function truthyEnv(name: string) {
  const value = env(name)?.toLowerCase()
  return value === "true" || value === "1"
}

export function header(headers: Headers, name: string) {
  return headers.get(name)
}

export function recordHeader(headers: Record<string, string | undefined>, name: string) {
  return headers[name]
}

export function deleteHeaders(headers: Headers, ...names: readonly string[]) {
  for (const name of names) headers.delete(name)
}

export * as Naming from "./naming"
