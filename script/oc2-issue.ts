#!/usr/bin/env bun

import { mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

const authorizedPermissions = new Set(["write", "maintain", "admin"])
const markerPrefix = "<!-- oc2-issue-state:v1 "
const pageSize = 100
const maximumPages = 100
const maximumResponseBytes = 8 * 1024 * 1024
const maximumPaginatedBytes = 16 * 1024 * 1024
const maximumEventBytes = 2 * 1024 * 1024
const maximumAdmissionBytes = 64 * 1024
const maximumSnapshotTextBytes = 512 * 1024
const maximumSnapshotComments = 100
const maximumAttachmentCandidates = 20
const maximumAttachments = 5
const maximumAttachmentBytes = 5 * 1024 * 1024
const maximumTotalAttachmentBytes = 20 * 1024 * 1024
const attachmentTimeoutMs = 30_000
const maximumRedirects = 3
const attachmentSourceHosts = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
])
const attachmentRedirectHosts = new Set([...attachmentSourceHosts, "objects.githubusercontent.com"])

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

export interface GitHubSnapshotComment {
  nodeId: string
  author: string
  createdAt: string
  updatedAt: string
  body: string
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
  listSnapshotComments(issueNumber: number): Promise<GitHubSnapshotComment[]>
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

export interface IngestInput {
  admission: unknown
  bundleDir: string
  checkoutDir?: string
  event: unknown
  repository: string
}

export interface IssueBundle {
  repository: Admission["repository"]
  issue: {
    number: number
    nodeId: string
    title: string
    body: string
    label: ExecutionLabel
    labelEventNodeId: string
    cutoff: string
  }
  comments: GitHubSnapshotComment[]
  attachments: Array<{
    sourceUrl: string
    path: string
    mediaType: string
    size: number
    sha256: string
  }>
}

export type IngestResult =
  | {
      version: 1
      status: "ok"
      issuePath: "issue.json"
      attachmentCount: number
      attachmentBytes: number
    }
  | {
      version: 1
      status: "stopped"
      phase: "input_too_large" | "attachment_rejected"
    }

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
    async listSnapshotComments(issueNumber) {
      return (await pages(`${repositoryPath}/issues/${positiveInteger(issueNumber)}/comments`)).map(
        decodeSnapshotComment,
      )
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

export async function ingestIssue(
  input: IngestInput,
  api: GitHubApi,
  attachmentFetch: GitHubFetch = globalThis.fetch,
): Promise<IngestResult> {
  const admission = decodeAdmission(input.admission)
  const event = decodeSnapshotEvent(input.event)
  validateSnapshotBinding(admission, event, input.repository)
  const labelEvents = await api.listLabeledEvents(event.issue.number)
  const admittedLabelEvents = labelEvents.filter(
    (item) =>
      item.nodeId === admission.issue.labelEventNodeId &&
      item.label === admission.issue.label &&
      item.createdAt === admission.issue.cutoff &&
      item.actor.id === event.sender.id &&
      item.actor.login === event.sender.login &&
      item.actor.type === event.sender.type,
  )
  if (admittedLabelEvents.length !== 1) throw new Error("admitted label event changed")

  const cutoff = Date.parse(admission.issue.cutoff)
  const allComments = await api.listSnapshotComments(event.issue.number)
  const nodeIds = new Set<string>()
  for (const comment of allComments) {
    ensureWellFormedText(comment.body)
    if (nodeIds.has(comment.nodeId) || Date.parse(comment.updatedAt) < Date.parse(comment.createdAt))
      throw new Error("invalid issue comment snapshot")
    nodeIds.add(comment.nodeId)
  }
  const commentsCreatedByCutoff = allComments.filter((comment) => Date.parse(comment.createdAt) <= cutoff)
  if (commentsCreatedByCutoff.length !== event.issue.commentCount) throw new Error("incomplete issue comment snapshot")
  const comments = commentsCreatedByCutoff
    .filter((comment) => Date.parse(comment.updatedAt) <= cutoff)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.nodeId.localeCompare(right.nodeId),
    )
    .map((comment) => ({
      nodeId: comment.nodeId,
      author: comment.author,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      body: comment.body,
    }))
  if (comments.length > maximumSnapshotComments) return stopped("input_too_large")
  ensureWellFormedText(event.issue.title)
  ensureWellFormedText(event.issue.body)
  const textBytes = [event.issue.title, event.issue.body, ...comments.map((comment) => comment.body)].reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  )
  if (textBytes > maximumSnapshotTextBytes) return stopped("input_too_large")

  let downloads: Awaited<ReturnType<typeof downloadAttachments>>
  try {
    downloads = await downloadAttachments(
      extractAttachmentCandidates([event.issue.title, event.issue.body, ...comments.map((comment) => comment.body)]),
      attachmentFetch,
    )
  } catch (error) {
    if (error instanceof IngestionStopped) return stopped(error.phase)
    throw error
  }
  const bundle: IssueBundle = {
    repository: admission.repository,
    issue: {
      number: admission.issue.number,
      nodeId: admission.issue.nodeId,
      title: event.issue.title,
      body: event.issue.body,
      label: admission.issue.label,
      labelEventNodeId: admission.issue.labelEventNodeId,
      cutoff: admission.issue.cutoff,
    },
    comments,
    attachments: downloads
      .map((download) => ({
        sourceUrl: download.sourceUrl,
        path: `attachments/${download.sha256}.${download.extension}`,
        mediaType: download.mediaType,
        size: download.content.byteLength,
        sha256: download.sha256,
      }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256)),
  }
  const bundleDir = await prepareBundleDirectory(input.bundleDir, input.checkoutDir ?? process.cwd())
  try {
    if (downloads.length > 0) await mkdir(join(bundleDir, "attachments"), { mode: 0o700 })
    for (const download of downloads) {
      await writeFile(join(bundleDir, "attachments", `${download.sha256}.${download.extension}`), download.content, {
        flag: "wx",
        mode: 0o600,
      })
    }
    await writeFile(join(bundleDir, "issue.json"), `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  } catch (error) {
    await rm(bundleDir, { recursive: true, force: true })
    throw error
  }
  return {
    version: 1,
    status: "ok",
    issuePath: "issue.json",
    attachmentCount: downloads.length,
    attachmentBytes: downloads.reduce((total, download) => total + download.content.byteLength, 0),
  }
}

export async function main(
  args = process.argv.slice(2),
  dependencies: {
    env?: Record<string, string | undefined>
    fetch?: GitHubFetch
    attachmentFetch?: GitHubFetch
    now?: Date
    checkoutDir?: string
  } = {},
) {
  const env = dependencies.env ?? process.env
  const options = parseCli(args)
  const event = parseJson(await readBoundedUtf8File(options.eventFile, maximumEventBytes, "GitHub event"))
  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY")
  const api = createGitHubApi({
    token: requiredEnvironment(env, "GITHUB_TOKEN"),
    repository,
    baseUrl: env.GITHUB_API_URL,
    fetch: dependencies.fetch,
  })
  if (options.command === "ingest") {
    const result = await ingestIssue(
      {
        admission: parseJson(await readBoundedUtf8File(options.admissionFile, maximumAdmissionBytes, "admission")),
        bundleDir: options.bundleDir,
        checkoutDir: dependencies.checkoutDir,
        event,
        repository,
      },
      api,
      dependencies.attachmentFetch ?? globalThis.fetch,
    )
    await Bun.write(options.resultFile, `${JSON.stringify(result)}\n`)
    return 0
  }
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
    api,
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

interface DecodedSnapshotEvent extends DecodedIssueEvent {
  issue: DecodedIssueEvent["issue"] & {
    body: string
    commentCount: number
    title: string
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

function decodeSnapshotEvent(value: unknown): DecodedSnapshotEvent {
  const decoded = decodeIssueEvent(value)
  const issue = record(record(value).issue)
  return {
    ...decoded,
    issue: {
      ...decoded.issue,
      body: issue.body === null ? "" : string(issue.body, "issue body"),
      commentCount: nonnegativeInteger(issue.comments),
      title: string(issue.title, "issue title"),
    },
  }
}

function decodeAdmission(value: unknown): Admission {
  const admission = record(value)
  const repository = record(admission.repository)
  const issue = record(admission.issue)
  const run = record(admission.run)
  const marker = record(admission.marker)
  if (admission.version !== 1 || admission.status !== "admitted" || admission.phase !== "running")
    throw new Error("invalid admission")
  const label = nonemptyString(issue.label, "admission issue label")
  if (!isExecutionLabel(label)) throw new Error("invalid admission")
  const result: Admission = {
    version: 1,
    status: "admitted",
    phase: "running",
    key: idempotencyKey(admission.key),
    repository: {
      id: positiveInteger(repository.id),
      nameWithOwner: nonemptyString(repository.nameWithOwner, "admission repository"),
      baseBranch: repository.baseBranch === "main" ? "main" : invalidAdmission(),
      baseSha: sha(repository.baseSha),
    },
    issue: {
      number: positiveInteger(issue.number),
      nodeId: nonemptyString(issue.nodeId, "admission issue node ID"),
      label,
      labelId: positiveInteger(issue.labelId),
      labelEventNodeId: nonemptyString(issue.labelEventNodeId, "admission label event node ID"),
      cutoff: timestamp(issue.cutoff),
    },
    run: {
      id: positiveInteger(run.id),
      attempt: positiveInteger(run.attempt),
    },
    marker: {
      commentId: positiveInteger(marker.commentId),
    },
  }
  const key = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([result.repository.id, result.issue.nodeId, result.issue.labelId, result.issue.labelEventNodeId]),
    )
    .digest("hex")
  if (result.key !== key) throw new Error("invalid admission")
  return result
}

function validateSnapshotBinding(admission: Admission, event: DecodedSnapshotEvent, repository: string) {
  const executionLabels = event.issue.labels.filter((label) => isExecutionLabel(label.name))
  if (
    event.action !== "labeled" ||
    !event.label ||
    admission.repository.nameWithOwner !== repository ||
    event.repository.id !== admission.repository.id ||
    event.repository.nameWithOwner !== admission.repository.nameWithOwner ||
    event.issue.number !== admission.issue.number ||
    event.issue.nodeId !== admission.issue.nodeId ||
    event.issue.state !== "open" ||
    event.issue.updatedAt !== admission.issue.cutoff ||
    event.label.id !== admission.issue.labelId ||
    event.label.name !== admission.issue.label ||
    executionLabels.length !== 1 ||
    executionLabels[0]?.id !== admission.issue.labelId ||
    executionLabels[0].name !== admission.issue.label
  )
    throw new Error("event does not match admission")
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

function decodeSnapshotComment(value: unknown): GitHubSnapshotComment {
  const comment = record(value)
  return {
    nodeId: nonemptyString(comment.node_id, "comment node ID"),
    author: parseLogin(record(comment.user).login),
    createdAt: timestamp(comment.created_at),
    updatedAt: timestamp(comment.updated_at),
    body: string(comment.body, "comment body"),
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
  if (!run) return false
  if (run.id !== previous.runId || run.attempt !== previous.attempt)
    throw new Error("Actions run attempt identity mismatch")
  const terminated =
    run?.status === "completed" &&
    run.conclusion !== null &&
    new Set(["failure", "cancelled", "timed_out", "startup_failure", "stale"]).has(run.conclusion)
  if (terminated) return true
  if (run?.status === "completed") return false
  const lastUpdate = Math.max(Date.parse(previous.updatedAt), Date.parse(run.updatedAt))
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

class IngestionStopped extends Error {
  constructor(readonly phase: "input_too_large" | "attachment_rejected") {
    super("issue ingestion stopped")
  }
}

function stopped(phase: "input_too_large" | "attachment_rejected"): IngestResult {
  return { version: 1, status: "stopped", phase }
}

function rejectAttachment(): never {
  throw new IngestionStopped("attachment_rejected")
}

function extractAttachmentCandidates(texts: string[]) {
  const candidates: string[] = []
  for (const text of texts) {
    const textCandidates: Array<{ offset: number; value: string }> = []
    const imageOffsets = new Set<number>()
    const definitions = new Map<string, string>()
    for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^<>\r\n]+)>|(\S+))/gm)) {
      const name = match[1]
      const destination = match[2] ?? match[3]
      if (name && destination) definitions.set(name.trim().toLowerCase(), trimUrlPunctuation(destination))
    }
    for (const match of text.matchAll(
      /!\[[^\]\r\n]*\]\(\s*(?:<([^<>\r\n]+)>|([^\s()<>]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?\s*\)/g,
    )) {
      imageOffsets.add(match.index)
      textCandidates.push({ offset: match.index, value: match[1] ?? match[2] ?? rejectAttachment() })
    }
    for (const match of text.matchAll(/!\[[^\]\r\n]*\]\[([^\]\r\n]+)\]/g)) {
      imageOffsets.add(match.index)
      const destination = match[1] ? definitions.get(match[1].trim().toLowerCase()) : undefined
      if (!destination) rejectAttachment()
      textCandidates.push({ offset: match.index, value: destination })
    }
    for (let offset = text.indexOf("!["); offset >= 0; offset = text.indexOf("![", offset + 2)) {
      if ((offset === 0 || text[offset - 1] !== "\\") && !imageOffsets.has(offset)) rejectAttachment()
    }
    const htmlImageOffsets = new Set<number>()
    for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
      htmlImageOffsets.add(match.index)
      const sources = [...match[0].matchAll(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
      const source = sources[0]?.[1] ?? sources[0]?.[2]
      if (sources.length !== 1 || !source) rejectAttachment()
      textCandidates.push({ offset: match.index, value: source })
    }
    for (const match of text.matchAll(/<img\b/gi)) {
      if (!htmlImageOffsets.has(match.index)) rejectAttachment()
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      const candidate = trimUrlPunctuation(match[0])
      if (looksLikeAttachmentCandidate(candidate)) textCandidates.push({ offset: match.index, value: candidate })
    }
    candidates.push(
      ...textCandidates.sort((left, right) => left.offset - right.offset).map((candidate) => candidate.value),
    )
  }
  const urls = new Map<string, URL>()
  for (const candidate of candidates) {
    const url = validateAttachmentUrl(candidate, true)
    urls.set(url.href, url)
    if (urls.size > maximumAttachmentCandidates) rejectAttachment()
  }
  return [...urls.values()]
}

function trimUrlPunctuation(value: string) {
  return value.replace(/[),.;:!?]+$/, "")
}

function looksLikeAttachmentCandidate(value: string) {
  if (!URL.canParse(value)) return /(?:github\.com|(?:private-)?user-images\.githubusercontent\.com)/i.test(value)
  const url = new URL(value)
  if (!attachmentSourceHosts.has(url.hostname)) return false
  if (url.hostname !== "github.com") return true
  return /\/(?:user-attachments|assets)(?:\/|$)/.test(url.pathname)
}

function validateAttachmentUrl(value: string, source: boolean, base?: URL) {
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) rejectAttachment()
  validateRawPath(value)
  let url: URL
  try {
    url = base ? new URL(value, base) : new URL(value)
  } catch {
    rejectAttachment()
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    value.includes("#") ||
    (source && value.includes("?")) ||
    !(source ? attachmentSourceHosts : attachmentRedirectHosts).has(url.hostname)
  )
    rejectAttachment()
  if (source && !isAllowedSourcePath(url)) rejectAttachment()
  return url
}

function validateRawPath(value: string) {
  const path = value.replace(/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]*/, "").split(/[?#]/, 1)[0] ?? ""
  if (/%(?:2f|5c)/i.test(path)) rejectAttachment()
  for (const segment of path.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      rejectAttachment()
    }
    if (decoded === "." || decoded === ".." || /[/\\\u0000-\u001f\u007f]/.test(decoded)) rejectAttachment()
  }
}

function isAllowedSourcePath(url: URL) {
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return false
  }
  const safeName = "[A-Za-z0-9][A-Za-z0-9._-]{0,254}"
  if (url.hostname === "github.com") {
    if (/^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path))
      return true
    return new RegExp(`^/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}/assets/[1-9]\\d*/${safeName}$`).test(path)
  }
  return new RegExp(`^/[1-9]\\d*/[1-9]\\d*-${safeName}$`).test(path)
}

async function downloadAttachments(sources: URL[], request: GitHubFetch) {
  const downloads: Array<{
    content: Uint8Array
    extension: string
    mediaType: string
    sha256: string
    sourceUrl: string
  }> = []
  const hashes = new Set<string>()
  let totalBytes = 0
  for (const source of sources) {
    const downloaded = await downloadAttachment(source, request)
    const sha256 = new Bun.CryptoHasher("sha256").update(downloaded.content).digest("hex")
    if (hashes.has(sha256)) continue
    hashes.add(sha256)
    if (hashes.size > maximumAttachments || totalBytes + downloaded.content.byteLength > maximumTotalAttachmentBytes)
      rejectAttachment()
    totalBytes += downloaded.content.byteLength
    downloads.push({ ...downloaded, sha256, sourceUrl: source.href })
  }
  return downloads
}

async function downloadAttachment(source: URL, request: GitHubFetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), attachmentTimeoutMs)
  const visited = new Set<string>()
  let url = source
  try {
    for (let redirects = 0; redirects <= maximumRedirects; redirects++) {
      if (visited.has(url.href)) rejectAttachment()
      visited.add(url.href)
      const response = await request(url, {
        headers: {
          Accept: "image/png,image/jpeg,image/webp,image/gif,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "identity",
        },
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      }).catch(() => rejectAttachment())
      if (new Set([301, 302, 303, 307, 308]).has(response.status)) {
        await response.body?.cancel().catch(() => {})
        const location = response.headers.get("location")
        if (!location || redirects === maximumRedirects) rejectAttachment()
        url = validateAttachmentUrl(location, false, url)
        continue
      }
      if (!response.ok || !response.body) rejectAttachment()
      const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase()
      if (contentEncoding && contentEncoding !== "identity") rejectAttachment()
      const declaredLength = response.headers.get("content-length")
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumAttachmentBytes))
        rejectAttachment()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const chunk = await reader.read().catch(() => rejectAttachment())
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > maximumAttachmentBytes) {
          await reader.cancel().catch(() => {})
          rejectAttachment()
        }
        chunks.push(chunk.value)
      }
      const content = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        content.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { content, ...sniffAttachment(content, response.headers.get("content-type")) }
    }
    return rejectAttachment()
  } finally {
    clearTimeout(timer)
  }
}

function sniffAttachment(content: Uint8Array, contentType: string | null) {
  const declared = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (
    declared &&
    new Set([
      "application/gzip",
      "application/pdf",
      "application/x-7z-compressed",
      "application/x-executable",
      "application/x-rar-compressed",
      "application/x-tar",
      "application/zip",
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
    ]).has(declared)
  )
    rejectAttachment()
  if (startsWithBytes(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { extension: "png", mediaType: "image/png" }
  if (startsWithBytes(content, [0xff, 0xd8, 0xff])) return { extension: "jpg", mediaType: "image/jpeg" }
  if (
    new TextDecoder().decode(content.slice(0, 6)) === "GIF87a" ||
    new TextDecoder().decode(content.slice(0, 6)) === "GIF89a"
  )
    return { extension: "gif", mediaType: "image/gif" }
  if (
    new TextDecoder().decode(content.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(content.slice(8, 12)) === "WEBP"
  )
    return { extension: "webp", mediaType: "image/webp" }
  if (isRejectedBinary(content)) rejectAttachment()
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch {
    rejectAttachment()
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) rejectAttachment()
  let start = text.trimStart().toLowerCase()
  while (start.startsWith("<!--") && start.includes("-->")) start = start.slice(start.indexOf("-->") + 3).trimStart()
  if (
    start.startsWith("%pdf-") ||
    start.startsWith("<?xml") ||
    /^<(?:!doctype\s+html|svg|html|head|body|script|iframe|object|embed|form|div|span|p|a|img|table|style|link|meta|title|template|h[1-6])(?:\s|\/?>)/.test(
      start,
    )
  )
    rejectAttachment()
  try {
    JSON.parse(text)
    return { extension: "json", mediaType: "application/json" }
  } catch {
    if (declared === "application/json") rejectAttachment()
  }
  return declared === "text/markdown" || declared === "text/x-markdown"
    ? { extension: "md", mediaType: "text/markdown" }
    : { extension: "txt", mediaType: "text/plain" }
}

function startsWithBytes(content: Uint8Array, prefix: number[]) {
  return content.byteLength >= prefix.length && prefix.every((value, index) => content[index] === value)
}

function isRejectedBinary(content: Uint8Array) {
  const first4 = content.slice(0, 4)
  const magic = [...first4].map((value) => value.toString(16).padStart(2, "0")).join("")
  return (
    startsWithBytes(content, [0x25, 0x50, 0x44, 0x46]) ||
    startsWithBytes(content, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(content, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(content, [0x50, 0x4b, 0x07, 0x08]) ||
    startsWithBytes(content, [0x1f, 0x8b]) ||
    startsWithBytes(content, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWithBytes(content, [0x4d, 0x5a]) ||
    startsWithBytes(content, [0x23, 0x21]) ||
    new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe"]).has(magic) ||
    (content.byteLength >= 262 && new TextDecoder().decode(content.slice(257, 262)) === "ustar")
  )
}

async function prepareBundleDirectory(bundleDir: string, checkoutDir: string) {
  if (!isAbsolute(bundleDir) || resolve(bundleDir) !== bundleDir) throw new Error("invalid issue bundle path")
  const requestedParent = dirname(bundleDir)
  const parent = await realpath(requestedParent)
  const bundle = join(parent, basename(bundleDir))
  const checkout = await realpath(checkoutDir)
  const fromCheckout = relative(checkout, bundle)
  if (!fromCheckout || (!fromCheckout.startsWith("..") && !isAbsolute(fromCheckout)))
    throw new Error("issue bundle must be outside checkout")
  await mkdir(bundle, { mode: 0o700 })
  return bundle
}

async function readBoundedUtf8File(path: string, limit: number, name: string) {
  const file = Bun.file(path)
  if (file.size > limit) throw new Error(`${name} is too large`)
  const reader = file.stream().getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const chunk = await reader.read().catch(() => {
      throw new Error(`failed to read ${name}`)
    })
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(`${name} is too large`)
    }
    chunks.push(chunk.value)
  }
  const content = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch {
    throw new Error(`invalid ${name} encoding`)
  }
}

function ensureWellFormedText(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) throw new Error("invalid Unicode text")
      index++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid Unicode text")
  }
}

function invalidAdmission(): never {
  throw new Error("invalid admission")
}

function rejected(phase: "rejected_actor" | "ambiguous_label" | "stale_base"): AdmissionResult {
  return { version: 1, status: "rejected", phase }
}

function parseCli(args: string[]) {
  if (args[0] === "ingest") {
    const values = parseOptions(args, new Set(["--event-file", "--admission-file", "--bundle-dir", "--result-file"]))
    const eventFile = values.get("--event-file")
    const admissionFile = values.get("--admission-file")
    const bundleDir = values.get("--bundle-dir")
    const resultFile = values.get("--result-file")
    if (!eventFile || !admissionFile || !bundleDir || !resultFile) throw new Error("missing oc2-issue option")
    return { command: "ingest" as const, eventFile, admissionFile, bundleDir, resultFile }
  }
  if (args[0] !== "admit") throw new Error("invalid oc2-issue command")
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
  return { command: "admit" as const, eventFile, resultFile, botId, publisherBotId, allowedBotIds }
}

function parseOptions(args: string[], allowed: ReadonlySet<string>) {
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name || !value || !allowed.has(name) || values.has(name)) throw new Error("invalid oc2-issue option")
    values.set(name, value)
  }
  return values
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

function nonnegativeInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid nonnegative integer")
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
