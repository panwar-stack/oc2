import type { Todo } from "@oc2-ai/sdk/v2"
import { projectSessionContext } from "./session-projection"

export type ContextGaugeState = {
  level: "success" | "warning" | "danger"
  percent: number
  action?: "compact" | "fork"
}

export function contextGaugeState(usage: number | null | undefined): ContextGaugeState | undefined {
  if (usage === null || usage === undefined) return
  const projection = projectSessionContext(usage, 100)
  return { level: projection.level, percent: projection.percent!, action: projection.action }
}

export function visibleTodos(todos: readonly Todo[], limit = 5) {
  const items = todos.slice(0, Math.max(0, limit))
  return { items, overflow: Math.max(0, todos.length - items.length) }
}

export function teamBoardFeatureEnabled(input: { redesign: boolean; sessionID?: string }) {
  return input.redesign && !!input.sessionID
}

export function stableAgentColor(name: string) {
  let hash = 2166136261
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 8
}
