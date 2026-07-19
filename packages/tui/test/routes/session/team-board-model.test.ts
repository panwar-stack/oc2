import { describe, expect, test } from "bun:test"
import type { TeamBoard, TeamBoardTask, TeamBoardWorker } from "@oc2-ai/sdk/v2"
import {
  BOARD_STATE_ORDER,
  acceptBoardSnapshot,
  boardDependencyRows,
  boardTaskGlyph,
  boardTaskState,
  boardWidthTier,
  boardWorkerFocusIDs,
  boardWorkerSummary,
  cycleBoardView,
  groupBoardWorkers,
  moveBoardFocus,
  visibleBoardWorkerIDs,
} from "../../../src/routes/session/team-board-model"

function worker(id: string, state: TeamBoardWorker["state"]): TeamBoardWorker {
  return {
    member_id: id,
    session_id: `session-${id}`,
    name: id,
    agent_type: "general",
    role: null,
    state,
    lifecycle: "task",
    work_mode: "implement",
    mutability: "unknown",
    display_summary: null,
    current_work: null,
    elapsed_ms: null,
    mailbox: { unread: 0 },
    attention: { plan: null, permissions: 0, questions: 0 },
    dependency_ids: [],
    outcome: null,
    result_persisted: false,
    time_created: 1,
    time_updated: 1,
  }
}

function task(id: string, status: TeamBoardTask["status"] = "pending"): TeamBoardTask {
  return {
    id,
    description: id,
    status,
    assignee: null,
    dependency_ids: [],
    started_at: null,
    completed_at: null,
  }
}

describe("TUI Team Board model", () => {
  test("groups by server state priority while preserving stable worker order", () => {
    const workers = [
      worker("idle-a", "idle"),
      worker("working-a", "working"),
      worker("needs-a", "needs_you"),
      worker("working-b", "working"),
      worker("done-a", "completed"),
      worker("error-a", "errored"),
      worker("blocked-a", "blocked"),
    ]
    const groups = groupBoardWorkers(workers)
    expect(BOARD_STATE_ORDER.flatMap((state) => groups[state].map((item) => item.member_id))).toEqual([
      "needs-a",
      "error-a",
      "working-a",
      "working-b",
      "blocked-a",
      "idle-a",
      "done-a",
    ])
    expect(groups.working.map((item) => item.member_id)).toEqual(["working-a", "working-b"])
  })

  test("handles 20+ workers, completed collapse, and wrapping focus", () => {
    const workers = Array.from({ length: 24 }, (_, index) =>
      worker(`worker-${index.toString().padStart(2, "0")}`, index >= 20 ? "completed" : "working"),
    )
    const groups = groupBoardWorkers(workers)
    expect(visibleBoardWorkerIDs(groups, false)).toHaveLength(20)
    expect(visibleBoardWorkerIDs(groups, true)).toHaveLength(24)
    expect(boardWorkerFocusIDs(groups, false)).toEqual([
      ...workers.slice(0, 20).map((item) => `worker:${item.member_id}`),
      "completed-toggle",
    ])
    expect(boardWorkerFocusIDs(groups, true).slice(-5)).toEqual([
      "completed-toggle",
      ...workers.slice(20).map((item) => `worker:${item.member_id}`),
    ])
    expect(moveBoardFocus(0, 24, -1)).toBe(23)
    expect(moveBoardFocus(23, 24, 1)).toBe(0)
    expect(moveBoardFocus(0, 0, 1)).toBe(-1)
  })

  test("cycles tabs and selects compact, standard, and full width tiers", () => {
    expect(cycleBoardView("session", 1)).toBe("board")
    expect(cycleBoardView("board", 1)).toBe("tasks")
    expect(cycleBoardView("session", -1)).toBe("tasks")
    expect(boardWidthTier(80)).toBe("compact")
    expect(boardWidthTier(100)).toBe("standard")
    expect(boardWidthTier(140)).toBe("full")
  })

  test("rejects stale revisions and older equal-revision requests", () => {
    const current = { revision: 4, generation: 8, value: "current" }
    expect(acceptBoardSnapshot(current, { revision: 3, generation: 9, value: "stale" })).toBe(current)
    expect(acceptBoardSnapshot(current, { revision: 4, generation: 7, value: "older" })).toBe(current)
    expect(acceptBoardSnapshot(current, { revision: 4, generation: 9, value: "newer request" }).value).toBe(
      "newer request",
    )
    expect(acceptBoardSnapshot(current, { revision: 5, generation: 1, value: "new revision" }).value).toBe(
      "new revision",
    )
  })

  test("keeps missing dependency targets readable and uses explicit task edges", () => {
    const board = {
      workers: [worker("member", "blocked")],
      tasks: [task("task")],
      dependencies: [
        {
          id: "edge",
          kind: "task" as const,
          from_id: "task",
          to_id: "missing-target",
          label: "waits_on" as const,
          satisfied: false,
        },
      ],
    }
    expect(boardDependencyRows(board)).toEqual([
      {
        id: "edge",
        from: "task",
        to: "missing-target",
        satisfied: false,
        label: "task waits on missing-target",
      },
    ])
    expect(boardTaskState(board.tasks[0], board)).toBe("blocked")
    expect(boardTaskGlyph(task("cancelled", "cancelled"), board)).toBe("pending")
    expect(boardTaskGlyph(task("completed", "completed"), board)).toBe("done")
  })

  test("uses safe projection summaries and never manufactures outcomes", () => {
    expect(boardWorkerSummary(worker("idle", "idle"))).toBe("Idle")
    const completed = worker("done", "completed")
    expect(boardWorkerSummary(completed)).toBe("Completed")
    completed.outcome = { type: "interrupted", label: "interrupted" }
    expect(boardWorkerSummary(completed)).toBe("interrupted")
    completed.display_summary = "Reviewed public task metadata"
    expect(boardWorkerSummary(completed)).toBe("Reviewed public task metadata")
  })
})
