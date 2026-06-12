import { afterEach, describe, expect } from "bun:test"
import { Team } from "@/team/team"
import { Effect, Option } from "effect"
import { Server } from "../../src/server/server"
import { TeamPaths } from "../../src/server/routes/instance/httpapi/groups/team"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(Team.defaultLayer)

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => await Server.Default().app.request(path, init))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function withSession(path: string, sessionID: string) {
  return `${path}?sessionID=${encodeURIComponent(sessionID)}`
}

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
        headers: { "x-opencode-directory": test.directory },
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
      const info = yield* team.create({ name: "http-daemon-eval", goal: "Expose daemon eval", leadSessionID: "ses_http_daemon_eval_lead" })
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
        headers: { "x-opencode-directory": test.directory },
      })
      const body = yield* responseJson(response)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.findings).toContainEqual(expect.objectContaining({ category: "daemon_error" }))
    })
  )

  it.instance("returns authorized team resources", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({ name: "http-resources", goal: "Expose resources", leadSessionID: "ses_http_lead" })
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
        headers: { "x-opencode-directory": test.directory },
      })
      const tasksResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}/tasks`, info.lead_session_id), {
        headers: { "x-opencode-directory": test.directory },
      })
      const messagesResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}/messages`, member.session_id), {
        headers: { "x-opencode-directory": test.directory },
      })
      const evalResponse = yield* request(withSession(`${TeamPaths.root}/${info.id}/eval`, member.session_id), {
        headers: { "x-opencode-directory": test.directory },
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

  it.instance("rejects outsider access to team resources", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({ name: "http-outsider", goal: "Protect resources", leadSessionID: "ses_owner_lead" })
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
            headers: { "x-opencode-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/tasks`, "ses_outsider"), {
            headers: { "x-opencode-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/messages`, "ses_outsider"), {
            headers: { "x-opencode-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/eval`, "ses_outsider"), {
            headers: { "x-opencode-directory": test.directory },
          }),
          request(withSession(`${TeamPaths.root}/${info.id}/shutdown`, "ses_outsider"), {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
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

  it.instance("allows authorized shutdown", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const team = yield* Team.Service
      const info = yield* team.create({ name: "http-shutdown", goal: "Close cleanly", leadSessionID: "ses_shutdown_lead" })
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
        headers: { "x-opencode-directory": test.directory },
      })
      const body = yield* responseJson(response)
      const after = yield* team.get(info.id)
      const members = yield* team.getMembers(info.id)

      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body).toBe(true)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) expect(after.value.status).toBe("closed")
      expect(members.find((row) => row.id === member.id)?.status).toBe("cancelled")
    }),
  )
})
