import { describe, expect } from "bun:test"
import { Database } from "@oc2-ai/core/database/database"
import { Bus } from "@/bus"
import { TeamAttention } from "@/team/attention"
import { TeamBoard } from "@/team/board"
import { TeamLease } from "@/team/lease"
import { TeamPlanReview } from "@/team/plan-review"
import { Team } from "@/team/team"
import { TeamBoardOutboxTable, TeamMessageRecipientTable } from "@/team/team.sql"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { asc, eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    Team.defaultLayer,
    TeamAttention.defaultLayer,
    TeamPlanReview.defaultLayer,
    TeamLease.defaultLayer,
    TeamBoard.defaultLayer,
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("Team Board durability", () => {
  it.live("records one revision per real mutation and none for exact retries", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const team = yield* Team.Service
        const info = yield* team.create({ name: "ledger", goal: "Atomic mutations", leadSessionID: "ses_ledger_lead" })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_ledger_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Work",
        })
        yield* team.updateMemberStatus(member.id, "active")
        yield* team.updateMemberStatus(member.id, "active")
        const task = yield* team.createTask({ teamID: info.id, description: "Task" })
        yield* team.updateTask(info.id, task.id, { status: "in_progress" })
        yield* team.updateTask(info.id, task.id, { status: "in_progress" })
        const message = yield* team.sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [member.session_id],
          body: "Hello",
        })
        const recipient = yield* db
          .select()
          .from(TeamMessageRecipientTable)
          .where(eq(TeamMessageRecipientTable.message_id, message.id))
          .get()
          .pipe(Effect.orDie)
        expect(recipient).toBeDefined()
        if (!recipient) return
        expect(yield* team.commitRecipientDelivery(recipient.id)).toBe(true)
        expect(yield* team.commitRecipientDelivery(recipient.id)).toBe(false)

        const stored = yield* team.get(info.id)
        const outbox = yield* db
          .select()
          .from(TeamBoardOutboxTable)
          .where(eq(TeamBoardOutboxTable.team_id, info.id))
          .orderBy(asc(TeamBoardOutboxTable.revision))
          .all()
          .pipe(Effect.orDie)
        expect(stored._tag === "Some" ? stored.value.board_revision : -1).toBe(7)
        expect(outbox.map((row) => row.revision)).toEqual([1, 2, 3, 4, 5, 6, 7])
      }),
    ),
  )

  it.live("makes plan submission and decisions retry-safe with conflicts and resubmission", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const reviews = yield* TeamPlanReview.Service
        const info = yield* team.create({ name: "plans", goal: "Review", leadSessionID: "ses_plan_lead" })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_plan_member",
          name: "planner",
          agentType: "general",
          rolePrompt: "Plan",
          planMode: true,
          workMode: "plan",
        })
        const submitted = yield* reviews.submit({
          reviewID: "review-1",
          memberSessionID: member.session_id,
          planBody: "First plan",
        })
        const retried = yield* reviews.submit({
          reviewID: "review-1",
          memberSessionID: member.session_id,
          planBody: "First plan",
        })
        expect(submitted.changed).toBe(true)
        expect(retried).toMatchObject({ changed: false, currentRevision: submitted.currentRevision })
        const rejected = yield* reviews.decide({
          teamID: info.id,
          reviewID: "review-1",
          viewerSessionID: info.lead_session_id,
          decision: "reject",
          expectedRevision: submitted.currentRevision,
        })
        const exact = yield* reviews.decide({
          teamID: info.id,
          reviewID: "review-1",
          viewerSessionID: info.lead_session_id,
          decision: "reject",
          expectedRevision: submitted.currentRevision,
        })
        expect(rejected.changed).toBe(true)
        expect(exact).toMatchObject({ changed: false, currentRevision: rejected.currentRevision })
        const conflict = yield* reviews
          .decide({
            teamID: info.id,
            reviewID: "review-1",
            viewerSessionID: info.lead_session_id,
            decision: "approve",
            expectedRevision: rejected.currentRevision,
          })
          .pipe(Effect.flip)
        expect(conflict._tag).toBe("TeamPlanReview.StateConflictError")
        const resubmitted = yield* reviews.submit({
          reviewID: "review-2",
          memberSessionID: member.session_id,
          planBody: "Revised plan",
        })
        expect(resubmitted.changed).toBe(true)
      }),
    ),
  )

  it.live("persists attention lifecycle and reconciles stale runtime requests", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const attention = yield* TeamAttention.Service
        const info = yield* team.create({ name: "attention", goal: "Mirror", leadSessionID: "ses_attn_lead" })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_attn_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Ask",
        })
        const first = yield* attention.open({
          sessionID: member.session_id,
          kind: "permission",
          detailID: "permission-1",
          detail: { permission: "bash" },
        })
        const retry = yield* attention.open({
          sessionID: member.session_id,
          kind: "permission",
          detailID: "permission-1",
          detail: { permission: "bash" },
        })
        expect(retry?.id).toBe(first?.id)
        expect(yield* attention.resolve("permission", "permission-1", "once")).toBe(true)
        expect(yield* attention.resolve("permission", "permission-1", "once")).toBe(false)
        const stale = yield* attention.open({
          sessionID: member.session_id,
          kind: "question",
          detailID: "question-1",
          detail: { question: "Continue?" },
        })
        expect(yield* attention.reconcile("question", new Set())).toBe(1)
        const stored = stale ? yield* attention.get(info.id, stale.id) : undefined
        expect(stored).toMatchObject({ state: "cancelled", resolution: "runtime_restarted" })
      }),
    ),
  )

  it.live("reconciles ownerless leases to interrupted without retrying work", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const leases = yield* TeamLease.Service
        const board = yield* TeamBoard.Service
        const info = yield* team.create({ name: "leases", goal: "Recover", leadSessionID: "ses_lease_lead" })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_lease_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Run",
        })
        yield* leases.registerOwner("owner-1")
        const lease = yield* leases.begin({ memberID: member.id, ownerID: "owner-1" })
        expect(lease).toBeDefined()
        expect((yield* board.readSnapshot(info.id, info.lead_session_id)).workers[0]?.state).toBe("working")
        yield* leases.unregisterOwner("owner-1")
        expect(yield* leases.reconcile()).toBe(1)
        expect(yield* leases.reconcile()).toBe(0)
        expect((yield* board.readSnapshot(info.id, info.lead_session_id)).workers[0]).toMatchObject({
          state: "completed",
          outcome: { type: "interrupted", label: "interrupted" },
        })
      }),
    ),
  )

  it.live("paginates a recipient mailbox and short-circuits repeated reads before revision CAS", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const team = yield* Team.Service
        const board = yield* TeamBoard.Service
        const info = yield* team.create({ name: "mailbox", goal: "Page", leadSessionID: "ses_mail_lead" })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: "ses_mail_member",
          name: "worker",
          agentType: "general",
          rolePrompt: "Read",
        })
        const messages = yield* Effect.forEach(["one", "two", "three"], (body) =>
          team.sendMessage({
            teamID: info.id,
            sender: member.session_id,
            recipients: [info.lead_session_id],
            body,
          }),
        )
        for (const message of messages) yield* team.markMessageDelivered(message.id, info.lead_session_id)
        const first = yield* board.readMailbox({ teamID: info.id, viewerSessionID: info.lead_session_id, limit: 2 })
        const second = yield* board.readMailbox({
          teamID: info.id,
          viewerSessionID: info.lead_session_id,
          limit: 2,
          cursor: first.next_cursor ?? undefined,
        })
        expect(first.items).toHaveLength(2)
        expect(second.items).toHaveLength(1)
        expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3)
        expect(
          (yield* board.readMailbox({ teamID: info.id, viewerSessionID: member.session_id })).items,
        ).toEqual([])
        const read = yield* board.markMessagesRead({
          teamID: info.id,
          viewerSessionID: info.lead_session_id,
          messageIDs: [first.items[0]?.id ?? ""],
          expectedRevision: first.revision,
        })
        const retry = yield* board.markMessagesRead({
          teamID: info.id,
          viewerSessionID: info.lead_session_id,
          messageIDs: [first.items[0]?.id ?? ""],
          expectedRevision: first.revision,
        })
        expect(read.changed).toBe(true)
        expect(retry).toMatchObject({ changed: false, revision: read.revision })
      }),
    ),
  )
})
