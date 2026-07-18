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

export type TeamTaskGroup = "working" | "blocked" | "needs-you" | "idle" | "completed" | "errored"

export function teamTaskGroup(
  task: Pick<TeamTask, "id" | "status" | "dependency_ids">,
  tasks: readonly TeamTask[] = [],
): TeamTaskGroup {
  const status = task.status
  if (status === "in_progress" || status === "working") return "working"
  if (status === "blocked") return "blocked"
  if (status === "needs_you" || status === "needs-you") return "needs-you"
  if (status === "completed" || status === "done") return "completed"
  if (status === "cancelled" || status === "error" || status === "failed") return "errored"
  if (
    task.dependency_ids?.some((id) => {
      const dependency = tasks.find((item) => item.id === id)
      return !dependency || (dependency.status !== "completed" && dependency.status !== "done")
    })
  )
    return "blocked"
  return "idle"
}

export function groupTeamTasks(tasks: readonly TeamTask[]) {
  return tasks.reduce<Record<TeamTaskGroup, TeamTask[]>>(
    (groups, task) => {
      groups[teamTaskGroup(task, tasks)].push(task)
      return groups
    },
    { working: [], blocked: [], "needs-you": [], idle: [], completed: [], errored: [] },
  )
}

export function teamBoardFeatureEnabled(input: { redesign: boolean; flag?: string; sessionID?: string }) {
  return input.redesign && input.flag === "true" && !!input.sessionID
}

export function rootSessionID(sessions: readonly { id: string; parentID?: string }[], sessionID: string) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const parentID = byID.get(current)?.parentID
    if (!parentID) return current
    current = parentID
  }
  return sessionID
}

export function stableAgentColor(name: string) {
  let hash = 2166136261
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 8
}
