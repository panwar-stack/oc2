import type { TeamTask, Todo } from "@oc2-ai/sdk/v2"

export type ContextGaugeState = {
  level: "success" | "warning" | "danger"
  percent: number
  action?: "compact" | "fork"
}

export function contextGaugeState(usage: number | null | undefined): ContextGaugeState | undefined {
  if (usage === null || usage === undefined) return
  const percent = Math.min(100, Math.max(0, Math.round(usage)))
  if (percent >= 90) return { level: "danger", percent, action: "fork" }
  if (percent >= 70) return { level: "warning", percent, action: "compact" }
  return { level: "success", percent }
}

export function visibleTodos(todos: readonly Todo[], limit = 5) {
  const items = todos.slice(0, Math.max(0, limit))
  return { items, overflow: Math.max(0, todos.length - items.length) }
}

export type TeamTaskGroup = "working" | "needs-you" | "idle" | "completed" | "errored"

export function teamTaskGroup(status: string): TeamTaskGroup {
  if (status === "in_progress" || status === "working") return "working"
  if (status === "blocked" || status === "needs_you" || status === "needs-you") return "needs-you"
  if (status === "completed" || status === "done") return "completed"
  if (status === "cancelled" || status === "error" || status === "failed") return "errored"
  return "idle"
}

export function groupTeamTasks(tasks: readonly TeamTask[]) {
  return tasks.reduce<Record<TeamTaskGroup, TeamTask[]>>(
    (groups, task) => {
      groups[teamTaskGroup(task.status)].push(task)
      return groups
    },
    { working: [], "needs-you": [], idle: [], completed: [], errored: [] },
  )
}

export function stableAgentColor(name: string) {
  let hash = 2166136261
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 8
}
