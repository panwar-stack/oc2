import { afterEach, describe, expect } from "bun:test"
import { Database } from "@/storage/db"
import { Team } from "@/team/team"
import { TeamTable } from "@/team/team.sql"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { Server } from "../../src/server/server"
import { TeamPaths } from "../../src/server/routes/instance/httpapi/groups/team"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(Layer.mergeAll(Team.defaultLayer, Database.defaultLayer))

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => await Server.Default().app.request(path, init))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function withSession(path: string, sessionID: string) {
  return `${path}?sessionID=${encodeURIComponent(sessionID)}`
}

const setLegacyProtocol = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  yield* db.update(TeamTable).set({ protocol_version: 0 }).where(eq(TeamTable.id, teamID)).run().pipe(Effect.orDie)
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
