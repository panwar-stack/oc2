import { afterEach, describe, expect } from "bun:test"
import { Database } from "@oc2-ai/core/database/database"
import { Team } from "@/team/team"
import { TeamRemote } from "@/team/remote"
import { TeamTable, TeamMessageTable, TeamMessageRecipientTable } from "@/team/team.sql"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

// ---------------------------------------------------------------------------
// Harness
//
// The member's Team.Service is TeamRemote.remoteLayer, which talks over the
// Effect HttpClient to the lead control-plane HTTP surface. Requests are
// routed to Server.Default().app in-process (the shared memoMap-backed
// runtime httpapi-team.test.ts uses) by overriding the FetchHttpClient.Fetch
// reference with a fetch shim. Local seeding of team rows uses the same shared
// Team + Database layers, so seeding and the remote client observe one
// database.
//
// Not covered here: the paused-session claim path (a remote claim on a paused
// session maps to Runner.Suspended). Arranging that requires pausing a session
// through the pause lifecycle, which this test layer does not provide; the
// mapping itself is a single branch in TeamRemote.claimPendingMessages that the
// existing paused-session suites exercise on the local service.
// ---------------------------------------------------------------------------

async function controlPlaneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = input instanceof Request ? input : new Request(input, init)
  const url = new URL(source.url)
  const request = new Request(new URL(`${url.pathname}${url.search}`, "http://localhost"), source)
  return Server.Default().app.fetch(request)
}

const it = testEffectShared(
  Layer.mergeAll(
    Team.defaultLayer,
    Database.defaultLayer,
    Layer.succeed(FetchHttpClient.Fetch, controlPlaneFetch as typeof globalThis.fetch),
    FetchHttpClient.layer,
  ),
)

type MemberConfig = {
  teamID: string
  memberSessionID: string
  directory: string
}

function remoteTeam(config: MemberConfig) {
  const full: TeamRemote.Info = {
    leadURL: "http://control-plane",
    secret: "test",
    ...config,
  }
  return Team.Service.pipe(
    Effect.provide(
      TeamRemote.remoteLayer.pipe(
        Layer.provide(TeamRemote.Config.layer(full)),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
  )
}

const readRevision = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ revision: TeamTable.revision })
    .from(TeamTable)
    .where(eq(TeamTable.id, teamID))
    .get()
    .pipe(Effect.orDie)
  return row?.revision ?? -1
})

const countMessages = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ id: TeamMessageTable.id })
    .from(TeamMessageTable)
    .where(eq(TeamMessageTable.team_id, teamID))
    .all()
    .pipe(Effect.orDie)
  return rows.length
})

afterEach(async () => {
  await resetDatabase()
})

describe("TeamRemote over in-process control-plane HTTP", () => {
  it.instance("reads members, tasks, and messages matching the locally seeded rows", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const local = yield* Team.Service
      const info = yield* local.create({
        name: "remote-read",
        goal: "Read over HTTP",
        leadSessionID: "ses_remote_read_lead",
      })
      const worker = yield* local.addMember({
        teamID: info.id,
        sessionID: "ses_remote_read_worker",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* local.updateMemberStatus(worker.id, "active")
      const task = yield* local.createTask({ teamID: info.id, description: "Remote read task" })
      const message = yield* local.sendMessage({
        teamID: info.id,
        sender: info.lead_session_id,
        recipients: [worker.session_id],
        body: "hello from lead",
      })

      const remote = yield* remoteTeam({
        teamID: info.id,
        memberSessionID: worker.session_id,
        directory: test.directory,
      })

      const members = yield* remote.getMembers(info.id)
      const tasks = yield* remote.getTasks(info.id)
      const messages = yield* remote.getMessages(info.id)

      expect(members).toHaveLength(1)
      expect(members[0]).toMatchObject({
        id: worker.id,
        session_id: worker.session_id,
        name: worker.name,
        status: "active",
      })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ id: task.id, description: task.description, status: "pending" })
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: message.id,
        sender: info.lead_session_id,
        recipients: [worker.session_id],
        body: "hello from lead",
        delivery_status: "pending",
      })
    }),
  )

  it.instance("persists exactly one message row and one revision bump on remote send", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const local = yield* Team.Service
      const info = yield* local.create({
        name: "remote-send",
        goal: "Send over HTTP",
        leadSessionID: "ses_remote_send_lead",
      })
      const worker = yield* local.addMember({
        teamID: info.id,
        sessionID: "ses_remote_send_worker",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* local.updateMemberStatus(worker.id, "active")

      const remote = yield* remoteTeam({
        teamID: info.id,
        memberSessionID: worker.session_id,
        directory: test.directory,
      })

      const revisionBefore = yield* readRevision(info.id)
      const countBefore = yield* countMessages(info.id)
      const sent = yield* remote.sendMessage({
        teamID: info.id,
        sender: worker.session_id,
        recipients: [info.lead_session_id],
        body: "progress update",
      })
      const revisionAfter = yield* readRevision(info.id)
      const countAfter = yield* countMessages(info.id)

      expect(sent).toMatchObject({
        team_id: info.id,
        sender: worker.session_id,
        body: "progress update",
        delivery_status: "pending",
      })
      expect(countAfter).toBe(countBefore + 1)
      expect(revisionAfter).toBe(revisionBefore + 1)
    }),
  )

  it.instance("claims each mailbox message exactly once with no revision bump on claim or ack", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const local = yield* Team.Service
      const info = yield* local.create({
        name: "remote-claim",
        goal: "Claim once",
        leadSessionID: "ses_remote_claim_lead",
      })
      const worker = yield* local.addMember({
        teamID: info.id,
        sessionID: "ses_remote_claim_worker",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* local.updateMemberStatus(worker.id, "active")

      const remote = yield* remoteTeam({
        teamID: info.id,
        memberSessionID: worker.session_id,
        directory: test.directory,
      })

      // The lead seeds two mailbox messages for the worker through the LOCAL
      // service; the remote member then claims them over HTTP. This mirrors the
      // member flow (a member process cannot impersonate the lead on the wire:
      // the control-plane send endpoint records the caller session as sender).
      yield* local.sendMessage({
        teamID: info.id,
        sender: info.lead_session_id,
        recipients: [worker.session_id],
        body: "first",
      })
      yield* local.sendMessage({
        teamID: info.id,
        sender: info.lead_session_id,
        recipients: [worker.session_id],
        body: "second",
      })

      const revisionBeforeClaim = yield* readRevision(info.id)
      const first = yield* remote.claimPendingMessages(worker.session_id, info.id)
      const second = yield* remote.claimPendingMessages(worker.session_id, info.id)
      const revisionAfterClaim = yield* readRevision(info.id)

      expect(first.map((message) => message.body).sort()).toEqual(["first", "second"])
      expect(second).toEqual([])
      expect(revisionAfterClaim).toBe(revisionBeforeClaim)

      // The claim moves the per-recipient rows to "read". The message-row
      // delivery_status stays "pending" until every recipient acks, so assert
      // the recipient-level durable state rather than the wire message field.
      const { db } = yield* Database.Service
      const recipients = yield* db
        .select({ delivery_status: TeamMessageRecipientTable.delivery_status })
        .from(TeamMessageRecipientTable)
        .where(eq(TeamMessageRecipientTable.team_id, info.id))
        .all()
        .pipe(Effect.orDie)
      expect(recipients.every((row) => row.delivery_status === "read")).toBe(true)

      yield* Effect.forEach(first, (message) => remote.markMessageDelivered(message.id, worker.session_id), {
        concurrency: "unbounded",
        discard: true,
      })
      const revisionAfterAck = yield* readRevision(info.id)
      expect(revisionAfterAck).toBe(revisionBeforeClaim)

      // After every recipient acks, the message rows flip to delivered too.
      const stored = yield* db
        .select({ delivery_status: TeamMessageTable.delivery_status })
        .from(TeamMessageTable)
        .where(eq(TeamMessageTable.team_id, info.id))
        .all()
        .pipe(Effect.orDie)
      expect(stored.every((row) => row.delivery_status === "delivered")).toBe(true)
    }),
  )

  it.instance("rejects a remote send to a terminal finite member with the typed error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const local = yield* Team.Service
      const info = yield* local.create({
        name: "remote-terminal",
        goal: "Reject terminal mail",
        leadSessionID: "ses_remote_terminal_lead",
      })
      const worker = yield* local.addMember({
        teamID: info.id,
        sessionID: "ses_remote_terminal_worker",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      // Settle the recipient to terminal through the LOCAL service.
      yield* local.updateMemberStatus(worker.id, "completed", "done")

      const remote = yield* remoteTeam({
        teamID: info.id,
        memberSessionID: worker.session_id,
        directory: test.directory,
      })

      // The handler maps the typed Team.MessageToTerminalMember into a 400
      // TeamRequestError; the remote client translates that 400 back into the
      // typed Team.MessageToTerminalMember error. Recipient detail is flattened
      // on the wire (by design the transport does not share recipient rows), so
      // only the typed rejection is asserted here.
      const outcome = yield* remote
        .sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [worker.session_id],
          body: "late mail",
        })
        .pipe(
          Effect.catchTag("Team.MessageToTerminalMember", () => Effect.succeed("terminal-rejected" as const)),
          Effect.catchTag("Team.MessageToClosedTeam", () => Effect.succeed("closed-rejected" as const)),
        )
      expect(outcome).toBe("terminal-rejected")

      const messages = yield* local.getMessages(info.id)
      expect(messages.some((message) => message.body === "late mail")).toBe(false)
    }),
  )

  it.instance("rejects a remote send to a closed team", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const local = yield* Team.Service
      const info = yield* local.create({
        name: "remote-closed",
        goal: "Reject closed-team mail",
        leadSessionID: "ses_remote_closed_lead",
      })
      const worker = yield* local.addMember({
        teamID: info.id,
        sessionID: "ses_remote_closed_worker",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* local.updateMemberStatus(worker.id, "active")
      // Close the team through the LOCAL service. The protocol-1 final-report
      // gate would otherwise block a normal shutdown, so record the team as
      // legacy first (same helper the httpapi-team tests use).
      const { db } = yield* Database.Service
      yield* db.update(TeamTable).set({ protocol_version: 0 }).where(eq(TeamTable.id, info.id)).run().pipe(Effect.orDie)
      yield* local.shutdown({ teamID: info.id, sessionID: info.lead_session_id })

      const remote = yield* remoteTeam({
        teamID: info.id,
        memberSessionID: worker.session_id,
        directory: test.directory,
      })

      const outcome = yield* remote
        .sendMessage({
          teamID: info.id,
          sender: worker.session_id,
          recipients: [info.lead_session_id],
          body: "too late",
        })
        .pipe(
          Effect.catchTag("Team.MessageToTerminalMember", () => Effect.succeed({ closed: false })),
          Effect.catchTag("Team.MessageToClosedTeam", () => Effect.succeed({ closed: true })),
        )
      expect(outcome).toEqual({ closed: true })

      const messages = yield* local.getMessages(info.id)
      expect(messages.some((message) => message.body === "too late")).toBe(false)
    }),
  )

  it.instance("returns the seeded member for the member's own session via context reads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const local = yield* Team.Service
      const info = yield* local.create({
        name: "remote-context",
        goal: "Own-session identity",
        leadSessionID: "ses_remote_context_lead",
      })
      const worker = yield* local.addMember({
        teamID: info.id,
        sessionID: "ses_remote_context_worker",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* local.updateMemberStatus(worker.id, "active")

      const remote = yield* remoteTeam({
        teamID: info.id,
        memberSessionID: worker.session_id,
        directory: test.directory,
      })

      // Own-session identity comes from the Config; the member's own session
      // resolves while an outsider session does not.
      const bySession = yield* remote.getMemberBySession(worker.session_id)
      expect(Option.isSome(bySession)).toBe(true)
      if (Option.isSome(bySession)) {
        expect(bySession.value).toMatchObject({ id: worker.id, name: "worker", status: "active" })
      }
      expect(Option.isNone(yield* remote.getMemberBySession("ses_remote_context_outsider"))).toBe(true)

      const context = yield* remote.getContext(worker.session_id)
      expect(Option.isSome(context)).toBe(true)
      if (Option.isSome(context)) {
        expect(context.value.team.id).toBe(info.id)
        expect(context.value.member).toMatchObject({ id: worker.id, session_id: worker.session_id })
      }
      expect(Option.isNone(yield* remote.getContext("ses_remote_context_outsider"))).toBe(true)
    }),
  )
})
