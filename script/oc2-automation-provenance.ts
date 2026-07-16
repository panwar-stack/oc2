#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { validateChangedPaths } from "./oc2-automation-policy"
import { maximumChangedFiles, maximumChangedLines, maximumPatchBytes } from "./oc2-verify"

const shaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const automationBranchPattern = /^oc2\/issue-([1-9][0-9]*)-([0-9a-f]{12})$/
const maximumResponseBytes = 8 * 1024 * 1024
const maximumPages = 100
const decoder = new TextDecoder("utf-8", { fatal: true })
export const githubActionsAppId = 15368

export const requiredStatusContexts = [
  "typecheck",
  "unit (linux)",
  "unit (windows)",
  "e2e (linux)",
  "e2e (windows)",
  "provenance/path-policy",
] as const

export interface ProvenancePullRequest {
  id: number
  number: number
  title: string
  body: string
  state: string
  draft: boolean
  userId: number
  userType: string
  headSha: string
  headRef: string
  headRepositoryId: number
  headRepository: string
  baseSha: string
  baseRef: string
  baseRepositoryId: number
  performedViaAppId?: number
}

export interface RepositorySettings {
  id: number
  nameWithOwner: string
  defaultBranch: string
  allowAutoMerge: boolean
  rebaseMergeAllowed: boolean
}

export interface Ruleset {
  id: number
  sourceType: string
  target: string
  enforcement: string
  bypassActorsVisible: boolean
  currentUserCanBypass: string
  bypassActors: Array<{ actorId: number | null; actorType: string; bypassMode: string }>
  conditions: { include: string[]; exclude: string[] }
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>
}

interface WorkflowRun {
  id: number
  attempt: number
  workflowId: number
  path: string
  name: string
  event: string
  headSha: string
  repositoryId: number
  repository: string
  headRepositoryId: number
  headRepository: string
}

interface WorkflowJob {
  id: number
  runId: number
  attempt: number
  name: string
  status: string
  conclusion: string | null
  headSha: string
}

interface WorkflowIdentity {
  id: number
  name: string
  path: string
  state: string
}

interface MergeQueueEntry {
  id: string
  position: number
  baseSha: string
  headSha: string
  pullRequestHeadSha: string
  pullRequestNumber: number
}

export interface ProvenanceApi {
  getPullRequest(number: number): Promise<ProvenancePullRequest>
  getWorkflowRunAttempt(runId: number, attempt: number): Promise<WorkflowRun>
  getWorkflowIdentity(): Promise<WorkflowIdentity>
  listWorkflowJobs(runId: number, attempt: number): Promise<WorkflowJob[]>
  listMergeQueueEntries(): Promise<MergeQueueEntry[]>
}

function record(value: unknown, message = "invalid provenance input") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>) {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function array(value: unknown, message = "invalid provenance input") {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

function positiveInteger(value: unknown, message = "invalid provenance input") {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(message)
  return value
}

function configurationId(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid provenance configuration")
  return value
}

function boundedString(value: unknown, maximum = 1024, message = "invalid provenance input") {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(message)
  return value
}

function body(value: unknown) {
  if (value === null) return ""
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value))
    throw new Error("invalid pull request provenance")
  return value
}

function sha(value: unknown, message = "invalid provenance input") {
  if (typeof value !== "string" || !shaPattern.test(value)) throw new Error(message)
  return value
}

function sha256(value: unknown, message = "invalid provenance input") {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(message)
  return value
}

function boolean(value: unknown, message = "invalid provenance input") {
  if (typeof value !== "boolean") throw new Error(message)
  return value
}

function stringArray(value: unknown, message = "invalid repository ruleset") {
  return array(value, message).map((item) => boundedString(item, 512, message))
}

function repositoryIdentity(value: unknown, message: string) {
  const item = record(value, message)
  const id = positiveInteger(item.id, message)
  const nameWithOwner = boundedString(item.full_name, 201, message)
  if (!repositoryPattern.test(nameWithOwner)) throw new Error(message)
  return { id, nameWithOwner }
}

export function parseAutomationPullRequestText(repository: string, title: string, source: string) {
  if (!repositoryPattern.test(repository)) throw new Error("invalid pull request provenance")
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = source.match(
    new RegExp(
      `^Issue: #([1-9][0-9]*)\\nRun: https://github\\.com/${escaped}/actions/runs/([1-9][0-9]*)/attempts/([1-9][0-9]*)\\nBase: ([0-9a-f]{40})\\nHead: ([0-9a-f]{40})\\nPatch: ([0-9a-f]{64})$`,
    ),
  )
  if (!match) throw new Error("invalid pull request provenance")
  const issueNumber = positiveInteger(Number(match[1]), "invalid pull request provenance")
  if (title !== `OC2 issue #${issueNumber}`) throw new Error("invalid pull request provenance")
  return {
    issueNumber,
    runId: positiveInteger(Number(match[2]), "invalid pull request provenance"),
    runAttempt: positiveInteger(Number(match[3]), "invalid pull request provenance"),
    baseSha: sha(match[4], "invalid pull request provenance"),
    headSha: sha(match[5], "invalid pull request provenance"),
    patchSha256: sha256(match[6], "invalid pull request provenance"),
  }
}

export function requireAutomationPullRequest(input: {
  pullRequest: ProvenancePullRequest
  repositoryId: number
  repository: string
  publisherBotId: number
  appId: number
  expectedNumber?: number
  expectedHeadSha?: string
}) {
  const branch = input.pullRequest.headRef.match(automationBranchPattern)
  if (!branch) throw new Error("invalid pull request provenance")
  const text = parseAutomationPullRequestText(input.repository, input.pullRequest.title, input.pullRequest.body)
  if (
    input.pullRequest.id < 1 ||
    input.pullRequest.number !== (input.expectedNumber ?? input.pullRequest.number) ||
    input.pullRequest.state !== "open" ||
    input.pullRequest.draft ||
    input.pullRequest.userId !== input.publisherBotId ||
    input.pullRequest.userType !== "Bot" ||
    (input.pullRequest.performedViaAppId !== undefined && input.pullRequest.performedViaAppId !== input.appId) ||
    input.pullRequest.headRepositoryId !== input.repositoryId ||
    input.pullRequest.headRepository !== input.repository ||
    input.pullRequest.baseRepositoryId !== input.repositoryId ||
    input.pullRequest.baseRef !== "main" ||
    input.pullRequest.headSha !== (input.expectedHeadSha ?? input.pullRequest.headSha) ||
    input.pullRequest.headSha !== text.headSha ||
    input.pullRequest.baseSha !== text.baseSha ||
    Number(branch[1]) !== text.issueNumber
  )
    throw new Error("invalid pull request provenance")
  return { branch: input.pullRequest.headRef, ...text }
}

export function requireVerifiedSource(input: {
  run: WorkflowRun
  workflow: WorkflowIdentity
  jobs: ReadonlyArray<WorkflowJob>
  repositoryId: number
  repository: string
  baseSha: string
  runId: number
  runAttempt: number
}) {
  if (
    input.run.id !== input.runId ||
    input.run.attempt !== input.runAttempt ||
    input.run.workflowId !== input.workflow.id ||
    input.run.path !== ".github/workflows/oc2-issue.yml" ||
    input.run.name !== "oc2 issue" ||
    input.run.event !== "issues" ||
    input.run.headSha !== input.baseSha ||
    input.run.repositoryId !== input.repositoryId ||
    input.run.repository !== input.repository ||
    input.run.headRepositoryId !== input.repositoryId ||
    input.run.headRepository !== input.repository
  )
    throw new Error("invalid source workflow provenance")
  if (
    input.workflow.name !== "oc2 issue" ||
    input.workflow.path !== ".github/workflows/oc2-issue.yml" ||
    input.workflow.state !== "active"
  )
    throw new Error("invalid source workflow provenance")
  const matches = input.jobs.filter((job) => job.name === "verify")
  if (
    matches.length !== 1 ||
    matches[0]!.runId !== input.runId ||
    matches[0]!.attempt !== input.runAttempt ||
    matches[0]!.status !== "completed" ||
    matches[0]!.conclusion !== "success" ||
    matches[0]!.headSha !== input.baseSha
  )
    throw new Error("invalid source workflow provenance")
}

export function decodeRuleset(value: unknown): Ruleset {
  const item = record(value, "invalid repository ruleset")
  const conditions = record(item.conditions, "invalid repository ruleset")
  const refName = record(conditions.ref_name, "invalid repository ruleset")
  const bypassActorsVisible = item.bypass_actors !== undefined
  const bypassActors = (bypassActorsVisible ? array(item.bypass_actors, "invalid repository ruleset") : []).map(
    (value) => {
      const actor = record(value, "invalid repository ruleset")
      return {
        actorId: actor.actor_id === null ? null : positiveInteger(actor.actor_id, "invalid repository ruleset"),
        actorType: boundedString(actor.actor_type, 64, "invalid repository ruleset"),
        bypassMode: boundedString(actor.bypass_mode, 64, "invalid repository ruleset"),
      }
    },
  )
  const rules = array(item.rules, "invalid repository ruleset").map((value) => {
    const rule = record(value, "invalid repository ruleset")
    return {
      type: boundedString(rule.type, 64, "invalid repository ruleset"),
      ...(rule.parameters === undefined ? {} : { parameters: record(rule.parameters, "invalid repository ruleset") }),
    }
  })
  return {
    id: positiveInteger(item.id, "invalid repository ruleset"),
    sourceType: boundedString(item.source_type, 64, "invalid repository ruleset"),
    target: boundedString(item.target, 64, "invalid repository ruleset"),
    enforcement: boundedString(item.enforcement, 64, "invalid repository ruleset"),
    bypassActorsVisible,
    currentUserCanBypass: boundedString(item.current_user_can_bypass, 64, "invalid repository ruleset"),
    bypassActors,
    conditions: {
      include: stringArray(refName.include),
      exclude: stringArray(refName.exclude),
    },
    rules,
  }
}

export function validateRepositorySettings(input: {
  repository: RepositorySettings
  repositoryId: number
  nameWithOwner: string
  appId: number
  rulesets: ReadonlyArray<Ruleset>
}) {
  if (
    input.repository.id !== input.repositoryId ||
    input.repository.nameWithOwner !== input.nameWithOwner ||
    input.repository.defaultBranch !== "main" ||
    !input.repository.allowAutoMerge ||
    !input.repository.rebaseMergeAllowed
  )
    throw new Error("auto-merge settings unavailable")

  const active = input.rulesets.filter((ruleset) => ruleset.target === "branch" && ruleset.enforcement === "active")
  if (active.length !== 3 || new Set(active.map((ruleset) => ruleset.id)).size !== active.length)
    throw new Error("auto-merge settings unavailable")
  const main = active.filter(
    (ruleset) =>
      ruleset.conditions.include.length === 1 &&
      (ruleset.conditions.include[0] === "~DEFAULT_BRANCH" || ruleset.conditions.include[0] === "refs/heads/main") &&
      ruleset.conditions.exclude.length === 0,
  )
  const repositoryMain = main.filter((ruleset) => ruleset.sourceType === "Repository")
  const trustedWorkflow = main.filter(
    (ruleset) => ruleset.sourceType === "Organization" || ruleset.sourceType === "Enterprise",
  )
  if (
    repositoryMain.length !== 1 ||
    trustedWorkflow.length !== 1 ||
    !repositoryMain[0]!.bypassActorsVisible ||
    repositoryMain[0]!.bypassActors.length !== 0 ||
    repositoryMain[0]!.currentUserCanBypass !== "never" ||
    trustedWorkflow[0]!.currentUserCanBypass !== "never"
  )
    throw new Error("auto-merge settings unavailable")

  const mainRules = repositoryMain[0]!.rules
  const expectedMainTypes = ["deletion", "merge_queue", "non_fast_forward", "pull_request", "required_status_checks"]
  if (
    mainRules
      .map((rule) => rule.type)
      .sort()
      .join("\n") !== expectedMainTypes.join("\n")
  )
    throw new Error("auto-merge settings unavailable")
  const pullRequestRules = mainRules.filter((rule) => rule.type === "pull_request")
  if (
    pullRequestRules.length !== 1 ||
    array(pullRequestRules[0]!.parameters?.allowed_merge_methods, "auto-merge settings unavailable").length !== 1 ||
    array(pullRequestRules[0]!.parameters?.allowed_merge_methods, "auto-merge settings unavailable")[0] !== "rebase"
  )
    throw new Error("auto-merge settings unavailable")
  const mergeQueueRules = mainRules.filter((rule) => rule.type === "merge_queue")
  const mergeQueue = mergeQueueRules[0]?.parameters
  if (
    mergeQueueRules.length !== 1 ||
    !mergeQueue ||
    !exactKeys(mergeQueue, [
      "check_response_timeout_minutes",
      "grouping_strategy",
      "max_entries_to_build",
      "max_entries_to_merge",
      "merge_method",
      "min_entries_to_merge",
      "min_entries_to_merge_wait_minutes",
    ]) ||
    mergeQueue.merge_method !== "REBASE" ||
    mergeQueue.grouping_strategy !== "ALLGREEN" ||
    positiveInteger(mergeQueue.check_response_timeout_minutes, "auto-merge settings unavailable") > 60 ||
    positiveInteger(mergeQueue.max_entries_to_build, "auto-merge settings unavailable") > 10 ||
    positiveInteger(mergeQueue.max_entries_to_merge, "auto-merge settings unavailable") > 10 ||
    positiveInteger(mergeQueue.min_entries_to_merge, "auto-merge settings unavailable") >
      positiveInteger(mergeQueue.max_entries_to_merge, "auto-merge settings unavailable") ||
    typeof mergeQueue.min_entries_to_merge_wait_minutes !== "number" ||
    !Number.isSafeInteger(mergeQueue.min_entries_to_merge_wait_minutes) ||
    mergeQueue.min_entries_to_merge_wait_minutes < 0 ||
    mergeQueue.min_entries_to_merge_wait_minutes > 60
  )
    throw new Error("auto-merge settings unavailable")
  const statusRules = mainRules.filter((rule) => rule.type === "required_status_checks")
  if (statusRules.length !== 1 || statusRules[0]!.parameters?.strict_required_status_checks_policy !== true)
    throw new Error("auto-merge settings unavailable")
  const contexts = array(statusRules[0]!.parameters?.required_status_checks, "auto-merge settings unavailable").map(
    (value) => {
      const check = record(value, "auto-merge settings unavailable")
      if (!exactKeys(check, ["context", "integration_id"]) || check.integration_id !== githubActionsAppId)
        throw new Error("auto-merge settings unavailable")
      return boundedString(check.context, 256, "auto-merge settings unavailable")
    },
  )
  if (
    contexts.length !== requiredStatusContexts.length ||
    [...contexts].sort().join("\n") !== [...requiredStatusContexts].sort().join("\n")
  )
    throw new Error("auto-merge settings unavailable")
  const workflowRules = trustedWorkflow[0]!.rules
  const workflowParameters = workflowRules[0]?.parameters
  if (
    workflowRules.length !== 1 ||
    workflowRules[0]!.type !== "workflows" ||
    !workflowParameters ||
    !exactKeys(workflowParameters, ["do_not_enforce_on_create", "workflows"]) ||
    workflowParameters.do_not_enforce_on_create !== false
  )
    throw new Error("auto-merge settings unavailable")
  const workflows = array(workflowParameters.workflows, "auto-merge settings unavailable")
  if (workflows.length !== 1) throw new Error("auto-merge settings unavailable")
  const workflow = record(workflows[0], "auto-merge settings unavailable")
  if (
    !exactKeys(workflow, ["path", "ref", "repository_id"]) ||
    workflow.path !== ".github/workflows/oc2-provenance.yml" ||
    workflow.ref !== "refs/heads/main" ||
    workflow.repository_id !== input.repositoryId
  )
    throw new Error("auto-merge settings unavailable")

  const automation = active.filter(
    (ruleset) =>
      ruleset.sourceType === "Repository" &&
      ruleset.conditions.include.length === 1 &&
      ruleset.conditions.include[0] === "refs/heads/oc2/issue-*" &&
      ruleset.conditions.exclude.length === 0,
  )
  if (automation.length !== 1) throw new Error("auto-merge settings unavailable")
  const bypass = automation[0]!.bypassActors
  if (
    !automation[0]!.bypassActorsVisible ||
    automation[0]!.currentUserCanBypass !== "always" ||
    bypass.length !== 1 ||
    bypass[0]!.actorType !== "Integration" ||
    bypass[0]!.actorId !== input.appId ||
    bypass[0]!.bypassMode !== "always"
  )
    throw new Error("auto-merge settings unavailable")
  const expectedAutomationTypes = ["creation", "deletion", "non_fast_forward", "update"]
  if (
    automation[0]!.rules
      .map((rule) => rule.type)
      .sort()
      .join("\n") !== expectedAutomationTypes.join("\n")
  )
    throw new Error("auto-merge settings unavailable")
  for (const rule of automation[0]!.rules) {
    if (rule.type !== "update" && rule.parameters !== undefined) throw new Error("auto-merge settings unavailable")
    if (
      rule.type === "update" &&
      (!rule.parameters ||
        !exactKeys(rule.parameters, ["update_allows_fetch_and_merge"]) ||
        rule.parameters.update_allows_fetch_and_merge !== false)
    )
      throw new Error("auto-merge settings unavailable")
  }
}

export function decodeProvenancePullRequest(value: unknown): ProvenancePullRequest {
  const item = record(value, "invalid pull request response")
  const user = record(item.user, "invalid pull request response")
  const head = record(item.head, "invalid pull request response")
  const base = record(item.base, "invalid pull request response")
  const headRepository = repositoryIdentity(head.repo, "invalid pull request response")
  const baseRepository = repositoryIdentity(base.repo, "invalid pull request response")
  const app =
    item.performed_via_github_app === null || item.performed_via_github_app === undefined
      ? undefined
      : record(item.performed_via_github_app, "invalid pull request response")
  return {
    id: positiveInteger(item.id, "invalid pull request response"),
    number: positiveInteger(item.number, "invalid pull request response"),
    title: boundedString(item.title, 256, "invalid pull request response"),
    body: body(item.body),
    state: boundedString(item.state, 32, "invalid pull request response"),
    draft: boolean(item.draft, "invalid pull request response"),
    userId: positiveInteger(user.id, "invalid pull request response"),
    userType: boundedString(user.type, 32, "invalid pull request response"),
    headSha: sha(head.sha, "invalid pull request response"),
    headRef: boundedString(head.ref, 256, "invalid pull request response"),
    headRepositoryId: headRepository.id,
    headRepository: headRepository.nameWithOwner,
    baseSha: sha(base.sha, "invalid pull request response"),
    baseRef: boundedString(base.ref, 256, "invalid pull request response"),
    baseRepositoryId: baseRepository.id,
    ...(app === undefined ? {} : { performedViaAppId: positiveInteger(app.id, "invalid pull request response") }),
  }
}

export function createProvenanceApi(input: {
  token: string
  repository: string
  repositoryId: number
  baseUrl?: string
  graphqlUrl?: string
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}): ProvenanceApi {
  if (!input.token || !repositoryPattern.test(input.repository)) throw new Error("invalid provenance configuration")
  const baseUrl = new URL(input.baseUrl ?? "https://api.github.com")
  const graphqlUrl = new URL(input.graphqlUrl ?? `${baseUrl.href.replace(/\/$/, "")}/graphql`)
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    graphqlUrl.protocol !== "https:" ||
    graphqlUrl.username ||
    graphqlUrl.password ||
    graphqlUrl.search ||
    graphqlUrl.hash
  )
    throw new Error("invalid provenance configuration")
  const request = input.fetch ?? globalThis.fetch
  const root = baseUrl.href.replace(/\/$/, "")
  const repositoryPath = `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`

  async function call(url: string, init: RequestInit = {}) {
    const response = await request(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        "User-Agent": "oc2-provenance-validator",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }).catch(() => {
      throw new Error("provenance API request failed")
    })
    if (!response.ok || !response.body) throw new Error("provenance API request failed")
    const declared = response.headers.get("content-length")
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumResponseBytes))
      throw new Error("provenance API response too large")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumResponseBytes) throw new Error("provenance API response too large")
    try {
      return JSON.parse(decoder.decode(bytes)) as unknown
    } catch {
      throw new Error("invalid provenance API response")
    }
  }

  function rest(path: string) {
    return call(`${root}${path}`)
  }

  return {
    async getPullRequest(number) {
      return decodeProvenancePullRequest(await rest(`${repositoryPath}/pulls/${positiveInteger(number)}`))
    },
    async getWorkflowRunAttempt(runId, attempt) {
      const item = record(
        await rest(`${repositoryPath}/actions/runs/${positiveInteger(runId)}/attempts/${positiveInteger(attempt)}`),
        "invalid workflow run response",
      )
      const repository = repositoryIdentity(item.repository, "invalid workflow run response")
      const headRepository = repositoryIdentity(item.head_repository, "invalid workflow run response")
      return {
        id: positiveInteger(item.id, "invalid workflow run response"),
        attempt: positiveInteger(item.run_attempt, "invalid workflow run response"),
        workflowId: positiveInteger(item.workflow_id, "invalid workflow run response"),
        path: boundedString(item.path, 512, "invalid workflow run response"),
        name: boundedString(item.name, 256, "invalid workflow run response"),
        event: boundedString(item.event, 64, "invalid workflow run response"),
        headSha: sha(item.head_sha, "invalid workflow run response"),
        repositoryId: repository.id,
        repository: repository.nameWithOwner,
        headRepositoryId: headRepository.id,
        headRepository: headRepository.nameWithOwner,
      }
    },
    async getWorkflowIdentity() {
      const item = record(
        await rest(`${repositoryPath}/actions/workflows/${encodeURIComponent("oc2-issue.yml")}`),
        "invalid workflow identity response",
      )
      return {
        id: positiveInteger(item.id, "invalid workflow identity response"),
        name: boundedString(item.name, 256, "invalid workflow identity response"),
        path: boundedString(item.path, 512, "invalid workflow identity response"),
        state: boundedString(item.state, 64, "invalid workflow identity response"),
      }
    },
    async listWorkflowJobs(runId, attempt) {
      const jobs: WorkflowJob[] = []
      let total: number | undefined
      for (let page = 1; page <= maximumPages; page++) {
        const response = record(
          await rest(
            `${repositoryPath}/actions/runs/${positiveInteger(runId)}/attempts/${positiveInteger(attempt)}/jobs?filter=all&per_page=100&page=${page}`,
          ),
          "invalid workflow jobs response",
        )
        const count = positiveInteger(response.total_count, "invalid workflow jobs response")
        if (total !== undefined && count !== total) throw new Error("incomplete workflow jobs response")
        total = count
        const pageJobs = array(response.jobs, "invalid workflow jobs response")
        for (const value of pageJobs) {
          const item = record(value, "invalid workflow jobs response")
          jobs.push({
            id: positiveInteger(item.id, "invalid workflow jobs response"),
            runId: positiveInteger(item.run_id, "invalid workflow jobs response"),
            attempt: positiveInteger(item.run_attempt, "invalid workflow jobs response"),
            name: boundedString(item.name, 256, "invalid workflow jobs response"),
            status: boundedString(item.status, 64, "invalid workflow jobs response"),
            conclusion:
              item.conclusion === null ? null : boundedString(item.conclusion, 64, "invalid workflow jobs response"),
            headSha: sha(item.head_sha, "invalid workflow jobs response"),
          })
        }
        if (jobs.length === total && pageJobs.length <= 100) break
        if (pageJobs.length !== 100) throw new Error("incomplete workflow jobs response")
      }
      if (jobs.length !== total || new Set(jobs.map((job) => job.id)).size !== jobs.length)
        throw new Error("incomplete workflow jobs response")
      return jobs
    },
    async listMergeQueueEntries() {
      const [owner, name] = input.repository.split("/") as [string, string]
      const entries: MergeQueueEntry[] = []
      let cursor: string | null = null
      let total: number | undefined
      for (let page = 1; page <= maximumPages; page++) {
        const result = record(
          await call(graphqlUrl.href, {
            method: "POST",
            body: JSON.stringify({
              query:
                'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){databaseId nameWithOwner mergeQueue(branch:"main"){entries(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{id position baseCommit{oid} headCommit{oid} pullRequest{number headRefOid baseRefName baseRepository{databaseId nameWithOwner} headRepository{databaseId nameWithOwner}}}}}}}',
              variables: { owner, name, cursor },
            }),
          }),
          "invalid merge queue response",
        )
        if (result.errors !== undefined) throw new Error("invalid merge queue response")
        const repository = record(
          record(result.data, "invalid merge queue response").repository,
          "invalid merge queue response",
        )
        if (
          positiveInteger(repository.databaseId, "invalid merge queue response") !== input.repositoryId ||
          boundedString(repository.nameWithOwner, 201, "invalid merge queue response") !== input.repository
        )
          throw new Error("invalid merge queue response")
        const connection = record(
          record(repository.mergeQueue, "invalid merge queue response").entries,
          "invalid merge queue response",
        )
        const count = positiveInteger(connection.totalCount, "invalid merge queue response")
        if (total !== undefined && count !== total) throw new Error("incomplete merge queue response")
        total = count
        for (const value of array(connection.nodes, "invalid merge queue response")) {
          const item = record(value, "invalid merge queue response")
          const pullRequest = record(item.pullRequest, "invalid merge queue response")
          const baseRepository = record(pullRequest.baseRepository, "invalid merge queue response")
          const headRepository = record(pullRequest.headRepository, "invalid merge queue response")
          if (
            pullRequest.baseRefName !== "main" ||
            positiveInteger(baseRepository.databaseId, "invalid merge queue response") !== input.repositoryId ||
            boundedString(baseRepository.nameWithOwner, 201, "invalid merge queue response") !== input.repository
          )
            throw new Error("invalid merge queue response")
          positiveInteger(headRepository.databaseId, "invalid merge queue response")
          const headRepositoryName = boundedString(headRepository.nameWithOwner, 201, "invalid merge queue response")
          if (!repositoryPattern.test(headRepositoryName)) throw new Error("invalid merge queue response")
          entries.push({
            id: boundedString(item.id, 256, "invalid merge queue response"),
            position: positiveInteger(item.position, "invalid merge queue response"),
            baseSha: sha(record(item.baseCommit, "invalid merge queue response").oid, "invalid merge queue response"),
            headSha: sha(record(item.headCommit, "invalid merge queue response").oid, "invalid merge queue response"),
            pullRequestHeadSha: sha(pullRequest.headRefOid, "invalid merge queue response"),
            pullRequestNumber: positiveInteger(pullRequest.number, "invalid merge queue response"),
          })
        }
        const pageInfo = record(connection.pageInfo, "invalid merge queue response")
        const hasNextPage = boolean(pageInfo.hasNextPage, "invalid merge queue response")
        if (!hasNextPage) {
          if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
            throw new Error("invalid merge queue response")
          break
        }
        cursor = boundedString(pageInfo.endCursor, 256, "invalid merge queue response")
      }
      if (
        entries.length !== total ||
        new Set(entries.map((entry) => entry.id)).size !== entries.length ||
        new Set(entries.map((entry) => entry.pullRequestNumber)).size !== entries.length
      )
        throw new Error("incomplete merge queue response")
      return entries
    },
  }
}

async function gitResult(cwd: string, args: ReadonlyArray<string>) {
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
      ...args,
    ],
    {
      cwd,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        HOME: cwd,
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()])
  if (output.byteLength > 16 * 1024 * 1024) throw new Error("provenance Git command failed")
  return { exitCode, output: new Uint8Array(output) }
}

async function git(cwd: string, args: ReadonlyArray<string>) {
  const result = await gitResult(cwd, args)
  if (result.exitCode !== 0) throw new Error("provenance Git command failed")
  return result.output
}

function splitNul(output: Uint8Array) {
  if (output.length === 0 || output.at(-1) !== 0) throw new Error("invalid provenance Git output")
  const records: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue
    records.push(output.subarray(start, index))
    start = index + 1
  }
  if (records.some((item) => item.length === 0)) throw new Error("invalid provenance Git output")
  return records
}

export function validateProvenancePathRecords(raw: Uint8Array, numstat: Uint8Array) {
  const rawRecords = splitNul(raw)
  if (rawRecords.length % 2 !== 0) throw new Error("invalid provenance Git output")
  const rawPaths: string[] = []
  for (let index = 0; index < rawRecords.length; index += 2) {
    const metadata = decoder.decode(rawRecords[index])
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([ADM])$/.exec(metadata)
    if (!match) throw new Error("unsupported automation branch change")
    const oldMode = match[1]!
    const newMode = match[2]!
    const status = match[3]!
    const regular = (mode: string) => mode === "100644" || mode === "100755"
    if (
      (status === "A" && (oldMode !== "000000" || !regular(newMode))) ||
      (status === "D" && (!regular(oldMode) || newMode !== "000000")) ||
      (status === "M" && (!regular(oldMode) || !regular(newMode)))
    )
      throw new Error("unsupported automation branch mode")
    rawPaths.push(decoder.decode(rawRecords[index + 1]))
  }
  const paths = validateChangedPaths(rawPaths)
  if (paths.length < 1 || paths.length > maximumChangedFiles) throw new Error("automation branch file limit exceeded")

  let changedLines = 0
  const numstatPaths = splitNul(numstat).map((entry) => {
    const item = decoder.decode(entry)
    const first = item.indexOf("\t")
    const second = item.indexOf("\t", first + 1)
    if (first < 1 || second < first + 2) throw new Error("invalid provenance Git output")
    const added = item.slice(0, first)
    const deleted = item.slice(first + 1, second)
    if (added === "-" || deleted === "-") {
      if (added !== "-" || deleted !== "-") throw new Error("invalid provenance Git output")
    } else {
      if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) throw new Error("invalid provenance Git output")
      changedLines += Number(added) + Number(deleted)
      if (!Number.isSafeInteger(changedLines) || changedLines > maximumChangedLines)
        throw new Error("automation branch line limit exceeded")
    }
    return item.slice(second + 1)
  })
  if (numstatPaths.length !== paths.length || numstatPaths.some((path, index) => path !== paths[index]))
    throw new Error("automation branch path mismatch")
  validateChangedPaths(numstatPaths)
  return paths
}

async function validateGitProvenance(input: {
  repository: string
  branch: string
  baseSha: string
  headSha: string
  patchSha256: string
}) {
  const temporary = await mkdtemp(join(tmpdir(), "oc2-provenance-"))
  try {
    await git(temporary, ["init", "--bare", "--quiet"])
    const remote = `https://github.com/${input.repository}.git`
    const fetched = await gitResult(temporary, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=2",
      remote,
      input.headSha,
    ])
    if (fetched.exitCode !== 0) {
      if (!automationBranchPattern.test(input.branch)) throw new Error("invalid automation branch")
      await git(temporary, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--depth=2",
        remote,
        `refs/heads/${input.branch}:refs/oc2/automation-head`,
      ])
      if (
        decoder.decode(await git(temporary, ["rev-parse", "refs/oc2/automation-head^{commit}"])).trim() !==
        input.headSha
      )
        throw new Error("automation branch head mismatch")
    }
    const parents = decoder
      .decode(await git(temporary, ["rev-list", "--parents", "-n", "1", input.headSha]))
      .trim()
      .split(" ")
    if (parents.length !== 2 || parents[0] !== input.headSha || parents[1] !== input.baseSha)
      throw new Error("automation branch parent mismatch")
    const tree = decoder.decode(await git(temporary, ["show", "-s", "--format=%T", input.headSha])).trim()
    sha(tree, "invalid automation branch tree")
    const patch = await git(temporary, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      input.baseSha,
      input.headSha,
      "--",
    ])
    if (
      patch.byteLength < 1 ||
      patch.byteLength > maximumPatchBytes ||
      createHash("sha256").update(patch).digest("hex") !== input.patchSha256
    )
      throw new Error("automation branch patch mismatch")
    const [raw, numstat] = await Promise.all([
      git(temporary, [
        "diff",
        "--raw",
        "-z",
        "--full-index",
        "--no-ext-diff",
        "--no-renames",
        input.baseSha,
        input.headSha,
        "--",
      ]),
      git(temporary, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-renames", input.baseSha, input.headSha, "--"]),
    ])
    validateProvenancePathRecords(raw, numstat)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function selectMergeGroupChain(input: {
  entries: ReadonlyArray<MergeQueueEntry>
  baseSha: string
  headSha: string
}) {
  const chain: MergeQueueEntry[] = []
  const seen = new Set<string>()
  let current = input.headSha
  while (current !== input.baseSha) {
    const next = input.entries.filter((entry) => entry.headSha === current)
    if (next.length !== 1 || seen.has(next[0]!.id)) throw new Error("merge group constituent mismatch")
    chain.unshift(next[0]!)
    seen.add(next[0]!.id)
    current = next[0]!.baseSha
    if (chain.length > input.entries.length) throw new Error("merge group constituent mismatch")
  }
  const positions = chain.map((entry) => entry.position)
  if (
    chain.length < 1 ||
    new Set(chain.map((entry) => entry.pullRequestNumber)).size !== chain.length ||
    positions.some((position, index) => index > 0 && position !== positions[index - 1]! + 1)
  )
    throw new Error("merge group constituent mismatch")
  return chain
}

export async function selectMergeGroupPullRequests(input: {
  repository: string
  baseSha: string
  headRef: string
  headSha: string
  entries: ReadonlyArray<MergeQueueEntry>
}) {
  const temporary = await mkdtemp(join(tmpdir(), "oc2-merge-group-"))
  try {
    const chain = selectMergeGroupChain(input)
    await git(temporary, ["init", "--bare", "--quiet"])
    const remote = `https://github.com/${input.repository}.git`
    const synthetic = await gitResult(temporary, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--filter=blob:none",
      "--depth=100",
      remote,
      input.headSha,
    ])
    if (synthetic.exitCode !== 0) {
      if (
        !/^refs\/heads\/gh-readonly-queue\/main\/[A-Za-z0-9._/-]+$/.test(input.headRef) ||
        input.headRef.includes("..") ||
        input.headRef.includes("//") ||
        input.headRef.endsWith("/")
      )
        throw new Error("invalid merge group ref")
      await git(temporary, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--filter=blob:none",
        "--depth=100",
        remote,
        `${input.headRef}:refs/oc2/merge-group`,
      ])
      if (decoder.decode(await git(temporary, ["rev-parse", "refs/oc2/merge-group^{commit}"])).trim() !== input.headSha)
        throw new Error("merge group head mismatch")
    }
    for (const commit of new Set([input.baseSha, ...chain.map((entry) => entry.headSha)]))
      await git(temporary, ["cat-file", "-e", `${commit}^{commit}`])
    if ((await gitResult(temporary, ["merge-base", "--is-ancestor", input.baseSha, input.headSha])).exitCode !== 0)
      throw new Error("merge group base mismatch")
    return chain
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function decodeEvent(path: string, repository: string, repositoryId: number) {
  return Bun.file(path)
    .json()
    .then((value) => {
      const event = record(value)
      const eventRepository = repositoryIdentity(event.repository, "invalid provenance event")
      if (eventRepository.id !== repositoryId || eventRepository.nameWithOwner !== repository)
        throw new Error("invalid provenance event")
      return event
    })
}

function eventPullRequest(value: unknown) {
  return decodeProvenancePullRequest(value)
}

export async function validateProvenance(input: {
  eventPath: string
  eventName: string
  repository: string
  repositoryId: number
  workflowSha: string
  cwd?: string
  publisherBotId: number
  appId: number
  token: string
  api?: ProvenanceApi
}) {
  if (
    !repositoryPattern.test(input.repository) ||
    (input.eventName !== "pull_request_target" && input.eventName !== "merge_group")
  )
    throw new Error("invalid provenance configuration")
  positiveInteger(input.repositoryId)
  configurationId(input.publisherBotId)
  configurationId(input.appId)
  const root = await realpath(input.cwd ?? process.cwd())
  const topLevel = decoder.decode(await git(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim()
  const head = decoder.decode(await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  if ((await realpath(topLevel)) !== root || head !== sha(input.workflowSha))
    throw new Error("untrusted provenance workflow source")
  const event = await decodeEvent(input.eventPath, input.repository, input.repositoryId)
  const api =
    input.api ??
    createProvenanceApi({
      token: input.token,
      repository: input.repository,
      repositoryId: input.repositoryId,
      baseUrl: process.env.GITHUB_API_URL,
      graphqlUrl: process.env.GITHUB_GRAPHQL_URL,
    })

  const validatePullRequest = async (number: number, eventValue?: unknown, expectedHeadSha?: string) => {
    const current = await api.getPullRequest(number)
    if (eventValue !== undefined) {
      const snapshot = eventPullRequest(eventValue)
      if (
        snapshot.id !== current.id ||
        snapshot.number !== current.number ||
        snapshot.title !== current.title ||
        snapshot.body !== current.body ||
        snapshot.state !== current.state ||
        snapshot.draft !== current.draft ||
        snapshot.userId !== current.userId ||
        snapshot.userType !== current.userType ||
        snapshot.headSha !== current.headSha ||
        snapshot.headRef !== current.headRef ||
        snapshot.headRepositoryId !== current.headRepositoryId ||
        snapshot.headRepository !== current.headRepository ||
        snapshot.baseSha !== current.baseSha ||
        snapshot.baseRef !== current.baseRef ||
        snapshot.baseRepositoryId !== current.baseRepositoryId ||
        (snapshot.performedViaAppId !== undefined && snapshot.performedViaAppId !== current.performedViaAppId)
      )
        throw new Error("pull request changed during validation")
    }
    if (!automationBranchPattern.test(current.headRef)) return false
    positiveInteger(input.publisherBotId, "invalid provenance identity configuration")
    positiveInteger(input.appId, "invalid provenance identity configuration")
    const provenance = requireAutomationPullRequest({
      pullRequest: current,
      repositoryId: input.repositoryId,
      repository: input.repository,
      publisherBotId: input.publisherBotId,
      appId: input.appId,
      expectedNumber: number,
      expectedHeadSha,
    })
    const [run, workflow, jobs] = await Promise.all([
      api.getWorkflowRunAttempt(provenance.runId, provenance.runAttempt),
      api.getWorkflowIdentity(),
      api.listWorkflowJobs(provenance.runId, provenance.runAttempt),
    ])
    requireVerifiedSource({
      run,
      workflow,
      jobs,
      repositoryId: input.repositoryId,
      repository: input.repository,
      baseSha: provenance.baseSha,
      runId: provenance.runId,
      runAttempt: provenance.runAttempt,
    })
    await validateGitProvenance({
      repository: input.repository,
      branch: provenance.branch,
      baseSha: provenance.baseSha,
      headSha: provenance.headSha,
      patchSha256: provenance.patchSha256,
    })
    return true
  }

  if (input.eventName === "pull_request_target") {
    const pullRequest = record(event.pull_request, "invalid provenance event")
    const head = record(pullRequest.head, "invalid provenance event")
    if (!automationBranchPattern.test(boundedString(head.ref, 256, "invalid provenance event"))) return
    await validatePullRequest(positiveInteger(pullRequest.number, "invalid provenance event"), pullRequest)
    return
  }

  const mergeGroup = record(event.merge_group, "invalid provenance event")
  const baseRef = boundedString(mergeGroup.base_ref, 256, "invalid provenance event")
  const baseSha = sha(mergeGroup.base_sha, "invalid provenance event")
  const headRef = boundedString(mergeGroup.head_ref, 512, "invalid provenance event")
  const headSha = sha(mergeGroup.head_sha, "invalid provenance event")
  if (baseRef !== "refs/heads/main" || baseSha === headSha) throw new Error("invalid provenance event")
  const entries = await api.listMergeQueueEntries()
  const pullRequests = await selectMergeGroupPullRequests({
    repository: input.repository,
    baseSha,
    headRef,
    headSha,
    entries,
  })
  await Promise.all(
    pullRequests.map((entry) => validatePullRequest(entry.pullRequestNumber, undefined, entry.pullRequestHeadSha)),
  )
  const current = selectMergeGroupChain({ entries: await api.listMergeQueueEntries(), baseSha, headSha })
  if (
    current.length !== pullRequests.length ||
    current.some((entry, index) => {
      const previous = pullRequests[index]!
      return (
        entry.id !== previous.id ||
        entry.position !== previous.position ||
        entry.baseSha !== previous.baseSha ||
        entry.headSha !== previous.headSha ||
        entry.pullRequestHeadSha !== previous.pullRequestHeadSha ||
        entry.pullRequestNumber !== previous.pullRequestNumber
      )
    })
  )
    throw new Error("merge group changed during validation")
}

function options(argv: ReadonlyArray<string>, allowed: ReadonlyArray<string>) {
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !value || !allowed.includes(key) || values.has(key)) throw new Error("invalid provenance arguments")
    values.set(key, value)
  }
  if (values.size !== allowed.length) throw new Error("missing provenance arguments")
  return Object.fromEntries(allowed.map((key) => [key.slice(2).replaceAll("-", "_"), values.get(key)!]))
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)) {
  if (argv[0] !== "validate") throw new Error("invalid provenance command")
  const value = options(argv, [
    "--event-file",
    "--event-name",
    "--repository",
    "--repository-id",
    "--workflow-sha",
    "--publisher-bot-id",
    "--app-id",
  ])
  await validateProvenance({
    eventPath: value.event_file!,
    eventName: value.event_name!,
    repository: value.repository!,
    repositoryId: positiveInteger(Number(value.repository_id)),
    workflowSha: sha(value.workflow_sha),
    publisherBotId: configurationId(Number(value.publisher_bot_id)),
    appId: configurationId(Number(value.app_id)),
    token: process.env.GITHUB_TOKEN ?? "",
  })
}

if (import.meta.main) {
  await main().catch(() => {
    process.stderr.write("provenance_failed\n")
    process.exitCode = 1
  })
}
