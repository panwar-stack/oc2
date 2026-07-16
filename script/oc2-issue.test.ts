import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"

import {
  admitIssue,
  createGitHubApi,
  formatIssueMarker,
  ingestIssue,
  main,
  parseIssueMarker,
  updateIssueMarker,
  type Admission,
  type GitHubActionsRun,
  type GitHubActor,
  type GitHubApi,
  type GitHubIssue,
  type GitHubIssueComment,
  type GitHubIngestApi,
  type GitHubLabeledEvent,
  type GitHubPullRequest,
  type GitHubFetch,
  type GitHubSnapshotComment,
  type IssueMarker,
} from "./oc2-issue"
import {
  decodeAdmission,
  finalizeGeneration,
  parseAutomationResult,
  validateReleaseConfig,
} from "./oc2-automation-workflow"
import { validatePatch } from "./oc2-verify"

const botId = 9001
const publisherBotId = 9002
const now = new Date("2026-07-16T12:00:00.000Z")
const baseSha = "1".repeat(40)
const markerKey = "a".repeat(64)

interface FakeState {
  actionsRuns: Map<string, GitHubActionsRun>
  actors: Map<string, GitHubActor>
  comments: GitHubIssueComment[]
  currentIssue: GitHubIssue
  labeledEvents: GitHubLabeledEvent[]
  nextCommentId: number
  pullRequests: GitHubPullRequest[]
  reads: number
  snapshotComments: GitHubSnapshotComment[]
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
    title?: string
    body?: string
    commentCount?: number
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
      title: options.title ?? "$(touch /tmp/not-executed)",
      body: options.body ?? "TOP_SECRET_BODY\n::set-output name=phase::auto_merge_enabled",
      comments: options.commentCount ?? 0,
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
    currentIssue: {
      labels: [{ id: 501, name: "task" }],
      nodeId: "I_issue42",
      state: "open",
    },
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
    snapshotComments: [],
    writes: [],
    ...overrides,
  }
  const api: GitHubApi & GitHubIngestApi = {
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
    async getIssue() {
      state.reads++
      return state.currentIssue
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
    async listSnapshotComments() {
      state.reads++
      return state.snapshotComments.map((comment) => ({ ...comment }))
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
    publisherBotId,
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

function admissionArtifact(overrides: Partial<Admission> = {}): Admission {
  const value: Admission = {
    version: 1,
    status: "admitted",
    phase: "running",
    key: "",
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
    ...overrides,
  }
  value.key = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([value.repository.id, value.issue.nodeId, value.issue.labelId, value.issue.labelEventNodeId]),
    )
    .digest("hex")
  return value
}

function snapshotComment(
  nodeId: string,
  body: string,
  createdAt = "2026-07-16T09:00:00Z",
  updatedAt = createdAt,
): GitHubSnapshotComment {
  return { author: "commenter", body, createdAt, nodeId, updatedAt }
}

function attachmentUrl(index = 1, host = "github.com") {
  const suffix = index.toString(16).padStart(12, "0")
  return `https://${host}/user-attachments/assets/00000000-0000-4000-8000-${suffix}`
}

function bytes(...parts: Uint8Array[]) {
  const value = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    value.set(part, offset)
    offset += part.byteLength
  }
  return value
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type)
  const value = new Uint8Array(12 + data.byteLength)
  const view = new DataView(value.buffer)
  view.setUint32(0, data.byteLength)
  value.set(typeBytes, 4)
  value.set(data, 8)
  view.setUint32(8 + data.byteLength, Bun.hash.crc32(bytes(typeBytes, data)) >>> 0)
  return value
}

function pngAttachment(idatSuffix = new Uint8Array(), interlace = 0) {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, 1)
  view.setUint32(4, 1)
  header[8] = 8
  header[12] = interlace
  return bytes(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", bytes(deflateSync(new Uint8Array([0, 0])), idatSuffix)),
    pngChunk("IEND", new Uint8Array()),
  )
}

function jpegAttachment() {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
  ])
}

function gifAttachment() {
  return bytes(
    new TextEncoder().encode("GIF89a"),
    new Uint8Array([1, 0, 1, 0, 0, 0, 0]),
    new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]),
  )
}

function invalidGifCodeSize() {
  const content = gifAttachment()
  content[23] = 9
  return content
}

function webpAttachment() {
  return webpFile(webpChunk("VP8L", new Uint8Array([0x2f, 0, 0, 0, 0, 0])))
}

function webpChunk(type: string, data: Uint8Array) {
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, data.byteLength, true)
  return bytes(new TextEncoder().encode(type), size, data, data.byteLength % 2 ? new Uint8Array(1) : new Uint8Array())
}

function webpFile(...chunks: Uint8Array[]) {
  const payload = bytes(new TextEncoder().encode("WEBP"), ...chunks)
  const size = new Uint8Array(4)
  new DataView(size.buffer).setUint32(0, payload.byteLength, true)
  return bytes(new TextEncoder().encode("RIFF"), size, payload)
}

function extendedWebpAttachment() {
  return webpFile(
    webpChunk("VP8X", new Uint8Array([0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    webpChunk("VP8L", new Uint8Array([0x2f, 0, 0, 0, 0, 0])),
    webpChunk("EXIF", new Uint8Array([1])),
  )
}

function animatedWebpAttachment() {
  return webpFile(
    webpChunk("VP8X", new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    webpChunk("ANIM", new Uint8Array(6)),
    webpChunk("ANMF", bytes(new Uint8Array(16), webpChunk("VP8L", new Uint8Array([0x2f, 0, 0, 0, 0, 0])))),
  )
}

function requestHref(request: string | URL | Request) {
  return typeof request === "string" ? request : request instanceof URL ? request.href : request.url
}

async function ingestFixture(
  options: {
    title?: string
    body?: string
    comments?: GitHubSnapshotComment[]
    commentCount?: number
    fetch?: GitHubFetch
    bundleDir?: string
    admission?: unknown
    eventValue?: unknown
    repository?: string
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "oc2-issue-ingest-"))
  const bundleDir = options.bundleDir ?? join(root, "bundle")
  const github = fakeGitHub({ snapshotComments: options.comments ?? [] })
  try {
    const result = await ingestIssue(
      {
        admission: options.admission ?? admissionArtifact(),
        bundleDir,
        bundleRoot: root,
        checkoutDir: import.meta.dir,
        repository: options.repository ?? "octo/oc2",
        event:
          options.eventValue ??
          event({
            title: options.title ?? "Safe issue",
            body: options.body ?? "Safe body",
            commentCount: options.commentCount ?? options.comments?.length ?? 0,
          }),
      },
      github.api,
      options.fetch ?? (async () => new Response("attachment")),
    )
    return { bundleDir, github, result, root }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
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

  test.each([
    ["closed", { labels: [{ id: 501, name: "task" }], nodeId: "I_issue42", state: "closed" }],
    ["unlabeled", { labels: [], nodeId: "I_issue42", state: "open" }],
    [
      "ambiguously labeled",
      {
        labels: [
          { id: 501, name: "task" },
          { id: 502, name: "feature" },
        ],
        nodeId: "I_issue42",
        state: "open",
      },
    ],
    ["identity changed", { labels: [{ id: 501, name: "task" }], nodeId: "I_replaced", state: "open" }],
  ] satisfies Array<[string, GitHubIssue]>)(
    "rejects a currently %s issue even when the webhook was admissible",
    async (_name, currentIssue) => {
      const github = fakeGitHub({ currentIssue })
      expect(await admitIssue(input(event()), github.api)).toMatchObject({
        status: "rejected",
        phase: "ambiguous_label",
      })
      expect(github.state.writes).toEqual([])
    },
  )

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
    github.state.actionsRuns.set("800/1", {
      id: 800,
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      updatedAt: "2026-07-16T05:30:01.000Z",
    })
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
    github.state.actionsRuns.set("800/1", {
      id: 800,
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      updatedAt: "2026-07-16T05:29:59.000Z",
    })
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "admitted" })
    expect(github.state.writes).toHaveLength(1)
  })

  test("does not reclaim a stale running marker when the exact run attempt is unavailable", async () => {
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
    github.state.writes.length = 0
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "duplicate" })
    expect(github.state.writes).toEqual([])
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

  test("does not recover a failed marker without an exact failed run, even after the stale window", async () => {
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
        updatedAt: "2026-07-16T01:00:00.000Z",
      }),
    }
    github.state.writes.length = 0
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "duplicate" })
    expect(github.state.writes).toEqual([])
  })

  test("never reclaims a recorded successful run based on age", async () => {
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
      status: "completed",
      conclusion: "success",
      updatedAt: "2026-07-16T01:01:00.000Z",
    })
    github.state.writes.length = 0
    expect(await admitIssue(input(event(), { runAttempt: 2 }), github.api)).toMatchObject({ status: "duplicate" })
    expect(github.state.writes).toEqual([])
  })

  test("permits a new relabel key after completed work when no publisher App PR is open", async () => {
    const github = fakeGitHub({
      comments: [
        {
          id: 600,
          userId: botId,
          body: formatIssueMarker({
            attempt: 1,
            key: markerKey,
            phase: "no_changes",
            runId: 700,
            updatedAt: "2026-07-16T10:00:00.000Z",
          }),
        },
      ],
      labeledEvents: [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T11:00:00Z",
          label: "task",
          nodeId: "LE_relabel",
        },
      ],
    })
    expect(
      await admitIssue(input(event({ updatedAt: "2026-07-16T11:00:00Z" }), { runId: 801 }), github.api),
    ).toMatchObject({ status: "admitted" })
    expect(github.state.writes).toHaveLength(1)
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
      pullRequests: [{ id: 99, userId: publisherBotId, headRepositoryId: 1234, headRef: "oc2/issue-42-abcdef012345" }],
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

  test("does not confuse the marker bot with the publishing App PR owner", async () => {
    const github = fakeGitHub({
      comments: [
        {
          id: 600,
          userId: botId,
          body: formatIssueMarker({
            attempt: 1,
            key: markerKey,
            phase: "verification_failed",
            runId: 700,
            updatedAt: "2026-07-16T10:00:00.000Z",
          }),
        },
      ],
      labeledEvents: [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T11:00:00Z",
          label: "task",
          nodeId: "LE_relabel",
        },
      ],
      pullRequests: [{ id: 99, userId: botId, headRepositoryId: 1234, headRef: "oc2/issue-42-not-the-app" }],
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
    ).toMatchObject({ status: "admitted" })
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

describe("deterministic issue ingestion", () => {
  test("uses the exact cutoff, detects complete history, and sorts immutable comments", async () => {
    const comments = [
      snapshotComment("IC_z", "second", "2026-07-16T09:00:00Z"),
      snapshotComment("IC_future", "future", "2026-07-16T10:00:01Z"),
      snapshotComment("IC_edited", `![late](${attachmentUrl()})`, "2026-07-16T08:00:00Z", "2026-07-16T10:00:01Z"),
      snapshotComment("IC_a", "first", "2026-07-16T09:00:00Z"),
    ]
    let fetches = 0
    const fixture = await ingestFixture({
      title: "Title",
      body: "Body",
      comments,
      commentCount: 3,
      fetch: async () => {
        fetches++
        return new Response("unexpected")
      },
    })
    expect(fixture.result).toEqual({
      version: 1,
      status: "ok",
      issuePath: "issue.json",
      attachmentCount: 0,
      attachmentBytes: 0,
    })
    expect(fetches).toBe(0)
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(Object.keys(snapshot)).toEqual(["repository", "issue", "comments", "attachments"])
    expect(snapshot.comments).toEqual([
      snapshotComment("IC_a", "first", "2026-07-16T09:00:00Z"),
      snapshotComment("IC_z", "second", "2026-07-16T09:00:00Z"),
    ])
    expect(await Bun.file(join(fixture.bundleDir, "issue.json")).text()).toEndWith("\n")
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("applies the specified inclusive cutoff to creation and update timestamps", async () => {
    const comment = snapshotComment("IC_cutoff", "included at cutoff", "2026-07-16T10:00:00Z", "2026-07-16T10:00:00Z")
    const fixture = await ingestFixture({ comments: [comment] })
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(snapshot.comments).toEqual([
      {
        nodeId: "IC_cutoff",
        author: "commenter",
        createdAt: "2026-07-16T10:00:00Z",
        updatedAt: "2026-07-16T10:00:00Z",
        body: "included at cutoff",
      },
    ])
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("fails closed when comment pagination or visibility is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc2-issue-incomplete-"))
    const github = fakeGitHub({ snapshotComments: [snapshotComment("IC_one", "one")] })
    const failure = ingestIssue(
      {
        admission: admissionArtifact(),
        bundleDir: join(root, "bundle"),
        bundleRoot: root,
        checkoutDir: import.meta.dir,
        repository: "octo/oc2",
        event: event({ title: "Title", body: "Body", commentCount: 2 }),
      },
      github.api,
    ).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await failure).toBe("incomplete issue comment snapshot")
    expect(await Bun.file(join(root, "bundle")).exists()).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("admits exactly 100 comments and stops at 101", async () => {
    const hundred = Array.from({ length: 100 }, (_, index) =>
      snapshotComment(`IC_${index.toString().padStart(3, "0")}`, "x"),
    )
    const accepted = await ingestFixture({ comments: hundred })
    expect(accepted.result.status).toBe("ok")
    await rm(accepted.root, { recursive: true, force: true })

    const rejected = await ingestFixture({
      comments: [...hundred, snapshotComment("IC_100", "x")],
      commentCount: 101,
    })
    expect(rejected.result).toEqual({ version: 1, status: "stopped", phase: "input_too_large" })
    expect(await Bun.file(rejected.bundleDir).exists()).toBe(false)
    await rm(rejected.root, { recursive: true, force: true })
  })

  test("counts combined UTF-8 bytes without truncating multibyte text", async () => {
    const exact = await ingestFixture({ title: "é".repeat(256 * 1024), body: "" })
    expect(exact.result.status).toBe("ok")
    const exactSnapshot = JSON.parse(await Bun.file(join(exact.bundleDir, "issue.json")).text())
    expect(exactSnapshot.issue.title).toHaveLength(256 * 1024)
    await rm(exact.root, { recursive: true, force: true })

    const oversized = await ingestFixture({ title: `${"é".repeat(256 * 1024)}x`, body: "" })
    expect(oversized.result).toEqual({ version: 1, status: "stopped", phase: "input_too_large" })
    expect(await Bun.file(oversized.bundleDir).exists()).toBe(false)
    await rm(oversized.root, { recursive: true, force: true })
  })

  test("rejects mutable identities, event bindings, and malformed Unicode", async () => {
    const invalidAdmissions = [
      { ...admissionArtifact(), key: "a".repeat(64) },
      { ...admissionArtifact(), issue: { ...admissionArtifact().issue, cutoff: "2026-07-16T09:59:59Z" } },
    ]
    for (const admission of invalidAdmissions) {
      const failure = ingestFixture({ admission }).then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(await failure).toMatch(/invalid admission|event does not match admission/)
    }
    const malformed = ingestFixture({ title: "\ud800" }).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await malformed).toBe("invalid Unicode text")

    const wrongRepository = ingestFixture({ repository: "attacker/repository" }).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await wrongRepository).toBe("event does not match admission")
  })

  test("normalizes a null body and permits unrelated labels", async () => {
    const value = event({ issueLabels: ["task", "bug"], title: "Title", body: "unused", commentCount: 0 })
    const fixture = await ingestFixture({ eventValue: { ...value, issue: { ...value.issue, body: null } } })
    expect(fixture.result.status).toBe("ok")
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(snapshot.issue.body).toBe("")
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("requires the exact admitted timeline node before reading attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc2-issue-timeline-"))
    const github = fakeGitHub({
      labeledEvents: [
        {
          actor: { id: 100, login: "maintainer", type: "User" },
          createdAt: "2026-07-16T10:00:00Z",
          label: "task",
          nodeId: "LE_changed",
        },
      ],
    })
    let fetches = 0
    const failure = ingestIssue(
      {
        admission: admissionArtifact(),
        bundleDir: join(root, "bundle"),
        bundleRoot: root,
        checkoutDir: import.meta.dir,
        repository: "octo/oc2",
        event: event({ title: `![x](${attachmentUrl()})`, body: "", commentCount: 0 }),
      },
      github.api,
      async () => {
        fetches++
        return new Response("x")
      },
    ).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await failure).toBe("admitted label event changed")
    expect(fetches).toBe(0)
    await rm(root, { recursive: true, force: true })
  })
})

describe("bounded attachment ingestion", () => {
  test("extracts admitted Markdown, HTML, and bare attachment destinations only", async () => {
    const urls = [attachmentUrl(1), attachmentUrl(2), attachmentUrl(3)]
    const requested: string[] = []
    const fixture = await ingestFixture({
      body: [
        `[download](${urls[0]})`,
        `<img alt="asset" src="${urls[1]}">`,
        urls[2],
        "[ordinary reference](https://example.com/docs)",
      ].join("\n"),
      fetch: async (request) => {
        requested.push(requestHref(request))
        return new Response("same")
      },
    })
    expect(requested).toEqual(urls)
    expect(fixture.result).toMatchObject({ status: "ok", attachmentCount: 1 })
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("accepts only exact current and legacy GitHub attachment URL forms", async () => {
    const urls = [
      attachmentUrl(1),
      "https://github.com/octo/oc2/assets/1234/safe-file.png",
      "https://user-images.githubusercontent.com/1234/5678-safe-file.png",
      "https://private-user-images.githubusercontent.com/1234/5679-safe-file.png",
    ]
    const requests: string[] = []
    const fixture = await ingestFixture({
      body: urls.map((url) => `![asset](${url})`).join("\n"),
      fetch: async (request) => {
        requests.push(requestHref(request))
        return new Response("same decoded content", { headers: { "Content-Type": "application/octet-stream" } })
      },
    })
    expect(fixture.result).toMatchObject({ status: "ok", attachmentCount: 1 })
    expect(requests).toEqual(urls)
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(snapshot.attachments).toHaveLength(1)
    expect(snapshot.attachments[0]).toMatchObject({
      sourceUrl: urls[0],
      mediaType: "text/plain",
      path: `attachments/${snapshot.attachments[0].sha256}.txt`,
    })
    await rm(fixture.root, { recursive: true, force: true })
  })

  test.each([
    ["HTTP", attachmentUrl().replace("https:", "http:")],
    ["userinfo", attachmentUrl().replace("https://", "https://user:pass@")],
    ["non-443 port", attachmentUrl().replace("github.com", "github.com:444")],
    ["fragment", `${attachmentUrl()}#fragment`],
    ["source query", `${attachmentUrl()}?token=private`],
    ["lookalike host", attachmentUrl().replace("github.com", "github.com.attacker.test")],
    ["encoded slash", attachmentUrl().replace("/assets/", "/assets%2f")],
    ["dot segment", attachmentUrl().replace("/user-attachments/", "/repo/../user-attachments/")],
    ["unknown GitHub path", "https://github.com/octo/oc2/issues/1"],
    ["private signed source", "https://private-user-images.githubusercontent.com/1234/5678-file.png?jwt=secret"],
    ["relative image", "/uploads/private.png"],
    ["external image", "https://example.com/private.png"],
  ])("rejects %s without issuing a request", async (_name, url) => {
    let requests = 0
    const fixture = await ingestFixture({
      body: `![asset](${url})`,
      fetch: async () => {
        requests++
        return new Response("unexpected")
      },
    })
    expect(fixture.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    expect(requests).toBe(0)
    expect(await Bun.file(fixture.bundleDir).exists()).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("allows at most three redirects and strips credentials on every hop", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const fixture = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async (request, init) => {
        const url = requestHref(request)
        seen.push({ url, init })
        if (seen.length <= 3)
          return new Response(null, {
            status: 302,
            headers: { Location: `https://objects.githubusercontent.com/object/${seen.length}?signature=private` },
          })
        return new Response(pngAttachment())
      },
    })
    expect(fixture.result).toMatchObject({
      status: "ok",
      attachmentCount: 1,
      attachmentBytes: pngAttachment().byteLength,
    })
    expect(seen).toHaveLength(4)
    for (const request of seen) {
      const headers = new Headers(request.init?.headers)
      expect(headers.has("authorization")).toBe(false)
      expect(headers.has("cookie")).toBe(false)
      expect(headers.get("accept-encoding")).toBe("identity")
      expect(request.init?.credentials).toBe("omit")
      expect(request.init?.redirect).toBe("manual")
      expect(request.init?.referrerPolicy).toBe("no-referrer")
    }
    const output = await Bun.file(join(fixture.bundleDir, "issue.json")).text()
    expect(output).not.toContain("signature=private")
    await rm(fixture.root, { recursive: true, force: true })

    let redirects = 0
    const tooMany = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { Location: `https://objects.githubusercontent.com/object/${++redirects}` },
        }),
    })
    expect(tooMany.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    await rm(tooMany.root, { recursive: true, force: true })
  })

  test.each([
    ["redirect loop", attachmentUrl()],
    ["forbidden redirect host", "https://attacker.test/file"],
    ["redirect userinfo", "https://token@objects.githubusercontent.com/file"],
    ["redirect fragment", "https://objects.githubusercontent.com/file#secret"],
    ["redirect non-443 port", "https://objects.githubusercontent.com:8443/file"],
  ])("rejects %s and leaves no partial bundle", async (_name, location) => {
    const fixture = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async () => new Response(null, { status: 302, headers: { Location: location } }),
    })
    expect(fixture.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    expect(await Bun.file(fixture.bundleDir).exists()).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("rejects failed, missing, and incomplete downloads as a whole", async () => {
    const fetchers: GitHubFetch[] = [
      async () => {
        throw new Error("private network error")
      },
      async () => new Response("private response", { status: 404 }),
      async () => new Response(null, { status: 302 }),
      async () => new Response("partial", { status: 206 }),
      async () => new Response("partial", { headers: { "Content-Range": "bytes 0-6/100" } }),
      async () => new Response("x", { headers: { "Content-Length": "2" } }),
    ]
    for (const fetch of fetchers) {
      const fixture = await ingestFixture({
        body: `![first](${attachmentUrl(1)})\n![second](${attachmentUrl(2)})`,
        fetch,
      })
      expect(fixture.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
      expect(await Bun.file(fixture.bundleDir).exists()).toBe(false)
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test("rejects compressed and oversized decoded bodies", async () => {
    const compressed = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async () => new Response("decoded", { headers: { "Content-Encoding": "gzip" } }),
    })
    expect(compressed.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    await rm(compressed.root, { recursive: true, force: true })

    const declared = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async () => new Response("x", { headers: { "Content-Length": String(5 * 1024 * 1024 + 1) } }),
    })
    expect(declared.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    await rm(declared.root, { recursive: true, force: true })

    const streamed = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(5 * 1024 * 1024))
              controller.enqueue(new Uint8Array([1]))
              controller.close()
            },
          }),
        ),
    })
    expect(streamed.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    expect(await Bun.file(streamed.bundleDir).exists()).toBe(false)
    await rm(streamed.root, { recursive: true, force: true })
  })

  test("uses one 30 second abort deadline for an attachment", async () => {
    const originalSetTimeout = globalThis.setTimeout
    const delays: number[] = []
    const immediateTimeout = Object.assign(
      <TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay?: number, ...args: TArgs) => {
        delays.push(delay ?? 0)
        return originalSetTimeout(callback, 0, ...args)
      },
      { __promisify__: originalSetTimeout.__promisify__ },
    )
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(immediateTimeout)
    try {
      const fixture = await ingestFixture({
        body: `![asset](${attachmentUrl()})`,
        fetch: async (_request, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("private timeout response")), { once: true })
          }),
      })
      expect(delays).toContain(30_000)
      expect(fixture.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
      await rm(fixture.root, { recursive: true, force: true })
    } finally {
      timeout.mockRestore()
    }
  })

  test("deduplicates hashes, sorts paths, and rejects a sixth unique file", async () => {
    const duplicate = await ingestFixture({
      body: `![one](${attachmentUrl(1)})\n![two](${attachmentUrl(2)})`,
      fetch: async () => new Response("duplicate"),
    })
    expect(duplicate.result).toMatchObject({ status: "ok", attachmentCount: 1, attachmentBytes: 9 })
    await rm(duplicate.root, { recursive: true, force: true })

    const six = await ingestFixture({
      body: Array.from({ length: 6 }, (_, index) => `![${index}](${attachmentUrl(index + 1)})`).join("\n"),
      fetch: async (request) => new Response(new URL(requestHref(request)).pathname),
    })
    expect(six.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    expect(await Bun.file(six.bundleDir).exists()).toBe(false)
    await rm(six.root, { recursive: true, force: true })
  })

  test("rejects more than 20 MiB of unique decoded content", async () => {
    let index = 0
    const fixture = await ingestFixture({
      body: Array.from({ length: 5 }, (_, item) => `![${item}](${attachmentUrl(item + 1)})`).join("\n"),
      fetch: async () => {
        const content = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x61)
        content[content.byteLength - 1] = 0x30 + index++
        return new Response(content)
      },
    })
    expect(fixture.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    expect(await Bun.file(fixture.bundleDir).exists()).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("sniffs allowed bytes independently of names and declared MIME", async () => {
    const contents = [
      pngAttachment(),
      jpegAttachment(),
      gifAttachment(),
      webpAttachment(),
      new TextEncoder().encode('{"safe":true}'),
    ]
    let index = 0
    const fixture = await ingestFixture({
      body: contents.map((_, item) => `![${item}](${attachmentUrl(item + 1)})`).join("\n"),
      fetch: async () => new Response(contents[index++], { headers: { "Content-Type": "application/octet-stream" } }),
    })
    expect(fixture.result).toMatchObject({ status: "ok", attachmentCount: 5 })
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(snapshot.attachments.map((attachment: { mediaType: string }) => attachment.mediaType).sort()).toEqual(
      ["application/json", "image/gif", "image/jpeg", "image/png", "image/webp"].sort(),
    )
    expect(snapshot.attachments.map((attachment: { path: string }) => attachment.path)).toEqual(
      [...snapshot.attachments]
        .sort((left: { sha256: string }, right: { sha256: string }) => left.sha256.localeCompare(right.sha256))
        .map((attachment: { path: string }) => attachment.path),
    )
    await rm(fixture.root, { recursive: true, force: true })

    const markdown = await ingestFixture({
      body: `![asset](${attachmentUrl().replace(/-[0-9a-f]{12}$/, "-000000000099")})`,
      fetch: async () => new Response("# Markdown", { headers: { "Content-Type": "application/pdf" } }),
    })
    const markdownSnapshot = JSON.parse(await Bun.file(join(markdown.bundleDir, "issue.json")).text())
    expect(markdownSnapshot.attachments[0]).toMatchObject({ mediaType: "text/markdown" })
    expect(markdownSnapshot.attachments[0].path).toEndWith(".md")
    await rm(markdown.root, { recursive: true, force: true })

    const ignoredMime = await ingestFixture({
      body: `![asset](${attachmentUrl(100)})`,
      fetch: async () => new Response(pngAttachment(), { headers: { "Content-Type": "text/html" } }),
    })
    const ignoredMimeSnapshot = JSON.parse(await Bun.file(join(ignoredMime.bundleDir, "issue.json")).text())
    expect(ignoredMimeSnapshot.attachments[0]).toMatchObject({ mediaType: "image/png" })
    await rm(ignoredMime.root, { recursive: true, force: true })
  })

  test("accepts standard Adam7 and extended or animated WebP containers", async () => {
    const contents = [pngAttachment(new Uint8Array(), 1), extendedWebpAttachment(), animatedWebpAttachment()]
    let index = 0
    const fixture = await ingestFixture({
      body: contents.map((_, item) => `![${item}](${attachmentUrl(item + 101)})`).join("\n"),
      fetch: async () => new Response(contents[index++]),
    })
    expect(fixture.result).toMatchObject({ status: "ok", attachmentCount: 3 })
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(snapshot.attachments.map((attachment: { mediaType: string }) => attachment.mediaType).sort()).toEqual(
      ["image/png", "image/webp", "image/webp"].sort(),
    )
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("accepts CommonMark autolinks as deterministic Markdown text", async () => {
    const fixture = await ingestFixture({
      body: `![asset](${attachmentUrl(104)})`,
      fetch: async () => new Response("<https://example.com>"),
    })
    const snapshot = JSON.parse(await Bun.file(join(fixture.bundleDir, "issue.json")).text())
    expect(snapshot.attachments[0]).toMatchObject({ mediaType: "text/markdown" })
    await rm(fixture.root, { recursive: true, force: true })
  })

  test.each([
    ["SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null],
    ["HTML", new TextEncoder().encode("<!doctype html><html></html>"), "image/png"],
    ["PDF", new TextEncoder().encode("%PDF-1.7"), null],
    ["PDF after preamble", new TextEncoder().encode("safe preamble\n%PDF-1.7"), "text/plain"],
    ["archive", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), null],
    ["executable", new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), null],
    ["shebang", new TextEncoder().encode("#!/bin/sh"), null],
    ["malformed UTF-8", new Uint8Array([0xc3, 0x28]), "text/plain"],
    ["unknown control binary", new Uint8Array([0, 1, 2, 3]), "text/plain"],
    ["truncated PNG", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["image polyglot", bytes(pngAttachment(), new Uint8Array([0x50, 0x4b, 0x03, 0x04])), "image/png"],
    ["embedded PNG archive", pngAttachment(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), "image/png"],
    ["prolog SVG", new TextEncoder().encode("<?safe?> <!-- comment --> <svg></svg>"), "text/plain"],
    ["impossible GIF code size", invalidGifCodeSize(), "image/gif"],
  ])("rejects %s bytes regardless of extension or content type", async (_name, content, contentType) => {
    const fixture = await ingestFixture({
      body: `![asset](${attachmentUrl()})`,
      fetch: async () => new Response(content, contentType ? { headers: { "Content-Type": contentType } } : undefined),
    })
    expect(fixture.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    expect(await Bun.file(fixture.bundleDir).exists()).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("rejects malformed image syntax and more than 20 distinct candidates", async () => {
    const malformed = await ingestFixture({ body: `![asset](${attachmentUrl()}` })
    expect(malformed.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    await rm(malformed.root, { recursive: true, force: true })

    const excessive = await ingestFixture({
      body: Array.from({ length: 21 }, (_, index) => attachmentUrl(index + 1)).join("\n"),
    })
    expect(excessive.result).toEqual({ version: 1, status: "stopped", phase: "attachment_rejected" })
    await rm(excessive.root, { recursive: true, force: true })
  })

  test("requires a new bundle outside the checkout and preserves existing paths", async () => {
    const existingRoot = await mkdtemp(join(tmpdir(), "oc2-issue-existing-"))
    const existingBundle = join(existingRoot, "bundle")
    await mkdir(existingBundle)
    await Bun.write(join(existingBundle, "owned.txt"), "preserve")
    const existingFailure = ingestFixture({ bundleDir: existingBundle }).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await existingFailure).not.toBe("unexpected success")
    expect(await Bun.file(join(existingBundle, "owned.txt")).text()).toBe("preserve")
    await rm(existingRoot, { recursive: true, force: true })

    const inside = ingestIssue(
      {
        admission: admissionArtifact(),
        bundleDir: join(import.meta.dir, "forbidden-bundle"),
        bundleRoot: import.meta.dir,
        checkoutDir: import.meta.dir,
        repository: "octo/oc2",
        event: event({ title: "Title", body: "Body", commentCount: 0 }),
      },
      fakeGitHub().api,
    ).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await inside).toBe("issue bundle must be outside checkout")
    expect(await Bun.file(join(import.meta.dir, "forbidden-bundle")).exists()).toBe(false)
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

  test("rejects an oversized API response before decoding it", async () => {
    const api = createGitHubApi({
      token: "token",
      repository: "octo/oc2",
      fetch: async () => new Response("x", { headers: { "Content-Length": String(8 * 1024 * 1024 + 1) } }),
    })
    const failure = api.getRepository().then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await failure).toBe("GitHub API response too large")
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

  test("fully paginates and strictly decodes snapshot comments", async () => {
    const pages: number[] = []
    const api = createGitHubApi({
      token: "token",
      repository: "octo/oc2",
      fetch: async (request) => {
        const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url)
        const page = Number(url.searchParams.get("page"))
        pages.push(page)
        const count = page === 1 ? 100 : 1
        return Response.json(
          Array.from({ length: count }, (_, index) => ({
            node_id: `IC_${page}_${index}`,
            user: { login: "commenter" },
            created_at: "2026-07-16T09:00:00Z",
            updated_at: "2026-07-16T09:00:00Z",
            body: "body",
          })),
        )
      },
    })
    expect(await api.listSnapshotComments(42)).toHaveLength(101)
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
      if (url.pathname.endsWith("/issues/42"))
        return Response.json({
          node_id: "I_issue42",
          state: "open",
          labels: [{ id: 501, name: "task" }],
        })
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
      [
        "admit",
        "--event-file",
        eventFile,
        "--result-file",
        resultFile,
        "--bot-id",
        String(botId),
        "--publisher-bot-id",
        String(publisherBotId),
      ],
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

  test("CLI rejects result overlap and cleans its bundle when result publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc2-issue-result-cli-"))
    const eventFile = join(root, "event.json")
    const admissionFile = join(root, "admission.json")
    const bundleDir = join(root, "bundle")
    await Bun.write(eventFile, JSON.stringify(event({ title: "Title", body: "Body", commentCount: 0 })))
    await Bun.write(admissionFile, JSON.stringify(admissionArtifact()))
    const apiFetch: GitHubFetch = async (request) => {
      const requestUrl = new URL(requestHref(request))
      if (requestUrl.pathname.endsWith("/timeline"))
        return Response.json([
          {
            event: "labeled",
            node_id: "LE_label42",
            created_at: "2026-07-16T10:00:00Z",
            actor: { id: 100, login: "maintainer", type: "User" },
            label: { name: "task" },
          },
        ])
      if (requestUrl.pathname.endsWith("/comments")) return Response.json([])
      throw new Error("unexpected API route")
    }
    const run = (resultFile: string) =>
      main(
        [
          "ingest",
          "--event-file",
          eventFile,
          "--admission-file",
          admissionFile,
          "--bundle-dir",
          bundleDir,
          "--result-file",
          resultFile,
        ],
        {
          fetch: apiFetch,
          bundleRoot: root,
          checkoutDir: import.meta.dir,
          env: {
            GITHUB_API_URL: "https://api.github.test",
            GITHUB_REPOSITORY: "octo/oc2",
            GITHUB_TOKEN: "token",
          },
        },
      ).then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    expect(await run(join(bundleDir, "issue.json"))).toBe("ingestion result must be outside bundle")
    expect(await Bun.file(bundleDir).exists()).toBe(false)
    expect(await run(root)).toBe("failed to write ingestion result")
    expect(await Bun.file(bundleDir).exists()).toBe(false)
    await rm(root, { recursive: true, force: true })
  })

  test("CLI writes a safe ingest result and keeps attachment requests uncredentialed", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc2-issue-ingest-cli-"))
    const eventFile = join(root, "event.json")
    const admissionFile = join(root, "admission.json")
    const bundleDir = join(root, "bundle")
    const resultFile = join(root, "ingest.json")
    const url = attachmentUrl()
    await Bun.write(
      eventFile,
      JSON.stringify(event({ title: "PRIVATE_TITLE", body: `PRIVATE_BODY ![asset](${url})`, commentCount: 0 })),
    )
    await Bun.write(admissionFile, JSON.stringify(admissionArtifact()))
    const apiFetch: GitHubFetch = async (request, init) => {
      const requestUrl = new URL(
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
      )
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer TOP_SECRET_TOKEN")
      if (requestUrl.pathname.endsWith("/timeline"))
        return Response.json([
          {
            event: "labeled",
            node_id: "LE_label42",
            created_at: "2026-07-16T10:00:00Z",
            actor: { id: 100, login: "maintainer", type: "User" },
            label: { name: "task" },
          },
        ])
      if (requestUrl.pathname.endsWith("/comments")) return Response.json([])
      throw new Error("unexpected API route")
    }
    let attachmentRequests = 0
    const code = await main(
      [
        "ingest",
        "--event-file",
        eventFile,
        "--admission-file",
        admissionFile,
        "--bundle-dir",
        bundleDir,
        "--result-file",
        resultFile,
      ],
      {
        fetch: apiFetch,
        attachmentFetch: async (_request, init) => {
          attachmentRequests++
          const headers = new Headers(init?.headers)
          expect(headers.has("authorization")).toBe(false)
          expect(headers.has("cookie")).toBe(false)
          return new Response("attachment body")
        },
        bundleRoot: root,
        checkoutDir: import.meta.dir,
        env: {
          GITHUB_API_URL: "https://api.github.test",
          GITHUB_REPOSITORY: "octo/oc2",
          GITHUB_TOKEN: "TOP_SECRET_TOKEN",
        },
      },
    )
    expect(code).toBe(0)
    expect(attachmentRequests).toBe(1)
    const output = await Bun.file(resultFile).text()
    expect(JSON.parse(output)).toEqual({
      version: 1,
      status: "ok",
      issuePath: "issue.json",
      attachmentCount: 1,
      attachmentBytes: 15,
    })
    expect(output).not.toContain("PRIVATE_TITLE")
    expect(output).not.toContain("PRIVATE_BODY")
    expect(output).not.toContain(url)
    expect(output).not.toContain("TOP_SECRET_TOKEN")
    expect(await Bun.file(join(bundleDir, "issue.json")).text()).toContain("PRIVATE_BODY")
    await rm(root, { recursive: true, force: true })
  })
})

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "oc2-generation-"))
  const checkout = join(root, "checkout")
  await mkdir(checkout)
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: checkout, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode !== 0) throw new Error("test Git command failed")
    return stdout.trim()
  }
  await git("init", "--initial-branch=main")
  await Bun.write(join(checkout, "tracked.txt"), "before\n")
  await git("add", "tracked.txt")
  await git("-c", "user.name=OC2 Test", "-c", "user.email=oc2@example.com", "commit", "-m", "base")
  return { baseSha: await git("rev-parse", "HEAD"), checkout, root }
}

describe("trusted issue workflow glue", () => {
  test("strictly decodes admission and one canonical result-json object", () => {
    const admission = admissionArtifact()
    expect(decodeAdmission(`${JSON.stringify(admission)}\n`)).toEqual(admission)
    expect(() => decodeAdmission(JSON.stringify({ ...admission, extra: true }))).toThrow("invalid admission")
    expect(parseAutomationResult('{"status":"ok","sessionID":"ses_safe123","text":"bounded markdown"}\n')).toEqual({
      status: "ok",
      text: "bounded markdown",
    })
    expect(parseAutomationResult('{"status":"ok","sessionID":"ses_safe123","text":"safe\\u2028line"}\n')).toEqual({
      status: "ok",
      text: "safe\u2028line",
    })
    expect(() =>
      parseAutomationResult(
        '{"status":"ok","sessionID":"ses_safe123","text":"first"}\n{"status":"ok","sessionID":"ses_second","text":"second"}\n',
      ),
    ).toThrow("invalid automation result")
  })

  test("requires canonical release versions and lowercase digests", () => {
    expect(() => validateReleaseConfig("1.2.3-rc.1", "a".repeat(64), "b".repeat(64))).not.toThrow()
    expect(() => validateReleaseConfig("1.2.3-01", "a".repeat(64), "b".repeat(64))).toThrow(
      "invalid release configuration",
    )
    expect(() => validateReleaseConfig("1.2.3", "A".repeat(64), "b".repeat(64))).toThrow(
      "invalid release configuration",
    )
  })

  test("emits the canonical PR7 generation contract including untracked files", async () => {
    const fixture = await gitFixture()
    const stateDir = join(fixture.root, "state")
    const outputDir = join(fixture.root, "generation")
    const githubOutput = join(fixture.root, "github-output")
    await mkdir(stateDir)
    await Bun.write(githubOutput, "")
    await Bun.write(join(fixture.checkout, "tracked.txt"), "after\n")
    await Bun.write(join(fixture.checkout, "created.txt"), "created\n")
    const admission = admissionArtifact({
      repository: { id: 1234, nameWithOwner: "octo/oc2", baseBranch: "main", baseSha: fixture.baseSha },
    })
    await finalizeGeneration({
      admission,
      checkout: fixture.checkout,
      cliVersion: "1.2.3",
      outputDir,
      stateDir,
      githubOutput,
    })
    expect(await Bun.file(githubOutput).text()).toBe("state=generated\nexecute=true\n")
    const manifest = JSON.parse(await Bun.file(join(outputDir, "generation.json")).text())
    expect(manifest).toMatchObject({
      version: 1,
      repository: { id: 1234, nameWithOwner: "octo/oc2" },
      issue: { number: 42, label: "task", labelEventNodeId: "LE_label42" },
      baseSha: fixture.baseSha,
      cliVersion: "1.2.3",
      model: "openai/gpt-5.6-sol",
      variant: "high",
      patch: { fileCount: 2 },
    })
    await expect(
      validatePatch({
        generationPath: join(outputDir, "generation.json"),
        patchPath: join(outputDir, "changes.patch"),
        repository: "octo/oc2",
        repositoryId: 1234,
        baseSha: fixture.baseSha,
        cwd: fixture.checkout,
      }),
    ).resolves.toMatchObject({ paths: ["created.txt", "tracked.txt"] })
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("rejects model changes to protected automation paths", async () => {
    const fixture = await gitFixture()
    const stateDir = join(fixture.root, "state")
    await mkdir(stateDir)
    await Bun.write(join(fixture.checkout, "bunfig.toml"), 'preload = ["./attacker.ts"]\n')
    await Bun.write(join(fixture.checkout, "attacker.ts"), 'console.log("host execution")\n')
    const failure = finalizeGeneration({
      admission: admissionArtifact({
        repository: { id: 1234, nameWithOwner: "octo/oc2", baseBranch: "main", baseSha: fixture.baseSha },
      }),
      checkout: fixture.checkout,
      cliVersion: "1.2.3",
      outputDir: join(fixture.root, "generation"),
      stateDir,
      githubOutput: join(fixture.root, "github-output"),
    }).then(
      () => "unexpected success",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(await failure).toBe("patch changes a protected path")
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("classifies a feature planner file without implementation edits as no changes", async () => {
    const fixture = await gitFixture()
    const stateDir = join(fixture.root, "state")
    const githubOutput = join(fixture.root, "github-output")
    await mkdir(stateDir)
    await mkdir(join(fixture.checkout, "specs"))
    await Bun.write(join(fixture.checkout, "specs", "issue-42.md"), "# Plan only\n")
    await Bun.write(githubOutput, "")
    const base = admissionArtifact()
    await finalizeGeneration({
      admission: {
        ...base,
        repository: { ...base.repository, baseSha: fixture.baseSha },
        issue: { ...base.issue, label: "feature" },
      },
      checkout: fixture.checkout,
      cliVersion: "1.2.3",
      outputDir: join(fixture.root, "generation"),
      stateDir,
      githubOutput,
    })
    expect(await Bun.file(githubOutput).text()).toBe("state=no_changes\nexecute=false\n")
    expect(await Bun.file(join(fixture.root, "generation")).exists()).toBe(false)
    await rm(fixture.root, { recursive: true, force: true })
  })

  test("workflow pins actions and exposes the provider secret only to generation", async () => {
    const workflow = await Bun.file(join(import.meta.dir, "..", ".github", "workflows", "oc2-issue.yml")).text()
    expect(workflow).toContain("permissions: {}")
    expect(workflow).toContain("group: oc2-issue-${{ github.repository_id }}-${{ github.event.issue.number }}")
    expect(workflow).toContain("cancel-in-progress: false")
    expect(workflow.match(/OC2_OPENAI_API_KEY/g)).toHaveLength(1)
    expect(workflow).not.toContain("dangerously-skip-permissions")
    expect(workflow).not.toContain("--format json")
    expect(workflow).not.toMatch(/\bbun script\//)
    expect(workflow.match(/bun --config=\/dev\/null --no-env-file --no-install/g)).toHaveLength(11)
    for (const line of workflow.split("\n").filter((line) => line.trim().startsWith("uses:"))) {
      expect(line).toMatch(/uses: [^@]+@[0-9a-f]{40}(?: # v[^ ]+)?$/)
    }
  })
})
