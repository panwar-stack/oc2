import type { Session } from "@opencode-ai/sdk/v2"
import { isRecord } from "./record"

type LoguMetadata = {
  stage?: unknown
  index?: unknown
  model?: unknown
  variant?: unknown
}

export function isLoguChildSession(session: Session | undefined): session is Session {
  return loguMetadata(session) !== undefined
}

export function loguChildLabel(session: Session | undefined) {
  const metadata = loguMetadata(session)
  if (!session || !metadata) return undefined
  return [session.title, modelLabel(metadata)].filter((item): item is string => Boolean(item)).join(" - ")
}

export function loguPromptLabel(sessions: readonly Session[], sessionID: string) {
  const session = sessions.find((item) => item.id === sessionID)
  const label = loguChildLabel(session)
  if (label) return label
  const parent = nearestLoguAncestor(sessions, session)
  const parentLabel = loguChildLabel(parent)
  if (!session || !parentLabel) return parentLabel
  return `${session.title} - ${parentLabel}`
}

function nearestLoguAncestor(sessions: readonly Session[], session: Session | undefined): Session | undefined {
  if (!session?.parentID) return undefined
  const parent = sessions.find((item) => item.id === session.parentID)
  if (isLoguChildSession(parent)) return parent
  return nearestLoguAncestor(sessions, parent)
}

function loguMetadata(session: Session | undefined): LoguMetadata | undefined {
  const metadata = isRecord(session?.metadata) ? session.metadata : undefined
  return isRecord(metadata?.logu) ? metadata.logu : undefined
}

function modelLabel(metadata: LoguMetadata) {
  if (typeof metadata.model !== "string") return undefined
  if (typeof metadata.variant !== "string") return metadata.model
  return `${metadata.model} (${metadata.variant})`
}
