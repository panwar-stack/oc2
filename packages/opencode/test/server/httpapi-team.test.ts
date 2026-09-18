import { afterEach, describe, expect } from "bun:test"
import { Database } from "@/storage/db"
import { Team } from "@/team/team"
import { TeamMemberTable, TeamTable } from "@/team/team.sql"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { EventTable } from "@oc2-ai/core/event/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Server } from "../../src/server/server"
import {
  TeamMessagePaths,
  TeamMemberPaths,
  TeamPaths,
  TeamTaskPaths,
  TeamTranscriptSyncPath,
} from "../../src/server/routes/instance/httpapi/groups/team"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect, testEffectShared } from "../lib/effect"
import { NodeHttpServer } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  memberCredentialVerifierLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { Hash } from "@oc2-ai/core/util/hash"
import { EventV2 } from "@oc2-ai/core/event"

EventV2.define({
  type: "test.team.transcript",
  sync: { version: 1, aggregate: "sessionID" },
  schema: { sessionID: Schema.String, value: Schema.Number },
})

const it = testEffectShared(Layer.mergeAll(Team.defaultLayer, Database.defaultLayer))

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => await Server.Default().app.request(path, init))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function responseJsonAs<T>(response: Response) {
  return Effect.promise(() => response.json()).pipe(Effect.map((value) => value as T))
}

function withSession(path: string, sessionID: string) {
  return `${path}?sessionID=${encodeURIComponent(sessionID)}`
}

const setLegacyProtocol = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  yield* db.update(TeamTable).set({ protocol_version: 0 }).where(eq(TeamTable.id, teamID)).run().pipe(Effect.orDie)
})

function pathFor(pattern: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), pattern)
}

function postJson(path: string, payload: unknown, directory: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-oc2-directory", directory)
  headers.set("content-type", "application/json")
  return request(path, {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
}

function expectTeamRequestError(response: Response, body: unknown) {
  expect(response.status, JSON.stringify(body)).toBe(400)
  expect(body).toMatchObject({
    name: "TeamRequestError",
    data: { message: expect.any(String) },
  })
}

/** Inserts the durable session row a headless member needs before a lead plan decision can approve it. */
const insertMemberSession = Effect.fnUntraced(function* (sessionID: string, directory: string) {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("missing test instance context"))
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(SessionTable)
    .values({
      id: SessionID.make(sessionID),
      project_id: ctx.project.id,
      slug: "teammate",
      directory,
      path: null,
      title: "Teammate",
      agent: "general",
      version: "test",
      time_created: now,
      time_updated: now,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return yield* Effect.void
})

const readTeamRevision = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ revision: TeamTable.revision })
    .from(TeamTable)
    .where(eq(TeamTable.id, teamID))
    .get()
    .pipe(Effect.orDie)
  return row?.revision ?? -1
})

afterEach(async () => {
  await resetDatabase()
})

describe("team HttpApi", () => {
  it.instance("returns team evaluation reports", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({ name: "http-eval", goal: "Expose eval", leadSessionID: "ses_http_eval_lead" })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_http_eval_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "completed", "done")
      yield* team.createUsageEvent({ teamID: info.id, type: "report_generated" })

      const response = yield* request(withSession(`${TeamPaths.root}/${info.id}/eval`, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({
        team_id: info.id,
        nodes: expect.arrayContaining([expect.objectContaining({ id: `team:${info.id}`, type: "team" })]),
        edges: expect.arrayContaining([
          expect.objectContaining({
            type: "lead_to_member",
            from: `team:${info.id}`,
            to: `member:${member.session_id}`,
          }),
          expect.objectContaining({
            type: "produces",
            from: `member:${member.session_id}`,
            to: `result:${member.session_id}`,
          }),
        ]),
        summary: expect.objectContaining({
          root_cause_count: 0,
          usage: expect.objectContaining({
            member_count: 1,
            task_count: 0,
            final_report_generated: true,
          }),
        }),
      })
    }),
  )

  it.instance("returns daemon evaluation findings", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-daemon-eval",
        goal: "Expose daemon eval",
        leadSessionID: "ses_http_daemon_eval_lead",
      })
      const daemon = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_http_daemon_eval_member",
        name: "sentinel",
        agentType: "general",
        rolePrompt: "Monitor",
        lifecycle: "daemon",
        daemonState: "error",
        daemonError: "boom",
      })
      yield* team.updateMemberStatus(daemon.id, "cancelled", { daemonState: "error", daemonError: "boom" })

      const response = yield* request(withSession(`${TeamPaths.root}/${info.id}/eval`, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.findings).toContainEqual(expect.objectContaining({ category: "daemon_error" }))
    }),
  )

  it.instance("returns authorized team resources", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-resources",
        goal: "Expose resources",
        leadSessionID: "ses_http_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_http_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      const dependency = yield* team.createTask({ teamID: info.id, description: "Dependency" })
      const task = yield* team.createTask({
        teamID: info.id,
        description: "Visible task",
        assignee: member.session_id,
        dependencyIDs: [dependency.id],
        metadata: { priority: "high" },
      })
      const message = yield* team.sendMessage({
        teamID: info.id,
        sender: info.lead_session_id,
        recipients: [member.session_id],
        body: "Please inspect the API.",
      })

      const teamResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}`, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const tasksResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}/tasks`, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const messagesResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}/messages`, member.session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const evalResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}/eval`, member.session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const teamBody = yield* responseJson(teamResponse)
      const tasksBody = yield* responseJson(tasksResponse)
      const messagesBody = yield* responseJson(messagesResponse)
      const evalBody = yield* responseJson(evalResponse)

      expect(teamResponse.status, JSON.stringify(teamBody)).toBe(200)
      expect(tasksResponse.status, JSON.stringify(tasksBody)).toBe(200)
      expect(messagesResponse.status, JSON.stringify(messagesBody)).toBe(200)
      expect(evalResponse.status, JSON.stringify(evalBody)).toBe(200)
      expect(teamBody).toMatchObject({ id: info.id })
      expect(tasksBody.find((row: { id: string }) => row.id === dependency.id)?.assignee).toBeUndefined()
      expect(tasksBody).toContainEqual(
        expect.objectContaining({
          id: task.id,
          assignee: member.session_id,
          dependency_ids: [dependency.id],
          metadata: { priority: "high" },
        }),
      )
      expect(messagesBody).toContainEqual(expect.objectContaining({ id: message.id, body: "Please inspect the API." }))
      expect(evalBody).toMatchObject({ team_id: info.id })
    }),
  )

  it.instance("returns owned_paths and handoff on task responses", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-owned",
        goal: "Owned tasks",
        leadSessionID: "ses_http_owned_lead",
      })
      const task = yield* team.createTask({
        teamID: info.id,
        description: "Owned HTTP task",
        owned: [{ rootKey: "/work", pathKey: "/work/owned.txt", displayPath: "owned.txt" }],
      })
      yield* team.claimTask(info.id, task.id, "ses_http_owned_worker")
      yield* team.updateTask(
        info.id,
        task.id,
        {
          status: "completed",
          handoff: {
            summary: "Finished the owned HTTP task",
            changed_paths: ["owned.txt"],
            verification: [{ command: "bun test", status: "passed" }],
          },
          handoffPathKeys: ["/work/owned.txt"],
        },
        { sessionID: "ses_http_owned_worker", isLead: false },
      )

      const response = yield* request(withSession(`${TeamPaths.root}/${info.id}/tasks`, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toContainEqual(
        expect.objectContaining({
          id: task.id,
          owned_paths: ["owned.txt"],
          handoff: expect.objectContaining({ summary: "Finished the owned HTTP task" }),
        }),
      )
    }),
  )

  it.instance("returns owned_paths and a null handoff for unowned tasks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-unowned",
        goal: "Plain tasks",
        leadSessionID: "ses_http_unowned_lead",
      })
      const task = yield* team.createTask({ teamID: info.id, description: "Plain HTTP task" })

      const response = yield* request(withSession(`${TeamPaths.root}/${info.id}/tasks`, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toContainEqual(
        expect.objectContaining({
          id: task.id,
          owned_paths: [],
          handoff: null,
        }),
      )
    }),
  )

  it.instance("rejects outsider access to team resources", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-outsider",
        goal: "Protect resources",
        leadSessionID: "ses_owner_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_owner_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")

      const responses = yield* Effect.forEach(
        [
          request(withSession(`${TeamPaths.root}/${info.id}`, "ses_outsider"), {
            headers: { "x-oc2-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/tasks`, "ses_outsider"), {
            headers: { "x-oc2-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/messages`, "ses_outsider"), {
            headers: { "x-oc2-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/eval`, "ses_outsider"), {
            headers: { "x-oc2-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/shutdown`, "ses_outsider"), {
            method: "POST",
            headers: { "x-oc2-directory": test.directory },
          }),
        ],
        (effect) => effect,
      )
      const after = yield* team.get(info.id)
      const members = yield* team.getMembers(info.id)

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400])
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) expect(after.value.status).toBe("active")
      expect(members.find((row) => row.id === member.id)?.status).toBe("active")
    }),
  )

  it.instance("allows authorized legacy shutdown and returns stable counts", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-shutdown",
        goal: "Close cleanly",
        leadSessionID: "ses_shutdown_lead",
      })
      yield* setLegacyProtocol(info.id)
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_shutdown_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")

      const response = yield* request(withSession(`${TeamPaths.root}/${info.id}/shutdown`, info.lead_session_id), {
        method: "POST",
        headers: { "x-oc2-directory": test.directory },
      })
      const body = yield* responseJson(response)
      const after = yield* team.get(info.id)
      const members = yield* team.getMembers(info.id)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({
        team_id: info.id,
        cancelled_members: 1,
        cancelled_tasks: 0,
        released_reservations: 0,
        session_cancellation_failures: 0,
      })
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) expect(after.value.status).toBe("closed")
      expect(members.find((row) => row.id === member.id)?.status).toBe("cancelled")
    }),
  )

  it.instance("rejects shutdown from a member session even though reads are allowed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-shutdown-member",
        goal: "Close cleanly",
        leadSessionID: "ses_shutdown_lead_member",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_shutdown_http_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")

      const response = yield* request(withSession(`${TeamPaths.root}/${info.id}/shutdown`, member.session_id), {
        method: "POST",
        headers: { "x-oc2-directory": test.directory },
      })
      const after = yield* team.get(info.id)

      expect(response.status).toBe(400)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) expect(after.value.status).toBe("active")
    }),
  )
})

describe("team control-plane HttpApi", () => {
  it.instance("serves member context to the lead and the owning member and rejects outsiders", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-ctx",
        goal: "Serve context",
        leadSessionID: "ses_ctx_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_ctx_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")

      const contextPath = pathFor(TeamMemberPaths.context, { teamID: info.id, sessionID: member.session_id })

      const leadResponse = yield* request(withSession(contextPath, info.lead_session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const leadBody = yield* responseJson(leadResponse)
      expect(leadResponse.status, JSON.stringify(leadBody)).toBe(200)
      expect(leadBody).toMatchObject({
        team: { id: info.id },
        member: { session_id: member.session_id },
        session: { id: member.session_id },
      })
      expect(Array.isArray(leadBody.messages)).toBe(true)

      const ownerResponse = yield* request(withSession(contextPath, member.session_id), {
        headers: { "x-oc2-directory": test.directory },
      })
      const ownerBody = yield* responseJson(ownerResponse)
      expect(ownerResponse.status, JSON.stringify(ownerBody)).toBe(200)
      expect(ownerBody).toMatchObject({
        team: { id: info.id },
        member: { session_id: member.session_id },
      })

      const outsiderResponse = yield* request(withSession(contextPath, "ses_ctx_outsider"), {
        headers: { "x-oc2-directory": test.directory },
      })
      const outsiderBody = yield* responseJson(outsiderResponse)
      expectTeamRequestError(outsiderResponse, outsiderBody)
    }),
  )

  it.instance("persists a lead run instruction to the member mailbox and rejects member callers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-run",
        goal: "Deliver run instructions",
        leadSessionID: "ses_run_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_run_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")

      const runPath = pathFor(TeamMemberPaths.run, { teamID: info.id, sessionID: member.session_id })
      const response = yield* postJson(
        withSession(runPath, info.lead_session_id),
        { instruction: "Implement the endpoints and report back." },
        test.directory,
      )
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({
        member_id: member.id,
        session_id: member.session_id,
        status: "active",
      })

      const pending = yield* team.getPendingMessages(member.session_id, info.id)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        body: "Implement the endpoints and report back.",
        recipients: [member.session_id],
      })

      const memberResponse = yield* postJson(
        withSession(runPath, member.session_id),
        { instruction: "Self run request must be rejected." },
        test.directory,
      )
      const memberBody = yield* responseJson(memberResponse)
      expectTeamRequestError(memberResponse, memberBody)
      expect((yield* team.getPendingMessages(member.session_id, info.id))).toHaveLength(1)
    }),
  )

  it.instance("rejects mailbox sends to a terminal member over HTTP without creating rows", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-terminal-recipient",
        goal: "Reject mail to terminal members",
        leadSessionID: "ses_terminal_recipient_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_terminal_recipient_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "completed", "done")
      const before = yield* team.getMessages(info.id)

      const response = yield* postJson(
        withSession(pathFor(TeamMessagePaths.send, { teamID: info.id }), info.lead_session_id),
        { recipients: [member.session_id], body: "hello after terminal" },
        test.directory,
      )
      const body = yield* responseJson(response)
      expectTeamRequestError(response, body)

      const after = yield* team.getMessages(info.id)
      expect(after.length).toBe(before.length)
      expect(yield* team.getPendingMessages(member.session_id, info.id)).toHaveLength(0)
    }),
  )

  it.instance("claims each mailbox message exactly once across concurrent HTTP claims", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-claims",
        goal: "Claim exactly once",
        leadSessionID: "ses_claims_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_claims_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")

      const first = yield* team.sendMessage({
        teamID: info.id,
        sender: info.lead_session_id,
        recipients: [member.session_id],
        body: "claim me once",
      })
      const second = yield* team.sendMessage({
        teamID: info.id,
        sender: info.lead_session_id,
        recipients: [member.session_id],
        body: "claim me once too",
      })

      const claim = () =>
        request(withSession(pathFor(TeamMessagePaths.claim, { teamID: info.id }), member.session_id), {
          method: "POST",
          headers: { "x-oc2-directory": test.directory },
        })

      const [responseA, responseB] = yield* Effect.all([claim(), claim()], { concurrency: 2 })
      const bodyA = yield* responseJsonAs<Array<{ id: string }>>(responseA)
      const bodyB = yield* responseJsonAs<Array<{ id: string }>>(responseB)

      expect(responseA.status, JSON.stringify(bodyA)).toBe(200)
      expect(responseB.status, JSON.stringify(bodyB)).toBe(200)
      const idsA = bodyA.map((message) => message.id)
      const idsB = bodyB.map((message) => message.id)
      expect(idsA.some((id) => idsB.includes(id))).toBe(false)
      expect([...idsA, ...idsB].sort()).toEqual([first.id, second.id].sort())
      expect(yield* team.getPendingMessages(member.session_id, info.id)).toHaveLength(0)
    }),
  )

  it.instance("records a daemon heartbeat without bumping the team revision", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-heartbeat",
        goal: "Track daemon liveness",
        leadSessionID: "ses_heartbeat_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_heartbeat_member",
        name: "sentinel",
        agentType: "general",
        rolePrompt: "Monitor",
        lifecycle: "daemon",
        daemonState: "idle",
      })
      yield* team.updateMemberStatus(member.id, "active")
      const revisionBefore = yield* readTeamRevision(info.id)

      const heartbeatPath = pathFor(TeamMemberPaths.heartbeat, { teamID: info.id, sessionID: member.session_id })
      const response = yield* postJson(
        withSession(heartbeatPath, member.session_id),
        { daemon_state: "running" },
        test.directory,
      )
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({ member_id: member.id, session_id: member.session_id })
      expect(typeof body.daemon_last_active).toBe("number")
      expect(Date.now() - body.daemon_last_active).toBeLessThan(5_000)

      const members = yield* team.getMembers(info.id)
      const stored = members.find((row) => row.id === member.id)
      expect(stored?.daemon_last_active).toBe(body.daemon_last_active)
      expect(stored?.daemon_state).toBe("running")
      expect(stored?.status).toBe("active")

      const revisionAfter = yield* readTeamRevision(info.id)
      expect(revisionAfter).toBe(revisionBefore)
    }),
  )

  it.instance("claims and completes a shared task over HTTP", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-tasks",
        goal: "Claim tasks over HTTP",
        leadSessionID: "ses_task_http_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_task_http_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")
      const task = yield* team.createTask({ teamID: info.id, description: "Build the transport" })

      const claimPath = pathFor(TeamTaskPaths.claim, { teamID: info.id, taskID: task.id })
      const claimedResponse = yield* request(withSession(claimPath, member.session_id), {
        method: "POST",
        headers: { "x-oc2-directory": test.directory },
      })
      const claimedBody = yield* responseJson(claimedResponse)
      expect(claimedResponse.status, JSON.stringify(claimedBody)).toBe(200)
      expect(claimedBody).toMatchObject({
        id: task.id,
        status: "in_progress",
        assignee: member.session_id,
      })

      const updatePath = pathFor(TeamTaskPaths.update, { teamID: info.id, taskID: task.id })
      const updatedResponse = yield* postJson(
        withSession(updatePath, member.session_id),
        { status: "completed" },
        test.directory,
      )
      const updatedBody = yield* responseJson(updatedResponse)
      expect(updatedResponse.status, JSON.stringify(updatedBody)).toBe(200)
      expect(updatedBody).toMatchObject({ id: task.id, status: "completed" })

      const stored = yield* team.getTask(info.id, task.id)
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isSome(stored)) expect(stored.value.status).toBe("completed")
    }),
  )

  it.instance("round-trips a plan submission and lead approval over HTTP", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-plan",
        goal: "Submit and decide plans over HTTP",
        leadSessionID: "ses_plan_http_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_plan_http_member",
        name: "planner",
        agentType: "general",
        rolePrompt: "Plan first",
        planMode: true,
        workMode: "plan",
      })
      yield* team.updateMemberStatus(member.id, "active")
      // Plan approval persists a permission update and a wake against the member's session row.
      yield* insertMemberSession(member.session_id, test.directory)

      const planPath = pathFor(TeamMemberPaths.plan, { teamID: info.id, sessionID: member.session_id, action: "submit" })
      const submittedResponse = yield* postJson(
        withSession(planPath, member.session_id),
        { plan: "I will add typed client calls and regenerate the SDK." },
        test.directory,
      )
      const submittedBody = yield* responseJson(submittedResponse)
      expect(submittedResponse.status, JSON.stringify(submittedBody)).toBe(200)
      expect(submittedBody).toMatchObject({
        decision: "submitted",
        member_id: member.id,
        session_id: member.session_id,
      })

      const messages = yield* team.getMessages(info.id)
      expect(
        messages.some((message) => message.body.startsWith(`PLAN SUBMITTED by ${member.name}:`)),
      ).toBe(true)

      const decidePath = pathFor(TeamMemberPaths.plan, {
        teamID: info.id,
        sessionID: member.session_id,
        action: "decide",
      })
      const decidedResponse = yield* postJson(
        withSession(decidePath, info.lead_session_id),
        { decision: "approve" },
        test.directory,
      )
      const decidedBody = yield* responseJson(decidedResponse)
      expect(decidedResponse.status, JSON.stringify(decidedBody)).toBe(200)
      expect(decidedBody).toMatchObject({
        decision: "approved",
        member_id: member.id,
        session_id: member.session_id,
      })

      const members = yield* team.getMembers(info.id)
      const stored = members.find((row) => row.id === member.id)
      expect(stored?.plan_mode).toBe(false)
      expect(stored?.work_mode).toBe("implement")
      expect(stored?.status).toBe("active")
    }),
  )

  it.instance("rejects transcript sync from non-members and from foreign aggregates", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-transcript",
        goal: "Protect transcript sync",
        leadSessionID: "ses_transcript_http_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_transcript_http_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")
      const syncPath = pathFor(TeamTranscriptSyncPath, { teamID: info.id })
      const payload = {
        directory: test.directory,
        events: [
          {
            id: "evt_http_transcript",
            aggregateID: member.session_id,
            seq: 0,
            type: "session.created",
            data: {},
          },
        ],
      }

      const outsiderResponse = yield* postJson(
        withSession(syncPath, "ses_transcript_http_outsider"),
        payload,
        test.directory,
      )
      const outsiderBody = yield* responseJson(outsiderResponse)
      expectTeamRequestError(outsiderResponse, outsiderBody)

      const foreignResponse = yield* postJson(
        withSession(syncPath, member.session_id),
        {
          directory: test.directory,
          events: [
            {
              id: "evt_http_transcript_foreign",
              aggregateID: "ses_transcript_http_foreign_aggregate",
              seq: 0,
              type: "session.created",
              data: {},
            },
          ],
        },
        test.directory,
      )
      const foreignBody = yield* responseJson(foreignResponse)
      expectTeamRequestError(foreignResponse, foreignBody)
    }),
  )

  it.instance("deduplicates member transcript events and assigns lead sequence numbers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({
        name: "http-transcript-sequence",
        goal: "Sync one member aggregate",
        leadSessionID: "ses_transcript_sequence_lead",
      })
      const member = yield* team.addMember({
        teamID: info.id,
        sessionID: "ses_transcript_sequence_member",
        name: "worker",
        agentType: "general",
        rolePrompt: "Do the work",
      })
      yield* team.updateMemberStatus(member.id, "active")
      const syncPath = withSession(pathFor(TeamTranscriptSyncPath, { teamID: info.id }), member.session_id)
      const payload = {
        directory: test.directory,
        events: [
          {
            id: "evt_http_transcript_sequence_1",
            aggregateID: member.session_id,
            seq: 40,
            type: "test.team.transcript.1",
            data: { sessionID: member.session_id, value: 1 },
          },
          {
            id: "evt_http_transcript_sequence_2",
            aggregateID: member.session_id,
            seq: 41,
            type: "test.team.transcript.1",
            data: { sessionID: member.session_id, value: 2 },
          },
        ],
      }

      const firstResponse = yield* postJson(syncPath, payload, test.directory)
      const firstBody = yield* responseJson(firstResponse)
      expect(firstResponse.status, JSON.stringify(firstBody)).toBe(200)
      expect(firstBody).toMatchObject({ sessionID: member.session_id, events: 2, cursor: 1 })

      const secondResponse = yield* postJson(syncPath, payload, test.directory)
      const secondBody = yield* responseJson(secondResponse)
      expect(secondResponse.status, JSON.stringify(secondBody)).toBe(200)
      expect(secondBody).toMatchObject({ sessionID: member.session_id, events: 0, cursor: 1 })

      const { db } = yield* Database.Service
      const stored = yield* db
        .select({ id: EventTable.id, seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, member.session_id))
        .all()
        .pipe(Effect.orDie)
      expect(stored.map((event) => ({ id: String(event.id), seq: event.seq }))).toEqual([
        { id: "evt_http_transcript_sequence_1", seq: 0 },
        { id: "evt_http_transcript_sequence_2", seq: 1 },
      ])
    }),
  )
})

// ---------------------------------------------------------------------------
// Defect-1 regression: per-member control-plane credentials.
// preload.ts deletes OC2_SERVER_PASSWORD/OC2_SERVER_USERNAME for every test, so
// this suite constructs ServerAuth.Config.layer(...) directly (same pattern as
// httpapi-authorization.test.ts) instead of relying on the environment. It
// exercises the real authorization middleware plus the member verifier against
// seeded `team_member.credential_hash` rows.
// ---------------------------------------------------------------------------

const CredentialProbeApi = HttpApi.make("test-team-credential").add(
  HttpApiGroup.make("probe")
    .add(
      HttpApiEndpoint.get("member", "/team/:teamID/members/:sessionID/context", {
        params: { teamID: Schema.String, sessionID: Schema.String },
        success: Schema.String,
      }),
      HttpApiEndpoint.get("messages", "/team/:teamID/messages", {
        params: { teamID: Schema.String },
        query: Schema.Struct({ sessionID: Schema.String }),
        success: Schema.String,
      }),
      HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }),
      HttpApiEndpoint.post("abort", "/session/:sessionID/abort", {
        params: { sessionID: Schema.String },
        success: Schema.String,
      }),
      HttpApiEndpoint.post("syncHistory", "/sync/history", { success: Schema.String }),
    )
    .middleware(Authorization),
)

const credentialProbeHandlers = HttpApiBuilder.group(CredentialProbeApi, "probe", (handlers) =>
  handlers
    .handle("member", () => Effect.succeed("ok"))
    .handle("messages", () => Effect.succeed("ok"))
    .handle("probe", () => Effect.succeed("ok"))
    .handle("abort", () => Effect.succeed("ok"))
    .handle("syncHistory", () => Effect.succeed("ok")),
)

const credentialApiLayer = (config: ServerAuth.Info) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(CredentialProbeApi).pipe(
      Layer.provide(credentialProbeHandlers),
      Layer.provide(authorizationLayer),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(memberCredentialVerifierLayer),
    Layer.provide(ServerAuth.Config.layer(config)),
    Layer.provideMerge(Database.defaultLayer),
  )

const credentialTeamA = "team_credential_a"
const credentialTeamB = "team_credential_b"
const credentialMemberA = "ses_credential_a"
const credentialMemberB = "ses_credential_b"
const credentialSecretA = "member-secret-a"
const credentialSecretB = "member-secret-b"

const seedCredentialMembers = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const now = Date.now()
  yield* db
    .insert(TeamMemberTable)
    .values([
      {
        id: "tm_credential_a",
        team_id: credentialTeamA,
        session_id: credentialMemberA,
        name: "member-a",
        agent_type: "general",
        role_prompt: "a",
        status: "active",
        credential_hash: Hash.sha256(credentialSecretA),
        time_created: now,
        time_updated: now,
      },
      {
        id: "tm_credential_b",
        team_id: credentialTeamB,
        session_id: credentialMemberB,
        name: "member-b",
        agent_type: "general",
        role_prompt: "b",
        status: "active",
        credential_hash: Hash.sha256(credentialSecretB),
        time_created: now,
        time_updated: now,
      },
    ])
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const memberBasic = (password: string) => ServerAuth.header({ username: "oc2", password }) ?? ""
const emptyBasic = () => `Basic ${Buffer.from("oc2:", "utf8").toString("base64")}`

const credentialRequest = (path: string, authorization?: string) =>
  HttpClientRequest.get(path).pipe(
    authorization ? HttpClientRequest.setHeader("authorization", authorization) : (request) => request,
    HttpClient.execute,
  )

const itSharedCredential = testEffect(credentialApiLayer({ password: Option.some("shared"), username: "oc2" }))
const itNoSharedPassword = testEffect(credentialApiLayer({ password: Option.none(), username: "opencode" }))

describe("team control-plane member credential authorization", () => {
  itSharedCredential.live(
    "authorizes a member secret on its own endpoint and the shared password on the lead path",
    () =>
      Effect.gen(function* () {
        yield* seedCredentialMembers
        const [own, shared, wrong] = yield* Effect.all(
          [
            credentialRequest(
              `/team/${credentialTeamA}/members/${credentialMemberA}/context`,
              memberBasic(credentialSecretA),
            ),
            credentialRequest("/probe", memberBasic("shared")),
            credentialRequest(
              `/team/${credentialTeamA}/members/${credentialMemberA}/context`,
              memberBasic("wrong-secret"),
            ),
          ],
          { concurrency: "unbounded" },
        )
        expect(own.status).toBe(200)
        expect(shared.status).toBe(200)
        expect(wrong.status).toBe(401)
        expect(wrong.headers["www-authenticate"] ?? "").toContain("Basic")
      }),
  )

  itSharedCredential.live("rejects a member secret that names another member or team", () =>
    Effect.gen(function* () {
      yield* seedCredentialMembers
      const [otherMember, otherTeam, ownTeamQuery, foreignTeamQuery, emptyPassword] = yield* Effect.all(
        [
          credentialRequest(
            `/team/${credentialTeamA}/members/${credentialMemberB}/context`,
            memberBasic(credentialSecretA),
          ),
          credentialRequest(
            `/team/${credentialTeamB}/members/${credentialMemberA}/context`,
            memberBasic(credentialSecretA),
          ),
          credentialRequest(
            `/team/${credentialTeamA}/messages?sessionID=${credentialMemberA}`,
            memberBasic(credentialSecretA),
          ),
          credentialRequest(
            `/team/${credentialTeamA}/messages?sessionID=${credentialMemberB}`,
            memberBasic(credentialSecretA),
          ),
          credentialRequest(
            `/team/${credentialTeamA}/messages?sessionID=${credentialMemberA}`,
            emptyBasic(),
          ),
        ],
        { concurrency: "unbounded" },
      )
      expect(otherMember.status).toBe(401)
      expect(otherTeam.status).toBe(401)
      expect(ownTeamQuery.status).toBe(200)
      expect(foreignTeamQuery.status).toBe(401)
      expect(emptyPassword.status).toBe(401)
    }),
  )

  itSharedCredential.live("rejects a team path with no session query", () =>
    Effect.gen(function* () {
      yield* seedCredentialMembers
      const response = yield* credentialRequest(
        `/team/${credentialTeamA}/messages`,
        memberBasic(credentialSecretA),
      )
      expect(response.status).toBe(401)
    }),
  )

  itNoSharedPassword.live("keeps auth disabled when no shared password is configured", () =>
    Effect.gen(function* () {
      yield* seedCredentialMembers
      const [headerless, memberSecret, wrongSecret] = yield* Effect.all(
        [
          credentialRequest(`/team/${credentialTeamA}/messages?sessionID=${credentialMemberA}`),
          credentialRequest(
            `/team/${credentialTeamA}/messages?sessionID=${credentialMemberA}`,
            memberBasic(credentialSecretA),
          ),
          credentialRequest("/probe", memberBasic("wrong-secret")),
        ],
        { concurrency: "unbounded" },
      )
      expect(headerless.status).toBe(200)
      expect(memberSecret.status).toBe(200)
      expect(wrongSecret.status).toBe(200)
    }),
  )

  itSharedCredential.live("scopes a member credential to team and sync routes only", () =>
    Effect.gen(function* () {
      yield* seedCredentialMembers
      const post = (path: string, authorization: string) =>
        HttpClientRequest.post(path).pipe(
          HttpClientRequest.setHeader("authorization", authorization),
          HttpClient.execute,
        )
      const [probe, otherAbort, ownAbort, syncHistory] = yield* Effect.all(
        [
          credentialRequest("/probe", memberBasic(credentialSecretA)),
          post("/session/ses_some_other_session/abort", memberBasic(credentialSecretA)),
          post(`/session/${credentialMemberA}/abort`, memberBasic(credentialSecretA)),
          post("/sync/history", memberBasic(credentialSecretA)),
        ],
        { concurrency: "unbounded" },
      )
      // A member credential must not authorize unrelated instance routes, even
      // its own session's abort; only team routes and the sync endpoints are in scope.
      expect(probe.status).toBe(401)
      expect(otherAbort.status).toBe(401)
      expect(ownAbort.status).toBe(401)
      expect(syncHistory.status).toBe(200)
    }),
  )
})
