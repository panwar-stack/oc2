export const OC2_RUN_ID = "OC2_RUN_ID"
export const OC2_PROCESS_ROLE = "OC2_PROCESS_ROLE"
export const OC2_TEAM_LEAD_URL = "OC2_TEAM_LEAD_URL"
export const OC2_TEAM_ID = "OC2_TEAM_ID"
export const OC2_TEAM_MEMBER_SESSION_ID = "OC2_TEAM_MEMBER_SESSION_ID"
export const OC2_TEAM_SECRET = "OC2_TEAM_SECRET"

export type ProcessRole = "main" | "worker" | "teammate"

export function ensureRunID() {
  return (process.env[OC2_RUN_ID] ??= crypto.randomUUID())
}

export function ensureProcessRole(fallback: ProcessRole) {
  return (process.env[OC2_PROCESS_ROLE] ??= fallback)
}

export function ensureProcessMetadata(fallback: ProcessRole) {
  return {
    runID: ensureRunID(),
    processRole: ensureProcessRole(fallback),
  }
}

export function sanitizedProcessEnv(overrides?: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return overrides ? Object.assign(env, overrides) : env
}
