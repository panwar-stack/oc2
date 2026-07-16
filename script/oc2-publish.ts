#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { decodeAdmission } from "./oc2-automation-workflow"
import {
  decodeProvenancePullRequest,
  decodeRuleset,
  requireAutomationPullRequest,
  validateRepositorySettings,
  type ProvenancePullRequest,
  type RepositorySettings,
  type Ruleset,
} from "./oc2-automation-provenance"
import { createGitHubApi, updateRunIssueMarker, type Admission, type IssuePhase } from "./oc2-issue"
import { validatePatch, type ValidatedPatch } from "./oc2-verify"

const shaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const maximumJsonBytes = 64 * 1024
const maximumResponseBytes = 2 * 1024 * 1024
const maximumPages = 100
const decoder = new TextDecoder("utf-8", { fatal: true })

interface VerificationManifest {
  version: 1
  repository: { id: number; nameWithOwner: string }
  baseSha: string
  patchSha256: string
  treeSha: string
}

interface PublicationManifest {
  version: 1
  repository: { id: number; nameWithOwner: string }
  issue: { number: number }
  key: string
  baseSha: string
  patchSha256: string
  treeSha: string
  artifacts: { generationSha256: string; patchSha256: string; verificationSha256: string }
}

export interface PullRequest {
  id: number
  number: number
  url: string
  userId: number
  title: string
  body: string
  headSha: string
  headRef: string
  headRepositoryId: number
  baseRef: string
  baseSha: string
  baseRepositoryId: number
}

export interface PublisherApi {
  getPublisherIdentity(appSlug: string): Promise<{ id: number; login: string; type: string }>
  getRepository(): Promise<RepositorySettings>
  getRef(branch: string): Promise<string | undefined>
  getCommit(sha: string): Promise<{
    message: string
    author: { name: string; email: string }
    committer: { name: string; email: string }
  }>
  listOpenPullRequests(branch: string): Promise<PullRequest[]>
  createPullRequest(input: { title: string; body: string; branch: string }): Promise<PullRequest>
  updatePullRequest(input: { number: number; title: string; body: string }): Promise<PullRequest>
  closePullRequest(number: number): Promise<PullRequest>
  getPullRequest(number: number): Promise<ProvenancePullRequest>
  listRulesets(): Promise<Ruleset[]>
  getAutoMergeState(number: number): Promise<{
    number: number
    state: string
    headSha: string
    autoMergeMethod?: string
    queuePullRequestNumber?: number
    queuePullRequestHeadSha?: string
    queueHeadSha?: string
  }>
}

export interface PublicationStateInput {
  admitResult: string
  ingestResult: string
  ingestState: string
  generateResult: string
  generateState: string
  verifyResult: string
  verifyState: string
  publishResult: string
  publishState: string
  autoMergeResult: string
  autoMergeState: string
}

export class PublicationStopped extends Error {
  constructor(readonly phase: "stale_base" | "push_race") {
    super(phase)
  }
}

function exactKeys(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid publication input")
  return value
}

function boundedString(value: unknown, maximum = 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("invalid publication input")
  return value
}

function boundedBody(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)
  )
    throw new Error("invalid publication input")
  return value
}

function responseRecord(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function responseBoolean(value: unknown, message: string) {
  if (typeof value !== "boolean") throw new Error(message)
  return value
}

function sha(value: unknown) {
  const result = boundedString(value)
  if (!shaPattern.test(result)) throw new Error("invalid publication input")
  return result
}

function sha256(value: unknown) {
  const result = boundedString(value)
  if (!sha256Pattern.test(result)) throw new Error("invalid publication input")
  return result
}

async function readRegular(path: string, maximum: number) {
  if (!isAbsolute(path)) throw new Error("publication paths must be absolute")
  const before = await lstat(path)
  if (!before.isFile() || before.size < 1 || before.size > maximum) throw new Error("invalid publication artifact")
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.size !== before.size || current.dev !== before.dev || current.ino !== before.ino)
      throw new Error("invalid publication artifact")
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.byteLength !== current.size) throw new Error("invalid publication artifact")
    return bytes
  } finally {
    await handle.close()
  }
}

function parseJson(bytes: Uint8Array) {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown
  } catch {
    throw new Error("invalid publication artifact")
  }
}

export function decodeVerification(source: string): VerificationManifest {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("invalid verification artifact")
  }
  if (
    !exactKeys(value, ["version", "repository", "baseSha", "patchSha256", "treeSha"]) ||
    !exactKeys(value.repository, ["id", "nameWithOwner"]) ||
    value.version !== 1 ||
    typeof value.repository.nameWithOwner !== "string" ||
    !repositoryPattern.test(value.repository.nameWithOwner)
  )
    throw new Error("invalid verification artifact")
  return {
    version: 1,
    repository: { id: positiveInteger(value.repository.id), nameWithOwner: value.repository.nameWithOwner },
    baseSha: sha(value.baseSha),
    patchSha256: sha256(value.patchSha256),
    treeSha: sha(value.treeSha),
  }
}

function decodePublication(value: unknown): PublicationManifest {
  if (
    !exactKeys(value, ["version", "repository", "issue", "key", "baseSha", "patchSha256", "treeSha", "artifacts"]) ||
    !exactKeys(value.repository, ["id", "nameWithOwner"]) ||
    !exactKeys(value.issue, ["number"]) ||
    !exactKeys(value.artifacts, ["generationSha256", "patchSha256", "verificationSha256"]) ||
    value.version !== 1 ||
    typeof value.repository.nameWithOwner !== "string" ||
    !repositoryPattern.test(value.repository.nameWithOwner)
  )
    throw new Error("invalid publication manifest")
  return {
    version: 1,
    repository: { id: positiveInteger(value.repository.id), nameWithOwner: value.repository.nameWithOwner },
    issue: { number: positiveInteger(value.issue.number) },
    key: sha256(value.key),
    baseSha: sha(value.baseSha),
    patchSha256: sha256(value.patchSha256),
    treeSha: sha(value.treeSha),
    artifacts: {
      generationSha256: sha256(value.artifacts.generationSha256),
      patchSha256: sha256(value.artifacts.patchSha256),
      verificationSha256: sha256(value.artifacts.verificationSha256),
    },
  }
}

function admitted(source: string) {
  const value = decodeAdmission(source)
  if (value.status !== "admitted") throw new Error("publication was not admitted")
  return value
}

function validateBinding(admission: Admission, validated: ValidatedPatch, verification: VerificationManifest) {
  if (
    admission.repository.id !== validated.manifest.repository.id ||
    admission.repository.nameWithOwner !== validated.manifest.repository.nameWithOwner ||
    admission.repository.baseSha !== validated.manifest.baseSha ||
    admission.issue.number !== validated.manifest.issue.number
  )
    throw new Error("publication artifact mismatch")
  requireVerifiedTree({
    repositoryId: validated.manifest.repository.id,
    repository: validated.manifest.repository.nameWithOwner,
    baseSha: validated.manifest.baseSha,
    patchSha256: validated.manifest.patch.sha256,
    treeSha: validated.treeSha,
    verification,
  })
}

export function requireVerifiedTree(input: {
  repositoryId: number
  repository: string
  baseSha: string
  patchSha256: string
  treeSha: string
  verification: VerificationManifest
}) {
  if (
    input.verification.repository.id !== input.repositoryId ||
    input.verification.repository.nameWithOwner !== input.repository ||
    input.verification.baseSha !== input.baseSha ||
    input.verification.patchSha256 !== input.patchSha256 ||
    input.verification.treeSha !== input.treeSha
  )
    throw new Error("verification tree mismatch")
}

async function atomicWrite(path: string, value: unknown) {
  const parent = await realpath(dirname(path))
  const target = join(parent, basename(path))
  if (await Bun.file(target).exists()) throw new Error("publication output already exists")
  const temporary = join(parent, `.oc2-publication-${randomBytes(12).toString("hex")}.tmp`)
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  await file.writeFile(`${JSON.stringify(value)}\n`).finally(() => file.close())
  await link(temporary, target).finally(() => rm(temporary, { force: true }))
}

export async function preparePublication(input: {
  admissionPath: string
  generationPath: string
  patchPath: string
  verificationPath: string
  outputPath: string
  repository: string
  repositoryId: number
  baseSha: string
  key: string
  cwd: string
}) {
  const [admissionBytes, generationBytes, patchBytes, verificationBytes] = await Promise.all([
    readRegular(input.admissionPath, maximumJsonBytes),
    readRegular(input.generationPath, maximumJsonBytes),
    readRegular(input.patchPath, 2 * 1024 * 1024),
    readRegular(input.verificationPath, maximumJsonBytes),
  ])
  const admission = admitted(decoder.decode(admissionBytes))
  if (
    admission.repository.nameWithOwner !== input.repository ||
    admission.repository.id !== input.repositoryId ||
    admission.repository.baseSha !== input.baseSha ||
    admission.key !== input.key
  )
    throw new Error("publication identity mismatch")
  await validateCleanCheckout(input.cwd, input.baseSha)
  const validated = await validatePatch({
    generationPath: input.generationPath,
    patchPath: input.patchPath,
    repository: input.repository,
    repositoryId: input.repositoryId,
    baseSha: input.baseSha,
    cwd: input.cwd,
  })
  const verification = decodeVerification(decoder.decode(verificationBytes))
  validateBinding(admission, validated, verification)
  const manifest: PublicationManifest = {
    version: 1,
    repository: validated.manifest.repository,
    issue: { number: admission.issue.number },
    key: admission.key,
    baseSha: validated.manifest.baseSha,
    patchSha256: validated.manifest.patch.sha256,
    treeSha: verification.treeSha,
    artifacts: {
      generationSha256: createHash("sha256").update(generationBytes).digest("hex"),
      patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
      verificationSha256: createHash("sha256").update(verificationBytes).digest("hex"),
    },
  }
  await atomicWrite(input.outputPath, manifest)
  return manifest
}

function gitEnvironment(home: string, extra: Readonly<Record<string, string>> = {}) {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...extra,
  }
}

async function git(
  cwd: string,
  home: string,
  args: ReadonlyArray<string>,
  options: { input?: string | Uint8Array; env?: Readonly<Record<string, string>>; allowFailure?: boolean } = {},
) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: gitEnvironment(home, options.env),
      stdin:
        options.input === undefined
          ? "ignore"
          : typeof options.input === "string"
            ? new TextEncoder().encode(options.input)
            : options.input,
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()])
  if (stdout.byteLength > 8 * 1024 * 1024 || (!options.allowFailure && exitCode !== 0))
    throw new Error("publication Git command failed")
  return { exitCode, stdout: decoder.decode(stdout) }
}

async function validateCleanCheckout(cwd: string, baseSha: string) {
  const root = await realpath(cwd)
  const temporary = await mkdtemp(join(tmpdir(), "oc2-publish-clean-"))
  try {
    if ((await realpath(join(root, ".git"))) !== join(root, ".git") || !(await lstat(join(root, ".git"))).isDirectory())
      throw new Error("invalid publication checkout")
    const topLevel = (
      await git(root, temporary, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
    ).stdout.trim()
    const head = (await git(root, temporary, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim()
    const status = await git(root, temporary, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    const ignored = await git(root, temporary, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ])
    if (topLevel !== root || head !== baseSha || status.stdout.length !== 0 || ignored.stdout.length !== 0)
      throw new Error("publication checkout is not the clean base")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function branchName(issueNumber: number, key: string) {
  positiveInteger(issueNumber)
  sha256(key)
  return `oc2/issue-${issueNumber}-${key.slice(0, 12)}`
}

function commitMessage(issueNumber: number, key: string) {
  return `OC2 issue #${positiveInteger(issueNumber)}\n\nAutomation-Key: ${sha256(key)}\n`
}

export function pushArguments(remote: string, branch: string, commitSha: string | undefined, expectedSha?: string) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(remote))
    throw new Error("invalid publication remote")
  if (!/^oc2\/issue-[1-9]\d*-[0-9a-f]{12}$/.test(branch)) throw new Error("invalid publication branch")
  if (commitSha !== undefined) sha(commitSha)
  if (expectedSha !== undefined) sha(expectedSha)
  return [
    "push",
    `--force-with-lease=refs/heads/${branch}:${expectedSha ?? ""}`,
    remote,
    `${commitSha ?? ""}:refs/heads/${branch}`,
  ]
}

export function pullRequestText(
  issueNumber: number,
  runUrl: string,
  baseSha: string,
  headSha: string,
  patchSha256: string,
) {
  positiveInteger(issueNumber)
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*(?:\/attempts\/[1-9]\d*)?$/.test(
      runUrl,
    )
  )
    throw new Error("invalid publication run URL")
  return {
    title: `OC2 issue #${issueNumber}`,
    body: `Issue: #${issueNumber}\nRun: ${runUrl}\nBase: ${sha(baseSha)}\nHead: ${sha(headSha)}\nPatch: ${sha256(patchSha256)}`,
  }
}

function ownedPullRequest(
  pullRequest: PullRequest,
  expected: {
    publisherBotId: number
    repositoryId: number
    branch: string
    headSha: string
    title: string
    body: string
  },
) {
  return (
    pullRequest.userId === expected.publisherBotId &&
    pullRequest.headRepositoryId === expected.repositoryId &&
    pullRequest.headRef === expected.branch &&
    pullRequest.headSha === expected.headSha &&
    pullRequest.baseRef === "main" &&
    pullRequest.baseRepositoryId === expected.repositoryId &&
    pullRequest.title === expected.title &&
    pullRequest.body === expected.body
  )
}

export function requireRepositoryBase(
  expected: { repositoryId: number; repository: string; baseSha: string },
  actual: { id: number; nameWithOwner: string; defaultBranch: string; mainSha: string | undefined },
) {
  if (
    actual.id !== expected.repositoryId ||
    actual.nameWithOwner !== expected.repository ||
    actual.defaultBranch !== "main" ||
    actual.mainSha !== expected.baseSha
  )
    throw new PublicationStopped("stale_base")
}

export function requireBranchLease(input: {
  branchSha: string | undefined
  pullRequests: ReadonlyArray<PullRequest>
  publisherBotId: number
  repositoryId: number
  branch: string
  issueNumber: number
  runUrl: string
  baseSha: string
  patchSha256: string
  key: string
  appSlug: string
  commit?: { message: string; author: { name: string; email: string }; committer: { name: string; email: string } }
}) {
  if (input.branchSha === undefined) {
    if (input.pullRequests.length !== 0) throw new PublicationStopped("push_race")
    return undefined
  }
  const text = pullRequestText(input.issueNumber, input.runUrl, input.baseSha, input.branchSha, input.patchSha256)
  const name = `${input.appSlug}[bot]`
  const email = `${positiveInteger(input.publisherBotId)}+${name}@users.noreply.github.com`
  const message = commitMessage(input.issueNumber, input.key)
  if (
    !input.commit ||
    (input.commit.message !== message && input.commit.message !== message.slice(0, -1)) ||
    input.commit.author.name !== name ||
    input.commit.author.email !== email ||
    input.commit.committer.name !== name ||
    input.commit.committer.email !== email ||
    input.pullRequests.length !== 1 ||
    !ownedPullRequest(input.pullRequests[0]!, {
      publisherBotId: input.publisherBotId,
      repositoryId: input.repositoryId,
      branch: input.branch,
      headSha: input.branchSha,
      ...text,
    })
  )
    throw new PublicationStopped("push_race")
  return input.branchSha
}

function decodePullRequest(value: unknown): PullRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pull request response")
  const item = value as Record<string, unknown>
  const user = item.user as Record<string, unknown> | undefined
  const head = item.head as Record<string, unknown> | undefined
  const base = item.base as Record<string, unknown> | undefined
  const headRepo = head?.repo as Record<string, unknown> | undefined
  return {
    id: positiveInteger(item.id),
    number: positiveInteger(item.number),
    url: boundedString(item.html_url),
    userId: positiveInteger(user?.id),
    title: boundedString(item.title, 256),
    body: boundedBody(item.body),
    headSha: sha(head?.sha),
    headRef: boundedString(head?.ref, 256),
    headRepositoryId: positiveInteger(headRepo?.id),
    baseRef: boundedString(base?.ref, 256),
    baseSha: sha(base?.sha),
    baseRepositoryId: positiveInteger((base?.repo as Record<string, unknown> | undefined)?.id),
  }
}

export function createPublisherApi(input: {
  token: string
  repository: string
  baseUrl?: string
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}): PublisherApi {
  if (!input.token || !repositoryPattern.test(input.repository)) throw new Error("invalid publisher configuration")
  const baseUrl = new URL(input.baseUrl ?? "https://api.github.com")
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    throw new Error("invalid publisher API URL")
  const root = baseUrl.href.replace(/\/$/, "")
  const repositoryPath = `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`
  const request = input.fetch ?? globalThis.fetch

  async function call(path: string, options: { method?: "POST" | "PATCH"; body?: unknown; missing?: boolean } = {}) {
    const response = await request(`${root}${path}`, {
      method: options.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        "User-Agent": "oc2-issue-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }).catch(() => {
      throw new Error("publisher API request failed")
    })
    if (options.missing && response.status === 404) return undefined
    if (!response.ok || !response.body) throw new Error("publisher API request failed")
    const declared = response.headers.get("content-length")
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumResponseBytes))
      throw new Error("publisher API response too large")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumResponseBytes) throw new Error("publisher API response too large")
    return parseJson(bytes)
  }

  return {
    async getPublisherIdentity(appSlug) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(appSlug)) throw new Error("invalid publisher identity")
      const login = `${appSlug}[bot]`
      const value = await call(`/users/${encodeURIComponent(login)}`)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid publisher identity")
      const item = value as Record<string, unknown>
      return { id: positiveInteger(item.id), login: boundedString(item.login), type: boundedString(item.type) }
    },
    async getRepository() {
      const value = await call(repositoryPath)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid repository response")
      const item = value as Record<string, unknown>
      return {
        id: positiveInteger(item.id),
        nameWithOwner: boundedString(item.full_name),
        defaultBranch: boundedString(item.default_branch),
        allowAutoMerge: responseBoolean(item.allow_auto_merge, "invalid repository response"),
        rebaseMergeAllowed: responseBoolean(item.allow_rebase_merge, "invalid repository response"),
      }
    },
    async getRef(branch) {
      const value = await call(`${repositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`, { missing: true })
      if (value === undefined) return undefined
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ref response")
      const object = (value as Record<string, unknown>).object
      if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error("invalid ref response")
      return sha((object as Record<string, unknown>).sha)
    },
    async getCommit(commitSha) {
      const value = await call(`${repositoryPath}/git/commits/${sha(commitSha)}`)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid commit response")
      const item = value as Record<string, unknown>
      const author = item.author as Record<string, unknown> | undefined
      const committer = item.committer as Record<string, unknown> | undefined
      const message = item.message
      if (
        typeof message !== "string" ||
        message.length < 1 ||
        message.length > 1024 ||
        /[\u0000\r\u007f]/.test(message)
      )
        throw new Error("invalid commit response")
      return {
        message,
        author: { name: boundedString(author?.name), email: boundedString(author?.email) },
        committer: { name: boundedString(committer?.name), email: boundedString(committer?.email) },
      }
    },
    async listOpenPullRequests(branch) {
      const owner = input.repository.split("/")[0]!
      const value = await call(
        `${repositoryPath}/pulls?state=open&base=main&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
      )
      if (!Array.isArray(value)) throw new Error("invalid pull request response")
      return value.map(decodePullRequest)
    },
    async createPullRequest(value) {
      return decodePullRequest(
        await call(`${repositoryPath}/pulls`, {
          method: "POST",
          body: { title: value.title, body: value.body, head: value.branch, base: "main", draft: false },
        }),
      )
    },
    async updatePullRequest(value) {
      return decodePullRequest(
        await call(`${repositoryPath}/pulls/${positiveInteger(value.number)}`, {
          method: "PATCH",
          body: { title: value.title, body: value.body, base: "main" },
        }),
      )
    },
    async closePullRequest(number) {
      return decodePullRequest(
        await call(`${repositoryPath}/pulls/${positiveInteger(number)}`, {
          method: "PATCH",
          body: { state: "closed" },
        }),
      )
    },
    async getPullRequest(number) {
      return decodeProvenancePullRequest(await call(`${repositoryPath}/pulls/${positiveInteger(number)}`))
    },
    async listRulesets() {
      const ids: number[] = []
      for (let page = 1; page <= maximumPages; page++) {
        const value = await call(
          `${repositoryPath}/rulesets?includes_parents=true&targets=branch&per_page=100&page=${page}`,
        )
        if (!Array.isArray(value)) throw new Error("invalid repository rulesets response")
        ids.push(
          ...value.map((entry) => positiveInteger(responseRecord(entry, "invalid repository rulesets response").id)),
        )
        if (value.length < 100) break
      }
      if (ids.length >= maximumPages * 100 || new Set(ids).size !== ids.length)
        throw new Error("incomplete repository rulesets response")
      return Promise.all(
        ids.map(async (id) => decodeRuleset(await call(`${repositoryPath}/rulesets/${id}?includes_parents=true`))),
      )
    },
    async getAutoMergeState(number) {
      const [owner, name] = input.repository.split("/") as [string, string]
      const value = responseRecord(
        await call("/graphql", {
          method: "POST",
          body: {
            query:
              "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){databaseId nameWithOwner pullRequest(number:$number){number state headRefOid autoMergeRequest{mergeMethod} mergeQueueEntry{headCommit{oid} pullRequest{number headRefOid}}}}}",
            variables: { owner, name, number: positiveInteger(number) },
          },
        }),
        "invalid auto-merge response",
      )
      if (value.errors !== undefined) throw new Error("invalid auto-merge response")
      const repository = responseRecord(
        responseRecord(value.data, "invalid auto-merge response").repository,
        "invalid auto-merge response",
      )
      if (
        positiveInteger(repository.databaseId) < 1 ||
        boundedString(repository.nameWithOwner, 201) !== input.repository
      )
        throw new Error("invalid auto-merge response")
      const pullRequest = responseRecord(repository.pullRequest, "invalid auto-merge response")
      const autoMerge =
        pullRequest.autoMergeRequest === null
          ? undefined
          : responseRecord(pullRequest.autoMergeRequest, "invalid auto-merge response")
      const queue =
        pullRequest.mergeQueueEntry === null
          ? undefined
          : responseRecord(pullRequest.mergeQueueEntry, "invalid auto-merge response")
      const queuePullRequest = queue ? responseRecord(queue.pullRequest, "invalid auto-merge response") : undefined
      return {
        number: positiveInteger(pullRequest.number),
        state: boundedString(pullRequest.state, 32),
        headSha: sha(pullRequest.headRefOid),
        ...(autoMerge === undefined ? {} : { autoMergeMethod: boundedString(autoMerge.mergeMethod, 32) }),
        ...(queue === undefined
          ? {}
          : {
              queuePullRequestNumber: positiveInteger(queuePullRequest?.number),
              queuePullRequestHeadSha: sha(queuePullRequest?.headRefOid),
              queueHeadSha: sha(responseRecord(queue.headCommit, "invalid auto-merge response").oid),
            }),
      }
    },
  }
}

async function reproduceCandidate(input: {
  cwd: string
  patchBytes: Uint8Array
  manifest: PublicationManifest
  appSlug: string
  publisherBotId: number
}) {
  const cwd = await realpath(input.cwd)
  const temporary = await mkdtemp(join(tmpdir(), "oc2-publish-git-"))
  const candidate = join(temporary, "candidate")
  await git(cwd, temporary, ["clone", "--no-hardlinks", "--no-checkout", "--", cwd, candidate])
  const root = await realpath(candidate)
  await git(root, temporary, ["checkout", "--detach", input.manifest.baseSha])
  await git(root, temporary, ["apply", "--index", "--3way", "--binary", "--whitespace=nowarn", "--"], {
    input: input.patchBytes,
  })
  const treeSha = (await git(root, temporary, ["write-tree"])).stdout.trim()
  if (treeSha !== input.manifest.treeSha) throw new Error("published tree mismatch")
  const timestamp = (await git(root, temporary, ["show", "-s", "--format=%ct", input.manifest.baseSha])).stdout.trim()
  if (!/^[1-9]\d*$/.test(timestamp)) throw new Error("invalid base timestamp")
  const name = `${input.appSlug}[bot]`
  const email = `${positiveInteger(input.publisherBotId)}+${name}@users.noreply.github.com`
  const commitSha = (
    await git(root, temporary, ["commit-tree", treeSha, "-p", input.manifest.baseSha], {
      input: commitMessage(input.manifest.issue.number, input.manifest.key),
      env: {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: `${timestamp} +0000`,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: `${timestamp} +0000`,
      },
    })
  ).stdout.trim()
  sha(commitSha)
  return { root, temporary, commitSha }
}

async function pushWithLease(input: {
  cwd: string
  home: string
  remote: string
  branch: string
  commitSha?: string
  expectedSha?: string
  token: string
}) {
  const askpassDir = join(input.home, "askpass")
  const askpass = join(askpassDir, "git-askpass")
  await mkdir(askpassDir, { mode: 0o700 })
  await Bun.write(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) printf "%s\\n" "$OC2_PUBLISH_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
  )
  await chmod(askpass, 0o700)
  const result = await git(
    input.cwd,
    input.home,
    pushArguments(input.remote, input.branch, input.commitSha, input.expectedSha),
    {
      allowFailure: true,
      env: {
        GIT_ASKPASS: askpass,
        GIT_ASKPASS_REQUIRE: "force",
        OC2_PUBLISH_TOKEN: input.token,
      },
    },
  ).finally(() => rm(askpassDir, { recursive: true, force: true }))
  return result.exitCode === 0
}

async function rollbackBranch(input: {
  cwd: string
  home: string
  remote: string
  branch: string
  currentSha: string
  previousSha?: string
  token: string
}) {
  return pushWithLease({
    ...input,
    commitSha: input.previousSha,
    expectedSha: input.currentSha,
  }).catch(() => false)
}

export async function publishPrepared(input: {
  publicationPath: string
  admissionPath: string
  generationPath: string
  patchPath: string
  verificationPath: string
  cwd: string
  runUrl: string
  appSlug: string
  publisherBotId: number
  token: string
  api?: PublisherApi
}) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.appSlug) || !input.token)
    throw new Error("invalid publisher identity")
  const [publicationBytes, admissionBytes, generationBytes, patchBytes, verificationBytes] = await Promise.all([
    readRegular(input.publicationPath, maximumJsonBytes),
    readRegular(input.admissionPath, maximumJsonBytes),
    readRegular(input.generationPath, maximumJsonBytes),
    readRegular(input.patchPath, 2 * 1024 * 1024),
    readRegular(input.verificationPath, maximumJsonBytes),
  ])
  const manifest = decodePublication(parseJson(publicationBytes))
  const admission = admitted(decoder.decode(admissionBytes))
  if (
    admission.repository.id !== manifest.repository.id ||
    admission.repository.nameWithOwner !== manifest.repository.nameWithOwner ||
    admission.repository.baseSha !== manifest.baseSha ||
    admission.issue.number !== manifest.issue.number ||
    admission.key !== manifest.key ||
    createHash("sha256").update(generationBytes).digest("hex") !== manifest.artifacts.generationSha256 ||
    createHash("sha256").update(patchBytes).digest("hex") !== manifest.artifacts.patchSha256 ||
    createHash("sha256").update(verificationBytes).digest("hex") !== manifest.artifacts.verificationSha256
  )
    throw new Error("publication seal mismatch")
  const verification = decodeVerification(decoder.decode(verificationBytes))
  requireVerifiedTree({
    repositoryId: manifest.repository.id,
    repository: manifest.repository.nameWithOwner,
    baseSha: manifest.baseSha,
    patchSha256: manifest.patchSha256,
    treeSha: manifest.treeSha,
    verification,
  })

  const api = input.api ?? createPublisherApi({ token: input.token, repository: manifest.repository.nameWithOwner })
  const [publisher, repository, mainSha] = await Promise.all([
    api.getPublisherIdentity(input.appSlug),
    api.getRepository(),
    api.getRef("main"),
  ])
  if (
    publisher.id !== positiveInteger(input.publisherBotId) ||
    publisher.login !== `${input.appSlug}[bot]` ||
    publisher.type !== "Bot"
  )
    throw new Error("publisher identity mismatch")
  requireRepositoryBase(
    { repositoryId: manifest.repository.id, repository: manifest.repository.nameWithOwner, baseSha: manifest.baseSha },
    { ...repository, mainSha },
  )

  const candidate = await reproduceCandidate({
    cwd: input.cwd,
    patchBytes,
    manifest,
    appSlug: input.appSlug,
    publisherBotId: input.publisherBotId,
  })
  let branch = ""
  let remote = ""
  let previousSha: string | undefined
  let before: PullRequest[] = []
  let pushed = false
  let changedPullRequest: PullRequest | undefined
  try {
    branch = branchName(manifest.issue.number, manifest.key)
    remote = `https://github.com/${manifest.repository.nameWithOwner}.git`
    previousSha = await api.getRef(branch)
    before = await api.listOpenPullRequests(branch)
    requireBranchLease({
      branchSha: previousSha,
      commit: previousSha === undefined ? undefined : await api.getCommit(previousSha),
      pullRequests: before,
      publisherBotId: input.publisherBotId,
      repositoryId: manifest.repository.id,
      branch,
      issueNumber: manifest.issue.number,
      runUrl: input.runUrl,
      baseSha: manifest.baseSha,
      patchSha256: manifest.patchSha256,
      key: manifest.key,
      appSlug: input.appSlug,
    })
    if (previousSha !== candidate.commitSha) {
      if (
        !(await pushWithLease({
          cwd: candidate.root,
          home: candidate.temporary,
          remote,
          branch,
          commitSha: candidate.commitSha,
          expectedSha: previousSha,
          token: input.token,
        }))
      )
        throw new PublicationStopped("push_race")
      pushed = true
    }
    if ((await api.getRef(branch)) !== candidate.commitSha) throw new PublicationStopped("push_race")
    if ((await api.getRef("main")) !== manifest.baseSha) throw new PublicationStopped("stale_base")

    const text = pullRequestText(
      manifest.issue.number,
      input.runUrl,
      manifest.baseSha,
      candidate.commitSha,
      manifest.patchSha256,
    )
    const current = await api.listOpenPullRequests(branch)
    if (
      current.length !== before.length ||
      (current.length === 1 &&
        (before[0]!.id !== current[0]!.id ||
          current[0]!.userId !== input.publisherBotId ||
          current[0]!.headRepositoryId !== manifest.repository.id ||
          current[0]!.headRef !== branch ||
          current[0]!.headSha !== candidate.commitSha ||
          current[0]!.baseRef !== "main" ||
          current[0]!.baseSha !== manifest.baseSha ||
          current[0]!.baseRepositoryId !== manifest.repository.id))
    )
      throw new PublicationStopped("push_race")
    changedPullRequest = before[0]
      ? await api.updatePullRequest({ number: before[0].number, ...text })
      : await api.createPullRequest({ branch, ...text })
    if (changedPullRequest.baseSha !== manifest.baseSha) throw new PublicationStopped("stale_base")
    if (
      !ownedPullRequest(changedPullRequest, {
        publisherBotId: input.publisherBotId,
        repositoryId: manifest.repository.id,
        branch,
        headSha: candidate.commitSha,
        ...text,
      })
    )
      throw new PublicationStopped("push_race")
    const final = await api.listOpenPullRequests(branch)
    if (
      final.length !== 1 ||
      final[0]!.id !== changedPullRequest.id ||
      !ownedPullRequest(final[0]!, {
        publisherBotId: input.publisherBotId,
        repositoryId: manifest.repository.id,
        branch,
        headSha: candidate.commitSha,
        ...text,
      })
    )
      throw new PublicationStopped("push_race")
    return {
      phase: "pr_opened" as const,
      prId: final[0]!.id,
      prNumber: final[0]!.number,
      prUrl: final[0]!.url,
      branch,
      headSha: candidate.commitSha,
    }
  } catch (error) {
    if (changedPullRequest) {
      if (before[0]) {
        await api
          .updatePullRequest({ number: before[0].number, title: before[0].title, body: before[0].body })
          .catch(() => undefined)
      } else {
        await api.closePullRequest(changedPullRequest.number).catch(() => undefined)
      }
    } else if (before.length === 0 && branch) {
      const text = pullRequestText(
        manifest.issue.number,
        input.runUrl,
        manifest.baseSha,
        candidate.commitSha,
        manifest.patchSha256,
      )
      const created = await api.listOpenPullRequests(branch).catch(() => [])
      if (
        created.length === 1 &&
        ownedPullRequest(created[0]!, {
          publisherBotId: input.publisherBotId,
          repositoryId: manifest.repository.id,
          branch,
          headSha: candidate.commitSha,
          ...text,
        })
      )
        await api.closePullRequest(created[0]!.number).catch(() => undefined)
    }
    if (pushed)
      await rollbackBranch({
        cwd: candidate.root,
        home: candidate.temporary,
        remote,
        branch,
        currentSha: candidate.commitSha,
        previousSha,
        token: input.token,
      }).catch(() => false)
    throw error
  } finally {
    await rm(candidate.temporary, { recursive: true, force: true })
  }
}

export function requireExactAutoMergePullRequest(input: {
  pullRequest: ProvenancePullRequest
  repositoryId: number
  repository: string
  appId: number
  publisherBotId: number
  prId: number
  prNumber: number
  branch: string
  headSha: string
}) {
  const provenance = requireAutomationPullRequest({
    pullRequest: input.pullRequest,
    repositoryId: input.repositoryId,
    repository: input.repository,
    publisherBotId: input.publisherBotId,
    appId: input.appId,
    expectedNumber: input.prNumber,
    expectedHeadSha: input.headSha,
  })
  if (
    input.pullRequest.id !== input.prId ||
    input.pullRequest.headRef !== input.branch ||
    provenance.branch !== input.branch
  )
    throw new Error("auto-merge pull request changed")
  return provenance
}

async function runGhAutoMerge(input: { token: string; repository: string; prNumber: number; headSha: string }) {
  const home = await mkdtemp(join(tmpdir(), "oc2-gh-"))
  try {
    const child = Bun.spawn(
      [
        "gh",
        "pr",
        "merge",
        String(positiveInteger(input.prNumber)),
        "--repo",
        input.repository,
        "--auto",
        "--rebase",
        "--match-head-commit",
        sha(input.headSha),
      ],
      {
        cwd: home,
        env: {
          GH_CONFIG_DIR: join(home, "config"),
          GH_PROMPT_DISABLED: "1",
          GH_TOKEN: input.token,
          HOME: home,
          LANG: "C",
          LC_ALL: "C",
          NO_COLOR: "1",
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    return (await child.exited) === 0
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

export async function enablePreparedAutoMerge(input: {
  repository: string
  repositoryId: number
  appId: number
  publisherBotId: number
  prId: number
  prNumber: number
  branch: string
  headSha: string
  token: string
  settingsToken: string
  api?: PublisherApi
  merge?: (input: { token: string; repository: string; prNumber: number; headSha: string }) => Promise<boolean>
}) {
  if (!input.token || !input.settingsToken || !repositoryPattern.test(input.repository))
    throw new Error("invalid auto-merge configuration")
  positiveInteger(input.repositoryId)
  positiveInteger(input.appId)
  positiveInteger(input.publisherBotId)
  positiveInteger(input.prId)
  positiveInteger(input.prNumber)
  if (!/^oc2\/issue-[1-9]\d*-[0-9a-f]{12}$/.test(input.branch)) throw new Error("invalid auto-merge branch")
  sha(input.headSha)
  const api = input.api ?? createPublisherApi({ token: input.settingsToken, repository: input.repository })
  const [repository, rulesets, pullRequest, branchSha] = await Promise.all([
    api.getRepository(),
    api.listRulesets(),
    api.getPullRequest(input.prNumber),
    api.getRef(input.branch),
  ])
  validateRepositorySettings({
    repository,
    repositoryId: input.repositoryId,
    nameWithOwner: input.repository,
    appId: input.appId,
    rulesets,
  })
  requireExactAutoMergePullRequest({ ...input, pullRequest })
  if (branchSha !== input.headSha) throw new Error("auto-merge ref changed")

  const [current, currentBranchSha, currentRepository, currentRulesets] = await Promise.all([
    api.getPullRequest(input.prNumber),
    api.getRef(input.branch),
    api.getRepository(),
    api.listRulesets(),
  ])
  requireExactAutoMergePullRequest({ ...input, pullRequest: current })
  validateRepositorySettings({
    repository: currentRepository,
    repositoryId: input.repositoryId,
    nameWithOwner: input.repository,
    appId: input.appId,
    rulesets: currentRulesets,
  })
  if (currentBranchSha !== input.headSha) throw new Error("auto-merge ref changed")
  if (
    !(await (input.merge ?? runGhAutoMerge)({
      token: input.token,
      repository: input.repository,
      prNumber: input.prNumber,
      headSha: input.headSha,
    }))
  )
    throw new Error("auto-merge command rejected")

  const [final, finalBranchSha, state, finalRepository, finalRulesets] = await Promise.all([
    api.getPullRequest(input.prNumber),
    api.getRef(input.branch),
    api.getAutoMergeState(input.prNumber),
    api.getRepository(),
    api.listRulesets(),
  ])
  requireExactAutoMergePullRequest({ ...input, pullRequest: final })
  validateRepositorySettings({
    repository: finalRepository,
    repositoryId: input.repositoryId,
    nameWithOwner: input.repository,
    appId: input.appId,
    rulesets: finalRulesets,
  })
  const exactAutoMerge =
    state.autoMergeMethod === "REBASE" &&
    state.queuePullRequestNumber === undefined &&
    state.queuePullRequestHeadSha === undefined &&
    state.queueHeadSha === undefined
  const exactQueue =
    state.autoMergeMethod === undefined &&
    state.queuePullRequestNumber === input.prNumber &&
    state.queuePullRequestHeadSha === input.headSha &&
    state.queueHeadSha !== undefined
  if (
    finalBranchSha !== input.headSha ||
    state.number !== input.prNumber ||
    state.state !== "OPEN" ||
    state.headSha !== input.headSha ||
    (!exactAutoMerge && !exactQueue)
  )
    throw new Error("auto-merge state mismatch")
  return { phase: "auto_merge_enabled" as const }
}

export function deriveStatusPhase(input: PublicationStateInput): IssuePhase {
  const jobResults = new Set(["success", "failure", "cancelled", "skipped"])
  if (
    !jobResults.has(input.admitResult) ||
    !jobResults.has(input.ingestResult) ||
    !jobResults.has(input.generateResult) ||
    !jobResults.has(input.verifyResult) ||
    !jobResults.has(input.publishResult) ||
    !jobResults.has(input.autoMergeResult)
  )
    throw new Error("invalid job result")
  if (input.admitResult !== "success") return "tool_failed"
  if (input.ingestState === "input_too_large" || input.ingestState === "attachment_rejected") return input.ingestState
  if (input.ingestResult !== "success") return "tool_failed"
  if (
    input.generateState === "install_failed" ||
    input.generateState === "permission_denied" ||
    input.generateState === "tool_failed" ||
    input.generateState === "model_failed" ||
    input.generateState === "no_changes" ||
    input.generateState === "patch_rejected"
  )
    return input.generateState
  if (input.generateResult !== "success" || input.generateState !== "generated") return "model_failed"
  if (input.verifyState === "verification_failed" || input.verifyResult !== "success") return "verification_failed"
  if (input.verifyState !== "verified") return "verification_failed"
  if (input.publishState === "stale_base" || input.publishState === "push_race") return input.publishState
  if (input.publishState !== "pr_opened") return "push_race"
  if (input.autoMergeState === "auto_merge_enabled") return "auto_merge_enabled"
  return "auto_merge_unavailable"
}

async function appendOutputs(path: string, values: Readonly<Record<string, string>>) {
  if (Object.entries(values).some(([key, value]) => !/^[a-z_]+$/.test(key) || /[\r\n]/.test(value)))
    throw new Error("invalid publication output")
  await appendFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  )
}

function options(argv: ReadonlyArray<string>, allowed: ReadonlyArray<string>) {
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !value || !allowed.includes(key) || values.has(key)) throw new Error("invalid publication arguments")
    values.set(key, value)
  }
  if (values.size !== allowed.length) throw new Error("missing publication arguments")
  return Object.fromEntries(allowed.map((key) => [key.slice(2).replaceAll("-", "_"), values.get(key)!]))
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)) {
  if (argv[0] === "prepare") {
    const value = options(argv, [
      "--admission",
      "--generation",
      "--patch",
      "--verification",
      "--output",
      "--repository",
      "--repository-id",
      "--base-sha",
      "--key",
      "--checkout",
    ])
    await preparePublication({
      admissionPath: value.admission!,
      generationPath: value.generation!,
      patchPath: value.patch!,
      verificationPath: value.verification!,
      outputPath: value.output!,
      repository: value.repository!,
      repositoryId: positiveInteger(Number(value.repository_id)),
      baseSha: sha(value.base_sha),
      key: sha256(value.key),
      cwd: value.checkout!,
    })
    return
  }
  if (argv[0] === "publish") {
    const value = options(argv, [
      "--publication",
      "--admission",
      "--generation",
      "--patch",
      "--verification",
      "--checkout",
      "--run-url",
      "--app-slug",
      "--publisher-bot-id",
      "--github-output",
    ])
    const output = value.github_output!
    await publishPrepared({
      publicationPath: value.publication!,
      admissionPath: value.admission!,
      generationPath: value.generation!,
      patchPath: value.patch!,
      verificationPath: value.verification!,
      cwd: value.checkout!,
      runUrl: value.run_url!,
      appSlug: value.app_slug!,
      publisherBotId: positiveInteger(Number(value.publisher_bot_id)),
      token: process.env.OC2_PUBLISH_TOKEN ?? "",
    }).then(
      async (result) =>
        appendOutputs(output, {
          state: result.phase,
          pr_id: String(result.prId),
          pr_number: String(result.prNumber),
          pr_url: result.prUrl,
          branch: result.branch,
          head_sha: result.headSha,
          execute: "true",
        }),
      async (error) => {
        const phase = error instanceof PublicationStopped ? error.phase : "push_race"
        await appendOutputs(output, { state: phase, execute: "false" })
        if (!(error instanceof PublicationStopped)) throw error
      },
    )
    return
  }
  if (argv[0] === "auto-merge") {
    const value = options(argv, [
      "--repository",
      "--repository-id",
      "--app-id",
      "--publisher-bot-id",
      "--pr-id",
      "--pr-number",
      "--branch",
      "--head-sha",
      "--github-output",
    ])
    await enablePreparedAutoMerge({
      repository: value.repository!,
      repositoryId: positiveInteger(Number(value.repository_id)),
      appId: positiveInteger(Number(value.app_id)),
      publisherBotId: positiveInteger(Number(value.publisher_bot_id)),
      prId: positiveInteger(Number(value.pr_id)),
      prNumber: positiveInteger(Number(value.pr_number)),
      branch: value.branch!,
      headSha: sha(value.head_sha),
      token: process.env.OC2_PUBLISH_TOKEN ?? "",
      settingsToken: process.env.OC2_SETTINGS_TOKEN ?? "",
    }).then(
      async (result) => appendOutputs(value.github_output!, { state: result.phase, execute: "true" }),
      async (error) => {
        await appendOutputs(value.github_output!, { state: "auto_merge_unavailable", execute: "false" })
        throw error
      },
    )
    return
  }
  if (argv[0] === "status") {
    const value = options(argv, [
      "--event-file",
      "--repository",
      "--repository-id",
      "--run-id",
      "--run-attempt",
      "--bot-id",
      "--admit-result",
      "--ingest-result",
      "--ingest-state",
      "--generate-result",
      "--generate-state",
      "--verify-result",
      "--verify-state",
      "--publish-result",
      "--publish-state",
      "--auto-merge-result",
      "--auto-merge-state",
      "--pr-id",
    ])
    const repositoryId = positiveInteger(Number(value.repository_id))
    const phase = deriveStatusPhase({
      admitResult: value.admit_result!,
      ingestResult: value.ingest_result!,
      ingestState: value.ingest_state!,
      generateResult: value.generate_result!,
      generateState: value.generate_state!,
      verifyResult: value.verify_result!,
      verifyState: value.verify_state!,
      publishResult: value.publish_result!,
      publishState: value.publish_state!,
      autoMergeResult: value.auto_merge_result!,
      autoMergeState: value.auto_merge_state!,
    })
    const prId = value.pr_id === "none" ? undefined : positiveInteger(Number(value.pr_id))
    if (
      prId !== undefined &&
      !new Set<IssuePhase>(["pr_opened", "auto_merge_enabled", "auto_merge_unavailable"]).has(phase)
    )
      throw new Error("invalid status PR identity")
    await updateRunIssueMarker(
      {
        event: parseJson(await readRegular(value.event_file!, 2 * 1024 * 1024)),
        repository: value.repository!,
        repositoryId,
        runId: positiveInteger(Number(value.run_id)),
        runAttempt: positiveInteger(Number(value.run_attempt)),
        botId: positiveInteger(Number(value.bot_id)),
        phase,
        ...(prId === undefined ? {} : { prId }),
      },
      createGitHubApi({
        token: process.env.GITHUB_TOKEN ?? "",
        repository: value.repository!,
        baseUrl: process.env.GITHUB_API_URL,
      }),
    )
    return
  }
  throw new Error("invalid publication command")
}

if (import.meta.main) {
  await main().catch(() => {
    process.stderr.write("publication_failed\n")
    process.exitCode = 1
  })
}
