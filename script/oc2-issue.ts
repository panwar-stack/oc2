#!/usr/bin/env bun

const authorizedPermissions = new Set(["write", "maintain", "admin"])
const markerPrefix = "<!-- oc2-issue-state:v1 "
const pageSize = 100
const maximumPages = 100
const maximumResponseBytes = 8 * 1024 * 1024
const maximumPaginatedBytes = 16 * 1024 * 1024
const maximumEventBytes = 2 * 1024 * 1024

export const issueWorkflowTimeoutMinutes = 360
export const issueStaleGraceMinutes = 30
const staleAfterMs = (issueWorkflowTimeoutMinutes + issueStaleGraceMinutes) * 60 * 1000

export const issuePhases = [
  "waiting_for_label",
  "rejected_actor",
  "ambiguous_label",
  "duplicate",
  "running",
  "input_too_large",
  "attachment_rejected",
  "install_failed",
  "model_failed",
  "permission_denied",
  "tool_failed",
  "no_changes",
  "patch_rejected",
  "verification_failed",
  "stale_base",
  "push_race",
  "pr_opened",
  "auto_merge_enabled",
  "auto_merge_unavailable",
] as const

export type IssuePhase = (typeof issuePhases)[number]
export type ExecutionLabel = "task" | "feature"

export interface IssueMarker {
  attempt: number
  key: string
  phase: IssuePhase
  prId?: number
  runId: number
  updatedAt: string
}

export interface GitHubRepository {
  id: number
  nameWithOwner: string
  defaultBranch: string
}

export interface GitHubActor {
  id: number
  login: string
  permission: string
  type: string
}

export interface GitHubLabeledEvent {
  actor: {
    id: number
    login: string
    type: string
  }
  createdAt: string
  label: string
  nodeId: string
}

export interface GitHubIssueComment {
  body: string
  id: number
  userId: number
}

export interface GitHubIssue {
  labels: Array<{ id: number; name: string }>
  nodeId: string
  state: string
}

export interface GitHubActionsRun {
  attempt: number
  conclusion: string | null
  id: number
  status: string
  updatedAt: string
}

export interface GitHubPullRequest {
  headRef: string
  headRepositoryId: number
  id: number
  userId: number
}

export interface GitHubApi {
  createIssueComment(issueNumber: number, body: string): Promise<GitHubIssueComment>
  getActionsRunAttempt(runId: number, attempt: number): Promise<GitHubActionsRun | undefined>
  getActor(login: string): Promise<GitHubActor>
  getBranchSha(branch: string): Promise<string>
  getIssue(issueNumber: number): Promise<GitHubIssue>
  getIssueComment(commentId: number): Promise<GitHubIssueComment>
  getRepository(): Promise<GitHubRepository>
  listIssueComments(issueNumber: number): Promise<GitHubIssueComment[]>
  listLabeledEvents(issueNumber: number): Promise<GitHubLabeledEvent[]>
  listOpenPullRequests(): Promise<GitHubPullRequest[]>
  updateIssueComment(commentId: number, body: string): Promise<GitHubIssueComment>
}

export type AdmissionResult =
  | {
      version: 1
      status: "waiting_for_label"
      phase: "waiting_for_label"
    }
  | {
      version: 1
      status: "rejected"
      phase: "rejected_actor" | "ambiguous_label" | "stale_base"
    }
  | {
      version: 1
      status: "duplicate"
      phase: "duplicate"
      key: string
    }
  | Admission

export interface Admission {
  version: 1
  status: "admitted"
  phase: "running"
  key: string
  repository: {
    id: number
    nameWithOwner: string
    baseBranch: "main"
    baseSha: string
  }
  issue: {
    number: number
    nodeId: string
    label: ExecutionLabel
    labelId: number
    labelEventNodeId: string
    cutoff: string
  }
  run: {
    id: number
    attempt: number
  }
  marker: {
    commentId: number
  }
}

export interface AdmissionInput {
  event: unknown
  repository: string
  runId: number
  runAttempt: number
  triggeringActor: string
  botId: number
  publisherBotId: number
  allowedBotIds?: ReadonlySet<number>
  now?: Date
}

export interface MarkerUpdateInput {
  admission: Admission
  botId: number
  phase: IssuePhase
  prId?: number
  now?: Date
}

export interface GitHubApiOptions {
  token: string
  repository: string
  baseUrl?: string
  fetch?: GitHubFetch
}

export type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
  if (!options.token) throw new Error("GitHub token is required")
  const repository = parseRepositoryName(options.repository)
  const baseUrl = new URL(options.baseUrl ?? "https://api.github.com")
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    throw new Error("invalid GitHub API URL")
  const root = baseUrl.href.replace(/\/$/, "")
  const request = options.fetch ?? globalThis.fetch
  const repositoryPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`

  async function responseJson(response: Response) {
    const declaredLength = response.headers.get("content-length")
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumResponseBytes))
      throw new Error("GitHub API response too large")
    if (!response.body) throw new Error("invalid GitHub API response")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const chunk = await reader.read().catch(() => {
        throw new Error("GitHub API response failed")
      })
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximumResponseBytes) {
        await reader.cancel().catch(() => {})
        throw new Error("GitHub API response too large")
      }
      chunks.push(chunk.value)
    }
    const content = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      content.set(chunk, offset)
      offset += chunk.byteLength
    }
    let body: string
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(content)
    } catch {
      throw new Error("invalid GitHub API response encoding")
    }
    return { value: parseJson(body), bytes }
  }

  async function read(path: string, allowMissing = false) {
    const response = await request(`${root}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "User-Agent": "oc2-issue-admission",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }).catch(() => {
      throw new Error("GitHub API request failed")
    })
    if (allowMissing && response.status === 404) return undefined
    if (!response.ok) throw new Error("GitHub API request failed")
    return { ...(await responseJson(response)), headers: response.headers }
  }

  async function get(path: string, allowMissing = false) {
    return (await read(path, allowMissing))?.value
  }

  async function write(path: string, method: "POST" | "PATCH", body: string) {
    const response = await request(`${root}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "User-Agent": "oc2-issue-admission",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body }),
    }).catch(() => {
      throw new Error("GitHub API request failed")
    })
    if (!response.ok) throw new Error("GitHub API request failed")
    return decodeComment((await responseJson(response)).value)
  }

  async function pages(path: string) {
    const items: unknown[] = []
    let bytes = 0
    for (let page = 1; page <= maximumPages; page++) {
      const separator = path.includes("?") ? "&" : "?"
      const response = await read(`${path}${separator}per_page=${pageSize}&page=${page}`)
      if (!response) throw new Error("invalid GitHub API response")
      const value = response.value
      if (!Array.isArray(value)) throw new Error("invalid GitHub API response")
      bytes += response.bytes
      if (bytes > maximumPaginatedBytes) throw new Error("GitHub API pagination too large")
      validateNextPage(response.headers.get("link"), root, path, page, value.length)
      items.push(...value)
      if (value.length < pageSize) return items
    }
    throw new Error("GitHub API pagination limit exceeded")
  }

  return {
    async createIssueComment(issueNumber, body) {
      return write(`${repositoryPath}/issues/${positiveInteger(issueNumber)}/comments`, "POST", body)
    },
    async getActionsRunAttempt(runId, attempt) {
      const value = await get(
        `${repositoryPath}/actions/runs/${positiveInteger(runId)}/attempts/${positiveInteger(attempt)}`,
        true,
      )
      return value === undefined ? undefined : decodeActionsRun(value)
    },
    async getActor(login) {
      const actor = decodeUser(await get(`/users/${encodeURIComponent(parseLogin(login))}`))
      const permission = await get(
        `${repositoryPath}/collaborators/${encodeURIComponent(actor.login)}/permission`,
        true,
      )
      return {
        ...actor,
        permission: permission === undefined ? "none" : decodePermission(permission),
      }
    },
    async getBranchSha(branch) {
      const value = record(await get(`${repositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`))
      return sha(record(value.object).sha)
    },
    async getIssue(issueNumber) {
      return decodeIssue(await get(`${repositoryPath}/issues/${positiveInteger(issueNumber)}`))
    },
    async getIssueComment(commentId) {
      return decodeComment(await get(`${repositoryPath}/issues/comments/${positiveInteger(commentId)}`))
    },
    async getRepository() {
      const value = record(await get(repositoryPath))
      return {
        id: positiveInteger(value.id),
        nameWithOwner: nonemptyString(value.full_name, "repository full name"),
        defaultBranch: nonemptyString(value.default_branch, "default branch"),
      }
    },
    async listIssueComments(issueNumber) {
      return (await pages(`${repositoryPath}/issues/${positiveInteger(issueNumber)}/comments`)).map(decodeComment)
    },
    async listLabeledEvents(issueNumber) {
      return (await pages(`${repositoryPath}/issues/${positiveInteger(issueNumber)}/timeline`)).flatMap((value) => {
        const item = record(value)
        const event = nonemptyString(item.event, "timeline event")
        if (event !== "labeled") return []
        const actor = decodeUser(item.actor)
        return [
          {
            actor,
            createdAt: timestamp(item.created_at),
            label: nonemptyString(record(item.label).name, "timeline label"),
            nodeId: nonemptyString(item.node_id, "timeline node ID"),
          },
        ]
      })
    },
    async listOpenPullRequests() {
      return (await pages(`${repositoryPath}/pulls?state=open`)).map((value) => {
        const item = record(value)
        const head = record(item.head)
        return {
          headRef: nonemptyString(head.ref, "pull request head"),
          headRepositoryId: positiveInteger(record(head.repo).id),
          id: positiveInteger(item.id),
          userId: positiveInteger(record(item.user).id),
        }
      })
    },
    async updateIssueComment(commentId, body) {
      return write(`${repositoryPath}/issues/comments/${positiveInteger(commentId)}`, "PATCH", body)
    },
  }
}

export async function admitIssue(input: AdmissionInput, api: GitHubApi): Promise<AdmissionResult> {
  const event = decodeIssueEvent(input.event)
  if (event.action === "opened") return { version: 1, status: "waiting_for_label", phase: "waiting_for_label" }
  if (event.action !== "labeled" || !event.label || event.issue.state !== "open") return rejected("ambiguous_label")
  if (!isExecutionLabel(event.label.name)) return rejected("ambiguous_label")
  const labels = event.issue.labels.filter((label) => isExecutionLabel(label.name))
  if (labels.length !== 1 || labels[0]?.name !== event.label.name || labels[0].id !== event.label.id)
    return rejected("ambiguous_label")

  const allowedBotIds = new Set(input.allowedBotIds ?? [])
  positiveInteger(input.botId)
  positiveInteger(input.publisherBotId)
  const actor = await api.getActor(event.sender.login)
  if (!authorizeActor(event.sender, actor, allowedBotIds)) return rejected("rejected_actor")
  const triggeringActor =
    input.triggeringActor === actor.login ? actor : await api.getActor(parseLogin(input.triggeringActor))
  if (!authorizeActor(undefined, triggeringActor, allowedBotIds)) return rejected("rejected_actor")

  const currentIssue = await api.getIssue(event.issue.number)
  const currentLabels = currentIssue.labels.filter((label) => isExecutionLabel(label.name))
  if (
    currentIssue.nodeId !== event.issue.nodeId ||
    currentIssue.state !== "open" ||
    currentLabels.length !== 1 ||
    currentLabels[0]?.name !== event.label.name ||
    currentLabels[0].id !== event.label.id
  )
    return rejected("ambiguous_label")

  const matches = (await api.listLabeledEvents(event.issue.number)).filter(
    (item) =>
      item.label === event.label?.name &&
      item.createdAt === event.issue.updatedAt &&
      item.actor.id === event.sender.id &&
      item.actor.login === event.sender.login &&
      item.actor.type === event.sender.type,
  )
  if (matches.length !== 1) return rejected("ambiguous_label")
  const labelEvent = matches[0]
  if (!labelEvent) return rejected("ambiguous_label")

  const repository = await api.getRepository()
  if (
    repository.id !== event.repository.id ||
    repository.nameWithOwner !== event.repository.nameWithOwner ||
    repository.nameWithOwner !== input.repository ||
    repository.defaultBranch !== "main"
  )
    return rejected("stale_base")
  const baseSha = await api.getBranchSha("main")
  const key = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([repository.id, event.issue.nodeId, event.label.id, labelEvent.nodeId]))
    .digest("hex")

  const comments = await api.listIssueComments(event.issue.number)
  const botMarker = findBotMarker(comments, input.botId)
  const openBotPullRequest = (await api.listOpenPullRequests()).find(
    (pullRequest) =>
      pullRequest.userId === input.publisherBotId &&
      pullRequest.headRepositoryId === repository.id &&
      pullRequest.headRef.startsWith(`oc2/issue-${event.issue.number}-`),
  )
  if (openBotPullRequest) return { version: 1, status: "duplicate", phase: "duplicate", key }

  const now = input.now ?? new Date()
  timestamp(now.toISOString())
  const marker: IssueMarker = {
    attempt: positiveInteger(input.runAttempt),
    key,
    phase: "running",
    runId: positiveInteger(input.runId),
    updatedAt: now.toISOString(),
  }

  let markerComment: GitHubIssueComment
  if (!botMarker) {
    markerComment = await api.createIssueComment(event.issue.number, formatIssueMarker(marker))
  } else {
    if (!(await canReplaceMarker(botMarker.marker, marker, input, api)))
      return { version: 1, status: "duplicate", phase: "duplicate", key }
    markerComment = await api.updateIssueComment(botMarker.comment.id, formatIssueMarker(marker))
  }
  if (markerComment.userId !== input.botId || markerComment.body !== formatIssueMarker(marker))
    throw new Error("marker reservation was not owned by the configured bot")
  const reserved = await api.getIssueComment(markerComment.id)
  if (reserved.userId !== input.botId || reserved.body !== formatIssueMarker(marker))
    throw new Error("marker reservation changed concurrently")
  const reservedMarkers = (await api.listIssueComments(event.issue.number)).filter(
    (comment) => comment.userId === input.botId && comment.body.includes("oc2-issue-state:"),
  )
  if (reservedMarkers.length !== 1 || reservedMarkers[0]?.id !== reserved.id)
    throw new Error("marker reservation is not unique")

  return {
    version: 1,
    status: "admitted",
    phase: "running",
    key,
    repository: {
      id: repository.id,
      nameWithOwner: repository.nameWithOwner,
      baseBranch: "main",
      baseSha,
    },
    issue: {
      number: event.issue.number,
      nodeId: event.issue.nodeId,
      label: event.label.name,
      labelId: event.label.id,
      labelEventNodeId: labelEvent.nodeId,
      cutoff: labelEvent.createdAt,
    },
    run: {
      id: marker.runId,
      attempt: marker.attempt,
    },
    marker: {
      commentId: reserved.id,
    },
  }
}

export function formatIssueMarker(marker: IssueMarker) {
  const attempt = positiveInteger(marker.attempt)
  const key = idempotencyKey(marker.key)
  const phase = issuePhase(marker.phase)
  const runId = positiveInteger(marker.runId)
  const updatedAt = timestamp(marker.updatedAt)
  const prId = marker.prId === undefined ? "" : `,"prId":${positiveInteger(marker.prId)}`
  return `${markerPrefix}{"attempt":${attempt},"key":"${key}","phase":"${phase}"${prId},"runId":${runId},"updatedAt":"${updatedAt}"} -->\nOC2 issue automation phase: ${phase}.`
}

export function parseIssueMarker(body: string): IssueMarker | undefined {
  const phases = issuePhases.join("|")
  const match = body.match(
    new RegExp(
      `^<!-- oc2-issue-state:v1 \\{"attempt":([1-9]\\d*),"key":"([a-f0-9]{64})","phase":"(${phases})"(?:,"prId":([1-9]\\d*))?,"runId":([1-9]\\d*),"updatedAt":"([^"\\n]+)"\\} -->(?:\\nOC2 issue automation phase: (${phases})\\.)?$`,
    ),
  )
  if (!match) return undefined
  const attempt = Number(match[1])
  const prId = match[4] === undefined ? undefined : Number(match[4])
  const runId = Number(match[5])
  const updatedAt = match[6]
  if (
    !Number.isSafeInteger(attempt) ||
    attempt <= 0 ||
    (prId !== undefined && (!Number.isSafeInteger(prId) || prId <= 0)) ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !isTimestamp(updatedAt)
  )
    return undefined
  const phase = issuePhase(match[3])
  if (match[7] !== undefined && match[7] !== phase) return undefined
  return {
    attempt,
    key: idempotencyKey(match[2]),
    phase,
    ...(prId === undefined ? {} : { prId }),
    runId,
    updatedAt,
  }
}

export async function updateIssueMarker(input: MarkerUpdateInput, api: GitHubApi) {
  const current = await api.getIssueComment(input.admission.marker.commentId)
  const marker = current.userId === input.botId ? parseIssueMarker(current.body) : undefined
  if (
    !marker ||
    marker.key !== input.admission.key ||
    marker.runId !== input.admission.run.id ||
    marker.attempt !== input.admission.run.attempt ||
    !new Set<IssuePhase>(["running", "pr_opened"]).has(marker.phase)
  )
    throw new Error("marker compare-and-swap failed")
  const next: IssueMarker = {
    attempt: marker.attempt,
    key: marker.key,
    phase: issuePhase(input.phase),
    ...(input.prId === undefined ? {} : { prId: positiveInteger(input.prId) }),
    runId: marker.runId,
    updatedAt: (input.now ?? new Date()).toISOString(),
  }
  const body = formatIssueMarker(next)
  const updated = await api.updateIssueComment(current.id, body)
  if (updated.id !== current.id || updated.userId !== current.userId || updated.body !== body)
    throw new Error("marker update changed concurrently")
  const verified = await api.getIssueComment(current.id)
  if (verified.userId !== current.userId || verified.body !== body)
    throw new Error("marker update changed concurrently")
  return next
}

export async function main(
  args = process.argv.slice(2),
  dependencies: { env?: Record<string, string | undefined>; fetch?: GitHubFetch; now?: Date } = {},
) {
  const env = dependencies.env ?? process.env
  const options = parseCli(args)
  const eventFile = Bun.file(options.eventFile)
  if (eventFile.size > maximumEventBytes) throw new Error("GitHub event is too large")
  const event = parseJson(await eventFile.text())
  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY")
  const botId = positiveInteger(Number(options.botId))
  const publisherBotId = positiveInteger(Number(options.publisherBotId))
  const result = await admitIssue(
    {
      event,
      repository,
      runId: positiveInteger(Number(requiredEnvironment(env, "GITHUB_RUN_ID"))),
      runAttempt: positiveInteger(Number(requiredEnvironment(env, "GITHUB_RUN_ATTEMPT"))),
      triggeringActor: requiredEnvironment(env, "GITHUB_TRIGGERING_ACTOR"),
      botId,
      publisherBotId,
      allowedBotIds: new Set(options.allowedBotIds.map((value) => positiveInteger(Number(value)))),
      now: dependencies.now,
    },
    createGitHubApi({
      token: requiredEnvironment(env, "GITHUB_TOKEN"),
      repository,
      baseUrl: env.GITHUB_API_URL,
      fetch: dependencies.fetch,
    }),
  )
  await Bun.write(options.resultFile, `${JSON.stringify(result)}\n`)
  return 0
}

interface DecodedIssueEvent {
  action: string
  issue: {
    labels: Array<{ id: number; name: string }>
    nodeId: string
    number: number
    state: string
    updatedAt: string
  }
  label?: {
    id: number
    name: string
  }
  repository: {
    id: number
    nameWithOwner: string
  }
  sender: {
    id: number
    login: string
    type: string
  }
}

function decodeIssueEvent(value: unknown): DecodedIssueEvent {
  const event = record(value)
  const issue = record(event.issue)
  const repository = record(event.repository)
  const action = nonemptyString(event.action, "event action")
  const decoded: DecodedIssueEvent = {
    action,
    issue: {
      labels: array(issue.labels, "issue labels").map((value) => {
        const label = record(value)
        return { id: positiveInteger(label.id), name: nonemptyString(label.name, "issue label") }
      }),
      nodeId: nonemptyString(issue.node_id, "issue node ID"),
      number: positiveInteger(issue.number),
      state: nonemptyString(issue.state, "issue state"),
      updatedAt: timestamp(issue.updated_at),
    },
    repository: {
      id: positiveInteger(repository.id),
      nameWithOwner: nonemptyString(repository.full_name, "repository full name"),
    },
    sender: decodeUser(event.sender),
  }
  if (event.label !== undefined && event.label !== null) {
    const label = record(event.label)
    decoded.label = { id: positiveInteger(label.id), name: nonemptyString(label.name, "event label") }
  }
  return decoded
}

function decodeUser(value: unknown) {
  const user = record(value)
  const type = nonemptyString(user.type, "actor type")
  if (!new Set(["User", "Bot", "Organization", "Mannequin"]).has(type)) throw new Error("invalid actor type")
  return {
    id: positiveInteger(user.id),
    login: parseLogin(user.login),
    type,
  }
}

function decodePermission(value: unknown) {
  const permission = nonemptyString(record(value).permission, "repository permission")
  if (!new Set(["none", "read", "triage", "write", "maintain", "admin"]).has(permission))
    throw new Error("invalid repository permission")
  return permission
}

function decodeComment(value: unknown): GitHubIssueComment {
  const comment = record(value)
  return {
    body: string(comment.body, "comment body"),
    id: positiveInteger(comment.id),
    userId: positiveInteger(record(comment.user).id),
  }
}

function decodeIssue(value: unknown): GitHubIssue {
  const issue = record(value)
  return {
    labels: array(issue.labels, "issue labels").map((value) => {
      const label = record(value)
      return { id: positiveInteger(label.id), name: nonemptyString(label.name, "issue label") }
    }),
    nodeId: nonemptyString(issue.node_id, "issue node ID"),
    state: nonemptyString(issue.state, "issue state"),
  }
}

function decodeActionsRun(value: unknown): GitHubActionsRun {
  const run = record(value)
  const conclusion = run.conclusion === null ? null : nonemptyString(run.conclusion, "Actions run conclusion")
  if (
    conclusion !== null &&
    !new Set([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
      "startup_failure",
      "stale",
    ]).has(conclusion)
  )
    throw new Error("invalid Actions run conclusion")
  const status = nonemptyString(run.status, "Actions run status")
  if (!new Set(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).has(status))
    throw new Error("invalid Actions run status")
  return {
    attempt: positiveInteger(run.run_attempt),
    conclusion,
    id: positiveInteger(run.id),
    status,
    updatedAt: timestamp(run.updated_at),
  }
}

function authorizeActor(
  eventActor: { id: number; login: string; type: string } | undefined,
  currentActor: GitHubActor,
  allowedBotIds: ReadonlySet<number>,
) {
  if (
    eventActor &&
    (eventActor.id !== currentActor.id ||
      eventActor.login !== currentActor.login ||
      eventActor.type !== currentActor.type)
  )
    return false
  if (!authorizedPermissions.has(currentActor.permission)) return false
  if (currentActor.type === "Bot") return allowedBotIds.has(currentActor.id)
  return currentActor.type === "User"
}

function findBotMarker(comments: GitHubIssueComment[], botId: number) {
  const candidates = comments.filter((comment) => comment.userId === botId && comment.body.includes("oc2-issue-state:"))
  if (candidates.length > 1) throw new Error("multiple bot-owned issue markers")
  const comment = candidates[0]
  if (!comment) return undefined
  const marker = parseIssueMarker(comment.body)
  if (!marker) throw new Error("malformed bot-owned issue marker")
  return { comment, marker }
}

async function canReplaceMarker(previous: IssueMarker, next: IssueMarker, input: AdmissionInput, api: GitHubApi) {
  const sameKey = previous.key === next.key
  if (sameKey) {
    if (new Set<IssuePhase>(["pr_opened", "auto_merge_enabled", "no_changes"]).has(previous.phase)) return false
    if (previous.runId !== next.runId || next.attempt <= previous.attempt) return false
  } else if (new Set<IssuePhase>(["pr_opened", "auto_merge_enabled", "no_changes"]).has(previous.phase)) {
    return true
  }
  const run = await api.getActionsRunAttempt(previous.runId, previous.attempt)
  if (run && (run.id !== previous.runId || run.attempt !== previous.attempt))
    throw new Error("Actions run attempt identity mismatch")
  const terminated =
    run?.status === "completed" &&
    run.conclusion !== null &&
    new Set(["failure", "cancelled", "timed_out", "startup_failure", "stale"]).has(run.conclusion)
  if (terminated) return true
  if (run?.status === "completed") return false
  const lastUpdate = Math.max(Date.parse(previous.updatedAt), run === undefined ? 0 : Date.parse(run.updatedAt))
  return previous.phase === "running" && (input.now ?? new Date()).getTime() - lastUpdate > staleAfterMs
}

function validateNextPage(link: string | null, root: string, path: string, page: number, itemCount: number) {
  if (!link) return
  const nextParts = link.split(",").filter((part) => /;\s*rel="next"\s*$/.test(part))
  if (nextParts.length === 0) return
  if (nextParts.length !== 1 || itemCount < pageSize) throw new Error("invalid GitHub API pagination")
  const match = nextParts[0]?.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/)
  if (!match?.[1]) throw new Error("invalid GitHub API pagination")
  if (!URL.canParse(match[1])) throw new Error("invalid GitHub API pagination")
  const next = new URL(match[1])
  const expected = new URL(`${root}${path}`)
  if (
    next.origin !== expected.origin ||
    next.pathname !== expected.pathname ||
    next.username ||
    next.password ||
    next.hash ||
    next.searchParams.getAll("page").length !== 1 ||
    next.searchParams.get("page") !== String(page + 1) ||
    next.searchParams.getAll("per_page").length !== 1 ||
    next.searchParams.get("per_page") !== String(pageSize)
  )
    throw new Error("invalid GitHub API pagination")
  next.searchParams.delete("page")
  next.searchParams.delete("per_page")
  if (
    JSON.stringify([...next.searchParams.entries()].sort(compareParameter)) !==
    JSON.stringify([...expected.searchParams.entries()].sort(compareParameter))
  )
    throw new Error("invalid GitHub API pagination")
}

function compareParameter(left: [string, string], right: [string, string]) {
  return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])
}

function rejected(phase: "rejected_actor" | "ambiguous_label" | "stale_base"): AdmissionResult {
  return { version: 1, status: "rejected", phase }
}

function parseCli(args: string[]) {
  if (args[0] !== "admit")
    throw new Error("usage: oc2-issue admit --event-file PATH --result-file PATH --bot-id ID --publisher-bot-id ID")
  const values = new Map<string, string>()
  const allowedBotIds: string[] = []
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name || !value || !name.startsWith("--")) throw new Error("invalid oc2-issue option")
    if (name === "--allow-bot-id") {
      allowedBotIds.push(value)
      continue
    }
    if (!new Set(["--event-file", "--result-file", "--bot-id", "--publisher-bot-id"]).has(name) || values.has(name))
      throw new Error("invalid oc2-issue option")
    values.set(name, value)
  }
  const eventFile = values.get("--event-file")
  const resultFile = values.get("--result-file")
  const botId = values.get("--bot-id")
  const publisherBotId = values.get("--publisher-bot-id")
  if (!eventFile || !resultFile || !botId || !publisherBotId) throw new Error("missing oc2-issue option")
  return { eventFile, resultFile, botId, publisherBotId, allowedBotIds }
}

function parseRepositoryName(value: string) {
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/)
  if (!match?.[1] || !match[2]) throw new Error("invalid GitHub repository")
  if (match[2] === "." || match[2] === "..") throw new Error("invalid GitHub repository")
  return { owner: match[1], name: match[2] }
}

function parseLogin(value: unknown) {
  const login = nonemptyString(value, "GitHub login")
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)) throw new Error("invalid GitHub login")
  return login
}

function requiredEnvironment(env: Record<string, string | undefined>, name: string) {
  const value = env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error("invalid JSON")
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid object")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${name}`)
  return value
}

function string(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`invalid ${name}`)
  return value
}

function nonemptyString(value: unknown, name: string) {
  const result = string(value, name)
  if (!result || result.length > 1024) throw new Error(`invalid ${name}`)
  return result
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("invalid positive integer")
  return value
}

function timestamp(value: unknown) {
  const result = nonemptyString(value, "timestamp")
  if (!isTimestamp(result)) throw new Error("invalid timestamp")
  return result
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  return new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"))
}

function sha(value: unknown) {
  const result = nonemptyString(value, "Git SHA")
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error("invalid Git SHA")
  return result
}

function idempotencyKey(value: unknown) {
  const result = nonemptyString(value, "idempotency key")
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("invalid idempotency key")
  return result
}

function issuePhase(value: unknown): IssuePhase {
  if (!isIssuePhase(value)) throw new Error("invalid issue phase")
  return value
}

function isIssuePhase(value: unknown): value is IssuePhase {
  return typeof value === "string" && issuePhases.some((phase) => phase === value)
}

function isExecutionLabel(value: string): value is ExecutionLabel {
  return value === "task" || value === "feature"
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("oc2-issue: admission failed")
      process.exit(1)
    },
  )
}
