import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
  type Setter,
} from "solid-js"
import { useSync } from "../../context/sync"
import { useTuiPaths } from "../../context/runtime"
import type { Session } from "@oc2-ai/sdk/v2"
import { Locale } from "../../util/locale"

export const HOME_ALL_SESSIONS_KEY = "ctrl+o"

export function recentHomeRootSessions(sessions: Session[]) {
  return sessions
    .filter((session) => session.parentID === undefined && session.time.archived === undefined)
    .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .slice(0, 3)
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

export function homeSessionRecency(updated: number, now = Date.now()) {
  const elapsed = Math.max(0, now - updated)
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`
  return new Date(updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function homeSessionMeta(session: Pick<Session, "agent" | "tokens" | "time">, now = Date.now()) {
  const tokens = homeSessionTokenCount(session)
  return [
    session.agent,
    tokens === undefined ? undefined : `${Locale.number(tokens)} tok`,
    homeSessionRecency(session.time.updated ?? session.time.created, now),
  ]
    .filter((value): value is string => !!value)
    .join(" · ")
}

export function nextHomeSessionCursor(current: number, delta: number, count: number) {
  if (count === 0) return 0
  return (current + delta + count) % count
}

export type HomeSessionDestination = { type: "directory"; directory: string; subdirectory: boolean } | { type: "new" }

type Context = {
  destination: Accessor<HomeSessionDestination | undefined>
  setDestination: Setter<HomeSessionDestination | undefined>
  clear: () => void
}

const HomeSessionDestinationContext = createContext<Context>()

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  const [selected, setDestination] = createSignal<HomeSessionDestination>()
  const destination = createMemo<HomeSessionDestination>(
    () => selected() ?? { type: "directory", directory: sync.path.directory || paths.cwd, subdirectory: false },
  )
  return (
    <HomeSessionDestinationContext.Provider
      value={{ destination, setDestination, clear: () => setDestination(undefined) }}
    >
      {props.children}
    </HomeSessionDestinationContext.Provider>
  )
}

export function useHomeSessionDestination() {
  return useContext(HomeSessionDestinationContext)
}
