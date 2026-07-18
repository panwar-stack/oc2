import type { Session } from "@oc2-ai/sdk/v2/client"

const HOME_RECENT_LIMIT = 3

export const HOME_ALL_SESSIONS_KEYBIND = "ctrl+o"

export function recentHomeSessions<T extends { session: Pick<Session, "id" | "time"> }>(records: T[]) {
  return records
    .toSorted(
      (a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created),
    )
    .slice(0, HOME_RECENT_LIMIT)
}

export function homeSessionTokenCount(session: Pick<Session, "tokens">) {
  if (!session.tokens) return
  return (
    session.tokens.input +
    session.tokens.output +
    session.tokens.reasoning +
    session.tokens.cache.read +
    session.tokens.cache.write
  )
}

export function nextHomeSessionCursor(current: number, delta: number, count: number) {
  if (count === 0) return 0
  return (current + delta + count) % count
}
