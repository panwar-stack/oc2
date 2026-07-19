import { describe, expect } from "bun:test"
import { Database } from "@oc2-ai/core/database/database"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Bus } from "@/bus"
import { TeamBoard } from "@/team/board"
import { Team } from "@/team/team"
import { TeamTaskTable } from "@/team/team.sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    Team.defaultLayer,
    TeamBoard.defaultLayer,
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("TeamBoard", () => {
  it.live("validates selectors and projects only conservative safe state", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const board = yield* TeamBoard.Service
        const info = yield* team.create({ name: "board", goal: "Project facts", leadSessionID: "ses_board_lead" })
        const worker = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_board_worker",
          name: "worker",
          agentType: "general",
          rolePrompt: "SECRET ROLE PROMPT",
          dependencyIDs: ["missing-member"],
        })
        const blocked = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_board_blocked",
          name: "blocked",
          agentType: "general",
          rolePrompt: "Blocked role",
          dependencyIDs: [worker.session_id],
        })
        const failed = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_board_failed",
          name: "failed",
          agentType: "general",
          rolePrompt: "Failed role",
          lifecycle: "daemon",
          daemonState: "error",
          daemonError: "SECRET RAW ERROR",
        })
        const done = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_board_done",
          name: "done",
          agentType: "general",
          rolePrompt: "Done role",
        })
        yield* team.updateMemberStatus(worker.id, "active", "SECRET RAW RESULT")
        yield* team.updateMemberStatus(blocked.id, "blocked")
        yield* team.updateMemberStatus(failed.id, "cancelled", { daemonState: "error" })
        yield* team.updateMemberStatus(done.id, "completed")
        const task = yield* team.createTask({
          teamID: info.id,
          description: `  Public   task\n${"x".repeat(180)}  `,
          assignee: worker.name,
          metadata: { secret: "SECRET METADATA" },
        })
        yield* team.updateTask(info.id, task.id, { status: "in_progress" })
        const message = yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [worker.session_id, info.lead_session_id],
          body: "SECRET MESSAGE BODY",
        })
        yield* team.markMessageDelivered(message.id)
        yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [blocked.session_id],
          body: "STILL PENDING",
        })

        const snapshot = yield* board.readSnapshot(info.id, info.lead_session_id)
        const memberSnapshot = yield* board.readSnapshot(info.id, worker.session_id)
        const missing = yield* board.readSnapshot("missing-team", info.lead_session_id).pipe(Effect.flip)
        const outsider = yield* board.readSnapshot(info.id, "ses_board_outsider").pipe(Effect.flip)
        const projected = snapshot.workers.find((item) => item.member_id === worker.id)!

        expect(memberSnapshot.viewer).toEqual({ session_id: worker.session_id, role: "member" })
        expect(missing._tag).toBe("TeamBoard.NotFoundError")
        expect(outsider._tag).toBe("TeamBoard.InvalidViewerError")
        expect(projected).toMatchObject({
          state: "idle",
          role: null,
          mutability: "unknown",
          current_work: { source: "task", id: task.id, started_at: expect.any(Number) },
          elapsed_ms: expect.any(Number),
          mailbox: { unread: 1 },
          attention: { plan: null, permissions: 0, questions: 0 },
          outcome: null,
          result_persisted: true,
        })
        expect(projected.display_summary?.length).toBe(160)
        expect(projected.display_summary).not.toContain("\n")
        expect(snapshot.workers.map((item) => item.member_id)).toEqual([failed.id, blocked.id, worker.id, done.id])
        expect(snapshot.counts).toMatchObject({
          workers: 4,
          working: 0,
          blocked: 1,
          idle: 1,
          done: 1,
          errored: 1,
          cancelled: 0,
          needs_you: 0,
          unread: 2,
          claimed: 1,
          total_tasks: 1,
        })
        expect(
          snapshot.counts.working +
            snapshot.counts.blocked +
            snapshot.counts.idle +
            snapshot.counts.done +
            snapshot.counts.errored +
            snapshot.counts.needs_you,
        ).toBe(snapshot.counts.workers)
        expect(snapshot.counts.cancelled).toBeLessThanOrEqual(snapshot.counts.done)
        expect(snapshot.attention_items).toEqual([])
        const encoded = JSON.stringify(snapshot)
        expect(encoded).not.toContain("SECRET ROLE PROMPT")
        expect(encoded).not.toContain("SECRET RAW ERROR")
        expect(encoded).not.toContain("SECRET RAW RESULT")
        expect(encoded).not.toContain("SECRET METADATA")
        expect(encoded).not.toContain("SECRET MESSAGE BODY")
      }),
    ),
  )

  it.live("normalizes resolved assignments and retains missing dependency edges", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const board = yield* TeamBoard.Service
        const { db } = yield* Database.Service
        const info = yield* team.create({ name: "edges", goal: "Stable edges", leadSessionID: "ses_edges_lead" })
        const first = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_edges_first",
          name: "duplicate",
          agentType: "general",
          rolePrompt: "First",
          dependencyIDs: ["missing-member"],
        })
        yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_edges_second",
          name: "duplicate",
          agentType: "general",
          rolePrompt: "Second",
        })
        const dependency = yield* team.createTask({ teamID: info.id, description: "Dependency" })
        yield* team.updateTask(info.id, dependency.id, { status: "completed" })
        const resolved = yield* team.createTask({
          teamID: info.id,
          description: "Resolved",
          assignee: first.session_id,
          dependencyIDs: [dependency.id],
        })
        const ambiguous = yield* team.createTask({
          teamID: info.id,
          description: "Ambiguous",
          assignee: "duplicate",
        })
        yield* db
          .update(TeamTaskTable)
          .set({ dependency_ids: ["missing-task"] })
          .where(eq(TeamTaskTable.id, ambiguous.id))
          .run()
          .pipe(Effect.orDie)

        const snapshot = yield* board.readSnapshot(info.id, info.lead_session_id)
        expect(snapshot.tasks.find((task) => task.id === resolved.id)?.assignee).toBe(first.id)
        expect(snapshot.tasks.find((task) => task.id === ambiguous.id)?.assignee).toBeNull()
        expect(snapshot.counts.claimed).toBe(1)
        expect(snapshot.dependencies).toContainEqual(
          expect.objectContaining({
            kind: "member",
            from_id: first.id,
            to_id: "missing-member",
            satisfied: false,
          }),
        )
        expect(snapshot.dependencies).toContainEqual(
          expect.objectContaining({
            kind: "task",
            from_id: resolved.id,
            to_id: dependency.id,
            satisfied: true,
          }),
        )
        expect(snapshot.dependencies).toContainEqual(
          expect.objectContaining({
            kind: "task",
            from_id: ambiguous.id,
            to_id: "missing-task",
            satisfied: false,
          }),
        )
      }),
    ),
  )

  it.live("keeps deterministic ordering and exact groups for more than twenty workers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const board = yield* TeamBoard.Service
        const info = yield* team.create({ name: "large-board", goal: "Stable roster", leadSessionID: "ses_large_lead" })
        const members = yield* Effect.forEach(Array.from({ length: 21 }, (_, index) => index), (index) =>
          Effect.gen(function* () {
            const kind = index % 4
            const member = yield* team.addMember({
              teamID: info.id,
              sessionID: `ses_large_${index}`,
              name: `worker-${String(index).padStart(2, "0")}`,
              agentType: "general",
              rolePrompt: `Worker ${index}`,
              ...(kind === 0 ? { lifecycle: "daemon" as const, daemonState: "error" as const } : {}),
            })
            const state: "errored" | "blocked" | "completed" | "idle" =
              kind === 0 ? "errored" : kind === 1 ? "blocked" : kind === 2 ? "completed" : "idle"
            if (kind === 1) yield* team.updateMemberStatus(member.id, "blocked")
            if (kind === 2) yield* team.updateMemberStatus(member.id, "completed")
            if (kind === 3) yield* team.updateMemberStatus(member.id, "active")
            return { member, state }
          }),
        )
        const priority = { errored: 1, blocked: 3, idle: 4, completed: 5 }
        const expected = members
          .toSorted(
            (a, b) =>
              priority[a.state] - priority[b.state] ||
              a.member.time_created - b.member.time_created ||
              a.member.id.localeCompare(b.member.id),
          )
          .map((item) => item.member.id)

        const first = yield* board.readSnapshot(info.id, info.lead_session_id)
        const second = yield* board.readSnapshot(info.id, info.lead_session_id)
        expect(first.workers.map((worker) => worker.member_id)).toEqual(expected)
        expect(second.workers.map((worker) => worker.member_id)).toEqual(expected)
        expect(first.counts).toMatchObject({ workers: 21, errored: 6, blocked: 5, idle: 5, done: 5 })
        expect(
          first.counts.working +
            first.counts.blocked +
            first.counts.idle +
            first.counts.done +
            first.counts.errored +
            first.counts.needs_you,
        ).toBe(first.counts.workers)
      }),
    ),
  )
})
