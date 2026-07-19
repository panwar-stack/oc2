import type { TeamBoard, TeamBoardTask, TeamBoardWorker } from "@oc2-ai/sdk/v2"

export const BOARD_STATE_ORDER = ["needs_you", "errored", "working", "blocked", "idle", "completed"] as const
export type BoardState = (typeof BOARD_STATE_ORDER)[number]
export type BoardView = "session" | "board" | "tasks"

export function boardWidthTier(width: number) {
  return width >= 140 ? ("full" as const) : width >= 100 ? ("standard" as const) : ("compact" as const)
}

export function groupBoardWorkers(workers: readonly TeamBoardWorker[]) {
  return workers.reduce<Record<BoardState, TeamBoardWorker[]>>(
    (groups, worker) => {
      groups[worker.state].push(worker)
      return groups
    },
    { needs_you: [], errored: [], working: [], blocked: [], idle: [], completed: [] },
  )
}

export function visibleBoardWorkerIDs(
  groups: Record<BoardState, readonly TeamBoardWorker[]>,
  completedOpen: boolean,
) {
  return BOARD_STATE_ORDER.flatMap((state) =>
    state === "completed" && !completedOpen ? [] : groups[state].map((worker) => worker.member_id),
  )
}

export function boardWorkerFocusIDs(
  groups: Record<BoardState, readonly TeamBoardWorker[]>,
  completedOpen: boolean,
) {
  const active = BOARD_STATE_ORDER.filter((state) => state !== "completed").flatMap((state) =>
    groups[state].map((worker) => `worker:${worker.member_id}`),
  )
  if (groups.completed.length === 0) return active
  return [
    ...active,
    "completed-toggle",
    ...(completedOpen ? groups.completed.map((worker) => `worker:${worker.member_id}`) : []),
  ]
}

export function moveBoardFocus(current: number, count: number, step: -1 | 1) {
  if (count <= 0) return -1
  const index = Math.min(count - 1, Math.max(0, current))
  return (index + step + count) % count
}

export function cycleBoardView(view: BoardView, step: -1 | 1) {
  const views = ["session", "board", "tasks"] as const
  return views[(views.indexOf(view) + step + views.length) % views.length]
}

export function acceptBoardSnapshot<T>(
  current: { revision: number; generation: number; value: T } | undefined,
  next: { revision: number; generation: number; value: T },
) {
  if (!current) return next
  if (next.revision > current.revision) return next
  if (next.revision < current.revision) return current
  return next.generation > current.generation ? next : current
}

export function boardTaskState(task: TeamBoardTask, board: Pick<TeamBoard, "dependencies">): BoardState {
  if (task.status === "completed" || task.status === "cancelled") return "completed"
  if (task.status === "in_progress") return "working"
  const blocked = board.dependencies.some(
    (edge) => edge.kind === "task" && edge.from_id === task.id && !edge.satisfied,
  )
  return blocked ? "blocked" : "idle"
}

export function boardTaskGlyph(task: TeamBoardTask, board: Pick<TeamBoard, "dependencies">) {
  if (task.status === "cancelled") return "pending" as const
  const state = boardTaskState(task, board)
  if (state === "working") return "running" as const
  if (state === "completed") return "done" as const
  return "pending" as const
}

export function boardDependencyRows(board: Pick<TeamBoard, "workers" | "tasks" | "dependencies">) {
  const labels = new Map<string, string>()
  for (const worker of board.workers) {
    labels.set(worker.member_id, worker.name)
    labels.set(worker.session_id, worker.name)
  }
  for (const task of board.tasks) labels.set(task.id, task.description)
  return board.dependencies.map((edge) => ({
    id: edge.id,
    from: labels.get(edge.from_id) ?? edge.from_id,
    to: labels.get(edge.to_id) ?? edge.to_id,
    satisfied: edge.satisfied,
    label: `${labels.get(edge.from_id) ?? edge.from_id} waits on ${labels.get(edge.to_id) ?? edge.to_id}`,
  }))
}

export function boardWorkerSummary(worker: TeamBoardWorker) {
  if (worker.display_summary) return worker.display_summary
  if (worker.state === "working") return "Working assignment"
  if (worker.state === "blocked") return "Blocked"
  if (worker.state === "needs_you") return "Waiting on you"
  if (worker.state === "errored") return "Errored"
  if (worker.state === "completed") return worker.outcome?.label ?? "Completed"
  return "Idle"
}
