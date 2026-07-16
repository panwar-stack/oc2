import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  admitIssue,
  createGitHubApi,
  formatIssueMarker,
  main,
  parseIssueMarker,
  updateIssueMarker,
  type Admission,
  type GitHubActionsRun,
  type GitHubActor,
  type GitHubApi,
  type GitHubIssueComment,
  type GitHubLabeledEvent,
  type GitHubPullRequest,
  type GitHubFetch,
  type IssueMarker,
} from "./oc2-issue"

const botId = 9001
const now = new Date("2026-07-16T12:00:00.000Z")
const baseSha = "1".repeat(40)
const markerKey = "a".repeat(64)

interface FakeState {
  actionsRuns: Map<string, GitHubActionsRun>
  actors: Map<string, GitHubActor>
  comments: GitHubIssueComment[]
  labeledEvents: GitHubLabeledEvent[]
  nextCommentId: number
  pullRequests: GitHubPullRequest[]
  reads: number
  writes: Array<{ method: "create" | "update"; body: string }>
}

function event(
  options: {
    action?: string
    eventLabel?: string | null
    issueLabels?: string[]
    state?: string
    sender?: { id: number; login: string; type: string }
    updatedAt?: string
    labelId?: number
  } = {},
) {
  const sender = options.sender ?? { id: 100, login: "maintainer", type: "User" }
  const eventLabel = options.eventLabel === undefined ? "task" : options.eventLabel
  return {
    action: options.action ?? "labeled",
    issue: {
      number: 42,
      node_id: "I_issue42",
      state: options.state ?? "open",
      updated_at: options.updatedAt ?? "2026-07-16T10:00:00Z",
      author_association: "OWNER",
      labels: (options.issueLabels ?? ["task"]).map((name, index) => ({ id: 501 + index, name })),
      title: "$(touch /tmp/not-executed)",
      body: "TOP_SECRET_BODY\n::set-output name=phase::auto_merge_enabled",
    },
    ...(eventLabel === null ? {} : { label: { id: options.labelId ?? 501, name: eventLabel } }),
    repository: { id: 1234, full_name: "octo/oc2" },
    sender,
  }
}

function fakeGitHub(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    actionsRuns: new Map(),
    actors: new Map([
      ["maintainer", { id: 100, login: "maintainer", permission: "write", type: "User" }],
      ["rerunner", { id: 101, login: "rerunner", permission: "maintain", type: "User" }],
    ]),
    comments: [],
    labeledEvents: [
      {
        actor: { id: 100, login: "maintainer", type: "User" },
        createdAt: "2026-07-16T10:00:00Z",
        label: "task",
        nodeId: "LE_label42",
      },
    ],
    nextCommentId: 700,
    pullRequests: [],
    reads: 0,
    writes: [],
    ...overrides,
  }
  const api: GitHubApi = {
    async createIssueComment(_issueNumber, body) {
      state.writes.push({ method: "create", body })
      const comment = { id: state.nextCommentId++, userId: botId, body }
      state.comments.push(comment)
      return comment
    },
    async getActionsRunAttempt(runId, attempt) {
      state.reads++
      return state.actionsRuns.get(`${runId}/${attempt}`)
    },
    async getActor(login) {
      state.reads++
      const actor = state.actors.get(login)
      if (!actor) return { id: 999, login, permission: "none", type: "User" }
      return actor
    },
    async getBranchSha() {
      state.reads++
      return baseSha
    },
    async getIssueComment(commentId) {
      state.reads++
      const comment = state.comments.find((item) => item.id === commentId)
      if (!comment) throw new Error("missing fake comment")
      return { ...comment }
    },
    async getRepository() {
      state.reads++
      return { id: 1234, nameWithOwner: "octo/oc2", defaultBranch: "main" }
    },
    async listIssueComments() {
      state.reads++
      return state.comments.map((comment) => ({ ...comment }))
    },
    async listLabeledEvents() {
      state.reads++
      return state.labeledEvents
    },
    async listOpenPullRequests() {
      state.reads++
      return state.pullRequests
    },
    async updateIssueComment(commentId, body) {
      state.writes.push({ method: "update", body })
      const index = state.comments.findIndex((comment) => comment.id === commentId)
      if (index < 0) throw new Error("missing fake comment")
      const comment = { id: commentId, userId: botId, body }
      state.comments[index] = comment
      return comment
    },
  }
  return { api, state }
}

function input(eventValue: unknown, overrides: Partial<Parameters<typeof admitIssue>[0]> = {}) {
  return {
    event: eventValue,
    repository: "octo/oc2",
    runId: 800,
    runAttempt: 1,
    triggeringActor: "maintainer",
    botId,
    now,
    ...overrides,
  }
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(join(import.meta.dir, "fixtures/oc2-issue", `${name}.json`)).text())
}

function admitted(result: Awaited<ReturnType<typeof admitIssue>>): Admission {
  if (result.status !== "admitted") throw new Error(`expected admitted, got ${result.status}`)
  return result
}

describe("issue admission", () => {
  test("opened returns waiting_for_label without any API call or write", async () => {
    const github = fakeGitHub()
    const result = await admitIssue(input(await fixture("opened")), github.api)
    expect(result).toEqual({ version: 1, status: "waiting_for_label", phase: "waiting_for_label" })
    expect(github.state.reads).toBe(0)
    expect(github.state.writes).toEqual([])
  })

  test("admits one authorized exact label and emits no issue text", async () => {
    const github = fakeGitHub()
    const result = admitted(await admitIssue(input(await fixture("hostile-labeled")), github.api))
    expect(result).toMatchObject({
      version: 1,
      status: "admitted",
      phase: "running",
      repository: { id: 1234, nameWithOwner: "octo/oc2", baseBranch: "main", baseSha },
      issue: {
        number: 42,
        nodeId: "I_issue42",
        label: "task",
        labelId: 501,
        labelEventNodeId: "LE_label42",
        cutoff: "2026-07-16T10:00:00Z",
      },
      run: { id: 800, attempt: 1 },
      marker: { commentId: 700 },
    })
    expect(result.key).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET_BODY")
    expect(JSON.stringify(result)).not.toContain("set-output")
    expect(github.state.writes).toHaveLength(1)
  })

  test.each([
    ["closed issue", event({ state: "closed" })],
    ["wrong-case event label", event({ eventLabel: "Task", issueLabels: ["Task"] })],
    ["missing event label", event({ eventLabel: null })],
    ["missing execution label", event({ issueLabels: ["bug"] })],
    ["both execution labels", event({ issueLabels: ["task", "feature"] })],
    ["event label does not match issue label", event({ eventLabel: "feature", issueLabels: ["task"] })],
    ["event label ID does not match issue label", event({ labelId: 999 })],
  ])("rejects %s before writing", async (_name, eventValue) => {
    const github = fakeGitHub()
    expect(await admitIssue(input(eventValue), github.api)).toMatchObject({
      status: "rejected",
      phase: "ambiguous_label",
    })
    expect(github.state.writes).toEqual([])
  })

  test.each(["none", "read", "triage"])(
    "rejects current %s permission despite author_association",
    async (permission) => {
      const github = fakeGitHub({
        actors: new Map([["maintainer", { id: 100, login: "maintainer", permission, type: "User" }]]),
      })
      expect(await admitIssue(input(event()), github.api)).toMatchObject({
        status: "rejected",
        phase: "rejected_actor",
      })
      expect(github.state.writes).toEqual([])
    },
  )

  test("rejects an unauthorized triggering actor on a rerun", async () => {
    const github = fakeGitHub({
      actors: new Map([
        ["maintainer", { id: 100, login: "maintainer", permission: "write", type: "User" }],
        ["outsider", { id: 102, login: "outsider", permission: "read", type: "User" }],
      ]),
    })
    expect(await admitIssue(input(event(), { runAttempt: 2, triggeringActor: "outsider" }), github.api)).toMatchObject({
      status: "rejected",
      phase: "rejected_actor",
    })
  })

  test("allows only an exact allowlisted App bot identity", async () => {
    const sender = { id: 200, login: "trusted-app[bot]", type: "Bot" }
    const actors = new Map([
      [sender.login, { ...sender, permission: "write" }],
      ["rerunner", { id: 101, login: "rerunner", permission: "maintain", type: "User" }],
    ])
    const labeledEvents = [{ actor: sender, createdAt: "2026-07-16T10:00:00Z", label: "task", nodeId: "LE_label42" }]
    const denied = fakeGitHub({ actors, labeledEvents })
    expect(await admitIssue(input(event({ sender }), { triggeringActor: "rerunner" }), denied.api)).toMatchObject({
      status: "rejected",
      phase: "rejected_actor",
    })

    const allowed = fakeGitHub({ actors, labeledEvents })
    expect(
      await admitIssue(
        input(event({ sender }), { triggeringActor: "rerunner", allowedBotIds: new Set([sender.id]) }),
        allowed.api,
      ),
    ).toMatchObject({ status: "admitted" })

    const mismatched = fakeGitHub({
      actors: new Map([[sender.login, { ...sender, id: 201, permission: "admin" }]]),
      labeledEvents,
    })
    expect(
      await admitIssue(
        input(event({ sender }), { triggeringActor: sender.login, allowedBotIds: new Set([sender.id, 201]) }),
        mismatched.api,
      ),
    ).toMatchObject({ status: "rejected", phase: "rejected_actor" })
  })

  test.each([
    ["zero matches", []],
    [
      "two matches",
      [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T10:00:00Z",
          label: "task",
          nodeId: "LE_one",
        },
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T10:00:00Z",
          label: "task",
          nodeId: "LE_two",
        },
      ],
    ],
    [
      "actor mismatch",
      [
        {
          actor: { id: 999, login: "attacker", type: "User" },
          createdAt: "2026-07-16T10:00:00Z",
          label: "task",
          nodeId: "LE_wrong",
        },
      ],
    ],
    [
      "time mismatch",
      [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T09:59:59Z",
          label: "task",
          nodeId: "LE_wrong",
        },
      ],
    ],
  ] satisfies Array<[string, GitHubLabeledEvent[]]>)(
    "rejects ambiguous timeline identity: %s",
    async (_name, labeledEvents) => {
      const github = fakeGitHub({ labeledEvents })
      expect(await admitIssue(input(event()), github.api)).toMatchObject({
        status: "rejected",
        phase: "ambiguous_label",
      })
      expect(github.state.writes).toEqual([])
    },
  )

  test("produces a stable key for a replay and a different key for a new timeline node", async () => {
    const first = fakeGitHub()
    const firstResult = admitted(await admitIssue(input(await fixture("replayed-labeled")), first.api))
    const replay = fakeGitHub()
    const replayResult = admitted(await admitIssue(input(await fixture("replayed-labeled")), replay.api))
    expect(replayResult.key).toBe(firstResult.key)

    const relabel = fakeGitHub({
      labeledEvents: [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T11:00:00Z",
          label: "task",
          nodeId: "LE_relabel",
        },
      ],
    })
    const relabelResult = admitted(
      await admitIssue(input(event({ updatedAt: "2026-07-16T11:00:00Z", labelId: 501 }), { runId: 801 }), relabel.api),
    )
    expect(relabelResult.key).not.toBe(firstResult.key)
  })
})

describe("durable marker state", () => {
  test("round trips only the canonical marker form", () => {
    const marker: IssueMarker = {
      attempt: 2,
      key: markerKey,
      phase: "pr_opened",
      prId: 123,
      runId: 800,
      updatedAt: now.toISOString(),
    }
    expect(parseIssueMarker(formatIssueMarker(marker))).toEqual(marker)
    expect(
      parseIssueMarker(formatIssueMarker(marker).replace('"attempt":2,"key"', '"key":"x","attempt":2,"key"')),
    ).toBeUndefined()
    expect(parseIssueMarker(`${formatIssueMarker(marker)}\nuntrusted text`)).toBeUndefined()
  })

  test("ignores an attacker-owned marker but rejects malformed or multiple bot-owned markers", async () => {
    const attacker = fakeGitHub({
      comments: [
        {
          id: 600,
          userId: 666,
          body: formatIssueMarker({
            attempt: 1,
            key: markerKey,
            phase: "running",
            runId: 1,
            updatedAt: now.toISOString(),
          }),
        },
      ],
    })
    expect(await admitIssue(input(event()), attacker.api)).toMatchObject({ status: "admitted" })
    expect(attacker.state.writes).toHaveLength(1)

    const malformed = fakeGitHub({
      comments: [{ id: 601, userId: botId, body: "<!-- oc2-issue-state:v1 attacker-controlled -->" }],
    })
    const malformedError = admitIssue(input(event()), malformed.api).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await malformedError).toBe("malformed bot-owned issue marker")

    const canonical = formatIssueMarker({
      attempt: 1,
      key: markerKey,
      phase: "running",
      runId: 1,
      updatedAt: now.toISOString(),
    })
    const multiple = fakeGitHub({
      comments: [
        { id: 602, userId: botId, body: canonical },
        { id: 603, userId: botId, body: canonical },
      ],
    })
    const multipleError = admitIssue(input(event()), multiple.api).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await multipleError).toBe("multiple bot-owned issue markers")
  })

  test.each(["running", "pr_opened", "auto_merge_enabled", "no_changes"] as const)(
    "treats %s for the same key as a duplicate without rewriting",
    async (phase) => {
      const initial = fakeGitHub()
      const admission = admitted(await admitIssue(input(event()), initial.api))
      initial.state.comments[0] = {
        id: admission.marker.commentId,
        userId: botId,
        body: formatIssueMarker({ attempt: 1, key: admission.key, phase, runId: 800, updatedAt: now.toISOString() }),
      }
      initial.state.writes.length = 0
      expect(await admitIssue(input(await fixture("replayed-labeled")), initial.api)).toEqual({
        version: 1,
        status: "duplicate",
        phase: "duplicate",
        key: admission.key,
      })
      expect(initial.state.writes).toEqual([])
    },
  )

  test("allows a failed same-run higher attempt after validating the recorded attempt", async () => {
    const github = fakeGitHub()
    const first = admitted(await admitIssue(input(event()), github.api))
    github.state.comments[0] = {
      id: first.marker.commentId,
      userId: botId,
      body: formatIssueMarker({
        attempt: 1,
        key: first.key,
        phase: "model_failed",
        runId: 800,
        updatedAt: "2026-07-16T10:30:00.000Z",
      }),
    }
    github.state.actionsRuns.set("800/1", {
      id: 800,
      attempt: 1,
      status: "completed",
      conclusion: "failure",
      updatedAt: "2026-07-16T10:31:00.000Z",
    })
    github.state.writes.length = 0
    const retried = admitted(await admitIssue(input(event(), { runAttempt: 2 }), github.api))
    expect(retried.run).toEqual({ id: 800, attempt: 2 })
    expect(github.state.writes).toEqual([{ method: "update", body: github.state.comments[0]?.body }])
  })

  test("rejects the same key replayed under a different run even after failure", async () => {
    const github = fakeGitHub()
    const first = admitted(await admitIssue(input(event()), github.api))
    github.state.comments[0] = {
      id: first.marker.commentId,
      userId: botId,
      body: formatIssueMarker({
        attempt: 1,
        key: first.key,
        phase: "model_failed",
        runId: 800,
        updatedAt: "2026-07-16T10:30:00.000Z",
      }),
    }
    github.state.actionsRuns.set("800/1", {
      id: 800,
      attempt: 1,
      status: "completed",
      conclusion: "failure",
      updatedAt: "2026-07-16T10:31:00.000Z",
    })
    github.state.writes.length = 0
    expect(await admitIssue(input(event(), { runId: 999, runAttempt: 1 }), github.api)).toMatchObject({
      status: "duplicate",
    })
    expect(github.state.writes).toEqual([])
  })

  test("reclaims a stale same-run marker only beyond timeout plus fixed grace", async () => {
    const github = fakeGitHub()
    const first = admitted(await admitIssue(input(event()), github.api))
    github.state.comments[0] = {
      id: first.marker.commentId,
      userId: botId,
      body: formatIssueMarker({
        attempt: 1,
        key: first.key,
        phase: "running",
        runId: 800,
        updatedAt: "2026-07-16T05:30:01.000Z",
      }),
    }
    github.state.writes.length = 0
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "duplicate" })
    expect(github.state.writes).toEqual([])

    github.state.comments[0] = {
      id: first.marker.commentId,
      userId: botId,
      body: formatIssueMarker({
        attempt: 1,
        key: first.key,
        phase: "running",
        runId: 800,
        updatedAt: "2026-07-16T05:29:59.000Z",
      }),
    }
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "admitted" })
    expect(github.state.writes).toHaveLength(1)
  })

  test("a recently updated active Actions run prevents stale recovery", async () => {
    const github = fakeGitHub()
    const first = admitted(await admitIssue(input(event()), github.api))
    github.state.comments[0] = {
      id: first.marker.commentId,
      userId: botId,
      body: formatIssueMarker({
        attempt: 1,
        key: first.key,
        phase: "running",
        runId: 800,
        updatedAt: "2026-07-16T01:00:00.000Z",
      }),
    }
    github.state.actionsRuns.set("800/1", {
      id: 800,
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      updatedAt: "2026-07-16T11:59:00.000Z",
    })
    github.state.writes.length = 0
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "duplicate" })
    expect(github.state.writes).toEqual([])
  })

  test("rejects relabeling while an exact App-owned issue PR is open", async () => {
    const oldMarker = formatIssueMarker({
      attempt: 1,
      key: markerKey,
      phase: "verification_failed",
      runId: 700,
      updatedAt: "2026-07-16T10:00:00.000Z",
    })
    const github = fakeGitHub({
      comments: [{ id: 600, userId: botId, body: oldMarker }],
      labeledEvents: [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T11:00:00Z",
          label: "task",
          nodeId: "LE_relabel",
        },
      ],
      pullRequests: [{ id: 99, userId: botId, headRepositoryId: 1234, headRef: "oc2/issue-42-abcdef012345" }],
    })
    github.state.actionsRuns.set("700/1", {
      id: 700,
      attempt: 1,
      status: "completed",
      conclusion: "failure",
      updatedAt: "2026-07-16T10:01:00.000Z",
    })
    expect(
      await admitIssue(input(event({ updatedAt: "2026-07-16T11:00:00Z" }), { runId: 801 }), github.api),
    ).toMatchObject({ status: "duplicate" })
    expect(github.state.writes).toEqual([])
  })

  test("status update uses key, run, attempt, bot ownership, and read-back CAS", async () => {
    const github = fakeGitHub()
    const admission = admitted(await admitIssue(input(event()), github.api))
    const updated = await updateIssueMarker(
      { admission, botId, phase: "pr_opened", prId: 123, now: new Date("2026-07-16T12:30:00.000Z") },
      github.api,
    )
    expect(updated).toMatchObject({ key: admission.key, runId: 800, attempt: 1, phase: "pr_opened", prId: 123 })

    github.state.comments[0] = {
      id: admission.marker.commentId,
      userId: botId,
      body: formatIssueMarker({
        attempt: 2,
        key: admission.key,
        phase: "running",
        runId: 800,
        updatedAt: now.toISOString(),
      }),
    }
    const casError = updateIssueMarker({ admission, botId, phase: "model_failed", now }, github.api).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await casError).toBe("marker compare-and-swap failed")
  })
})

describe("native fetch GitHub client and CLI", () => {
  test("strictly decodes API responses without exposing raw response content", async () => {
    const api = createGitHubApi({
      token: "token",
      repository: "octo/oc2",
      fetch: async () => new Response('{"id":"TOP_SECRET_API_RESPONSE"}', { status: 200 }),
    })
    const failure = api.getRepository().then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await failure).not.toContain("TOP_SECRET_API_RESPONSE")
  })

  test("uses bounded page-number pagination and fetches the page after an exact full page", async () => {
    const pages: number[] = []
    const api = createGitHubApi({
      token: "token",
      repository: "octo/oc2",
      fetch: async (request) => {
        const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
        const page = Number(url.searchParams.get("page"))
        pages.push(page)
        const values = page === 1 ? Array.from({ length: 100 }, () => ({ event: "renamed" })) : []
        return Response.json(values)
      },
    })
    expect(await api.listLabeledEvents(42)).toEqual([])
    expect(pages).toEqual([1, 2])
  })

  test.each([
    [
      "a looping next link",
      Array.from({ length: 100 }, () => ({ event: "renamed" })),
      '<https://api.github.com/repos/octo/oc2/issues/42/timeline?per_page=100&page=1>; rel="next"',
    ],
    [
      "a next link on a partial page",
      [{ event: "renamed" }],
      '<https://api.github.com/repos/octo/oc2/issues/42/timeline?per_page=100&page=2>; rel="next"',
    ],
  ])("rejects incomplete pagination signaled by %s", async (_name, body, link) => {
    const api = createGitHubApi({
      token: "token",
      repository: "octo/oc2",
      fetch: async () => Response.json(body, { headers: { Link: link } }),
    })
    const failure = api.listLabeledEvents(42).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await failure).toBe("invalid GitHub API pagination")
  })

  test("CLI writes only the bounded admission artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc2-issue-cli-"))
    const eventFile = join(root, "event.json")
    const resultFile = join(root, "admission.json")
    await Bun.write(eventFile, JSON.stringify(await fixture("hostile-labeled")))
    let markerBody = ""
    const fetcher: GitHubFetch = async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
      const method = init?.method ?? "GET"
      if (url.pathname === "/users/maintainer") return Response.json({ id: 100, login: "maintainer", type: "User" })
      if (url.pathname.endsWith("/collaborators/maintainer/permission")) return Response.json({ permission: "write" })
      if (url.pathname.endsWith("/timeline"))
        return Response.json([
          {
            event: "labeled",
            node_id: "LE_label42",
            created_at: "2026-07-16T10:00:00Z",
            actor: { id: 100, login: "maintainer", type: "User" },
            label: { name: "task" },
          },
        ])
      if (url.pathname === "/repos/octo/oc2")
        return Response.json({ id: 1234, full_name: "octo/oc2", default_branch: "main" })
      if (url.pathname.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: baseSha } })
      if (url.pathname.endsWith("/pulls")) return Response.json([])
      if (url.pathname.endsWith("/issues/42/comments") && method === "POST") {
        if (typeof init?.body !== "string") throw new Error("invalid marker request body")
        const body: unknown = JSON.parse(init.body)
        if (typeof body !== "object" || body === null || !("body" in body) || typeof body.body !== "string")
          throw new Error("invalid marker request")
        markerBody = body.body
        return Response.json({ id: 700, body: markerBody, user: { id: botId } })
      }
      if (url.pathname.endsWith("/issues/42/comments"))
        return Response.json(markerBody ? [{ id: 700, body: markerBody, user: { id: botId } }] : [])
      if (url.pathname.endsWith("/issues/comments/700"))
        return Response.json({ id: 700, body: markerBody, user: { id: botId } })
      throw new Error(`unexpected safe test route ${method} ${url.pathname}`)
    }
    const code = await main(
      ["admit", "--event-file", eventFile, "--result-file", resultFile, "--bot-id", String(botId)],
      {
        now,
        fetch: fetcher,
        env: {
          GITHUB_API_URL: "https://api.github.test",
          GITHUB_REPOSITORY: "octo/oc2",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "800",
          GITHUB_TOKEN: "TOP_SECRET_TOKEN",
          GITHUB_TRIGGERING_ACTOR: "maintainer",
        },
      },
    )
    expect(code).toBe(0)
    const output = await Bun.file(resultFile).text()
    expect(output).toContain('"status":"admitted"')
    expect(output).not.toContain("TOP_SECRET_BODY")
    expect(output).not.toContain("TOP_SECRET_TOKEN")
    await rm(root, { recursive: true, force: true })
  })
})
