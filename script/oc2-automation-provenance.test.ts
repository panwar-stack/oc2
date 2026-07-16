import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createProvenanceApi,
  decodeRuleset,
  githubActionsAppId,
  parseAutomationPullRequestText,
  requireAutomationPullRequest,
  requireVerifiedSource,
  requiredStatusContexts,
  selectMergeGroupChain,
  validateProvenance,
  validateProvenancePathRecords,
  validateRepositorySettings,
  type ProvenancePullRequest,
  type RepositorySettings,
  type Ruleset,
} from "./oc2-automation-provenance"
import { enablePreparedAutoMerge, requireExactAutoMergePullRequest, type PublisherApi } from "./oc2-publish"

const repository = "octo/oc2"
const repositoryId = 1234
const appId = 8001
const publisherBotId = 9002
const baseSha = "1".repeat(40)
const headSha = "2".repeat(40)
const patchSha256 = "3".repeat(64)
const branch = `oc2/issue-42-${"4".repeat(12)}`
const title = "OC2 issue #42"
const body = [
  "Issue: #42",
  "Run: https://github.com/octo/oc2/actions/runs/800/attempts/2",
  `Base: ${baseSha}`,
  `Head: ${headSha}`,
  `Patch: ${patchSha256}`,
].join("\n")

function pullRequest(overrides: Partial<ProvenancePullRequest> = {}): ProvenancePullRequest {
  return {
    id: 99,
    number: 17,
    title,
    body,
    state: "open",
    draft: false,
    userId: publisherBotId,
    userType: "Bot",
    headSha,
    headRef: branch,
    headRepositoryId: repositoryId,
    headRepository: repository,
    baseSha,
    baseRef: "main",
    baseRepositoryId: repositoryId,
    performedViaAppId: appId,
    ...overrides,
  }
}

function settings(overrides: Partial<RepositorySettings> = {}): RepositorySettings {
  return {
    id: repositoryId,
    nameWithOwner: repository,
    defaultBranch: "main",
    allowAutoMerge: true,
    rebaseMergeAllowed: true,
    ...overrides,
  }
}

function rulesets(): Ruleset[] {
  return [
    {
      id: 1,
      sourceType: "Repository",
      target: "branch",
      enforcement: "active",
      bypassActorsVisible: true,
      currentUserCanBypass: "never",
      bypassActors: [],
      conditions: { include: ["refs/heads/main"], exclude: [] },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } },
        {
          type: "merge_queue",
          parameters: {
            check_response_timeout_minutes: 60,
            grouping_strategy: "ALLGREEN",
            max_entries_to_build: 5,
            max_entries_to_merge: 5,
            merge_method: "REBASE",
            min_entries_to_merge: 1,
            min_entries_to_merge_wait_minutes: 0,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: requiredStatusContexts.map((context) => ({
              context,
              integration_id: githubActionsAppId,
            })),
          },
        },
      ],
    },
    {
      id: 2,
      sourceType: "Repository",
      target: "branch",
      enforcement: "active",
      bypassActorsVisible: true,
      currentUserCanBypass: "always",
      bypassActors: [{ actorId: appId, actorType: "Integration", bypassMode: "always" }],
      conditions: { include: ["refs/heads/oc2/issue-*"], exclude: [] },
      rules: [
        { type: "creation" },
        { type: "update", parameters: { update_allows_fetch_and_merge: false } },
        { type: "deletion" },
        { type: "non_fast_forward" },
      ],
    },
    {
      id: 3,
      sourceType: "Organization",
      target: "branch",
      enforcement: "active",
      bypassActorsVisible: false,
      currentUserCanBypass: "never",
      bypassActors: [],
      conditions: { include: ["refs/heads/main"], exclude: [] },
      rules: [
        {
          type: "workflows",
          parameters: {
            do_not_enforce_on_create: false,
            workflows: [
              {
                path: ".github/workflows/oc2-provenance.yml",
                ref: "refs/heads/main",
                repository_id: repositoryId,
              },
            ],
          },
        },
      ],
    },
  ]
}

describe("automation pull request provenance", () => {
  test("makes a human branch a deterministic no-op without configured App IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc2-provenance-event-"))
    const eventPath = join(root, "event.json")
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { id: repositoryId, full_name: repository },
        pull_request: { number: 17, head: { ref: "human/change" } },
      }),
    )
    let requested = false
    const cwd = join(import.meta.dir, "..")
    const workflowSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd }).stdout.toString().trim()
    await validateProvenance({
      eventPath,
      eventName: "pull_request_target",
      repository,
      repositoryId,
      workflowSha,
      cwd,
      publisherBotId: 0,
      appId: 0,
      token: "",
      api: {
        getPullRequest: async () => {
          requested = true
          throw new Error("unexpected request")
        },
        getWorkflowRunAttempt: async () => {
          throw new Error("unexpected request")
        },
        getWorkflowIdentity: async () => {
          throw new Error("unexpected request")
        },
        listWorkflowJobs: async () => [],
        listMergeQueueEntries: async () => [],
      },
    }).finally(() => rm(root, { recursive: true, force: true }))
    expect(requested).toBeFalse()
  })

  test("parses only the fixed five-line metadata and exact repository run URL", () => {
    expect(parseAutomationPullRequestText(repository, title, body)).toEqual({
      issueNumber: 42,
      runId: 800,
      runAttempt: 2,
      baseSha,
      headSha,
      patchSha256,
    })
    expect(() => parseAutomationPullRequestText(repository, title, `${body}\nExtra: value`)).toThrow("provenance")
    expect(() =>
      parseAutomationPullRequestText(repository, title, body.replace("github.com/octo/oc2", "github.com/evil/oc2")),
    ).toThrow("provenance")
  })

  test("binds same-repository App ownership, branch issue, base ref, and exact head", () => {
    expect(
      requireAutomationPullRequest({
        pullRequest: pullRequest(),
        repositoryId,
        repository,
        publisherBotId,
        appId,
        expectedNumber: 17,
        expectedHeadSha: headSha,
      }),
    ).toMatchObject({ issueNumber: 42, branch, headSha })
    expect(() =>
      requireAutomationPullRequest({
        pullRequest: pullRequest({ performedViaAppId: undefined }),
        repositoryId,
        repository,
        publisherBotId,
        appId,
        expectedNumber: 17,
        expectedHeadSha: headSha,
      }),
    ).not.toThrow()
    expect(() =>
      requireAutomationPullRequest({
        pullRequest: pullRequest({ baseSha: "7".repeat(40) }),
        repositoryId,
        repository,
        publisherBotId,
        appId,
        expectedNumber: 17,
        expectedHeadSha: headSha,
      }),
    ).not.toThrow()
    for (const changed of [
      pullRequest({ headSha: "5".repeat(40) }),
      pullRequest({ headRepositoryId: 8 }),
      pullRequest({ performedViaAppId: 9 }),
      pullRequest({ userId: 10 }),
      pullRequest({ baseRef: "release" }),
    ]) {
      expect(() =>
        requireAutomationPullRequest({
          pullRequest: changed,
          repositoryId,
          repository,
          publisherBotId,
          appId,
          expectedNumber: 17,
          expectedHeadSha: headSha,
        }),
      ).toThrow("provenance")
    }
  })

  test("rejects an exact-head race before auto-merge", () => {
    expect(
      requireExactAutoMergePullRequest({
        pullRequest: pullRequest(),
        repositoryId,
        repository,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
      }),
    ).toMatchObject({ headSha })
    expect(() =>
      requireExactAutoMergePullRequest({
        pullRequest: pullRequest({ headSha: "6".repeat(40) }),
        repositoryId,
        repository,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
      }),
    ).toThrow()
  })

  test("requires the exact successful verify job for the source attempt", () => {
    const run = {
      id: 800,
      attempt: 2,
      workflowId: 77,
      path: ".github/workflows/oc2-issue.yml",
      name: "oc2 issue",
      event: "issues",
      headSha: baseSha,
      repositoryId,
      repository,
      headRepositoryId: repositoryId,
      headRepository: repository,
    }
    const workflow = {
      id: 77,
      name: "oc2 issue",
      path: ".github/workflows/oc2-issue.yml",
      state: "active",
    }
    const job = {
      id: 88,
      runId: 800,
      attempt: 2,
      name: "verify",
      status: "completed",
      conclusion: "success",
      headSha: baseSha,
    }
    expect(() =>
      requireVerifiedSource({
        run,
        workflow,
        jobs: [job],
        repositoryId,
        repository,
        baseSha,
        runId: 800,
        runAttempt: 2,
      }),
    ).not.toThrow()
    expect(() =>
      requireVerifiedSource({
        run,
        workflow,
        jobs: [{ ...job, conclusion: "failure" }],
        repositoryId,
        repository,
        baseSha,
        runId: 800,
        runAttempt: 2,
      }),
    ).toThrow("workflow provenance")
    expect(() =>
      requireVerifiedSource({
        run: { ...run, path: ".github/workflows/forged.yml" },
        workflow,
        jobs: [job],
        repositoryId,
        repository,
        baseSha,
        runId: 800,
        runAttempt: 2,
      }),
    ).toThrow("workflow provenance")
  })
})

describe("repository settings gate", () => {
  test("decodes an inherited workflow ruleset without hidden bypass actors", () => {
    expect(
      decodeRuleset({
        id: 3,
        source_type: "Organization",
        target: "branch",
        enforcement: "active",
        current_user_can_bypass: "never",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: rulesets()[2]!.rules.map((rule) => ({ type: rule.type, parameters: rule.parameters })),
      }),
    ).toMatchObject({
      sourceType: "Organization",
      bypassActorsVisible: false,
      currentUserCanBypass: "never",
      bypassActors: [],
    })
  })

  test("accepts strict queue checks and an App-only automation branch ruleset", () => {
    expect(() =>
      validateRepositorySettings({
        repository: settings(),
        repositoryId,
        nameWithOwner: repository,
        appId,
        rulesets: rulesets(),
      }),
    ).not.toThrow()
  })

  test("fails closed on repository, required-check, queue, or bypass drift", () => {
    const missingCheck = rulesets()
    missingCheck[0]!.rules.find((rule) => rule.type === "required_status_checks")!.parameters = {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "typecheck" }],
    }
    const wrongQueue = rulesets()
    wrongQueue[0]!.rules.find((rule) => rule.type === "merge_queue")!.parameters = { merge_method: "SQUASH" }
    const mainBypass = rulesets()
    mainBypass[0]!.bypassActors.push({ actorId: appId, actorType: "Integration", bypassMode: "always" })
    const nonAppMainBypass = rulesets()
    nonAppMainBypass[0]!.bypassActors.push({ actorId: 7, actorType: "Team", bypassMode: "always" })
    const wildcardExclude = rulesets()
    wildcardExclude[0]!.conditions.exclude.push("refs/heads/m*")
    const extraContext = rulesets()
    ;(
      extraContext[0]!.rules.find((rule) => rule.type === "required_status_checks")!.parameters!
        .required_status_checks as Array<{ context: string }>
    ).push({ context: "optional" })
    const extraRule = rulesets()
    extraRule[1]!.rules.push({ type: "required_linear_history" })
    const extraMethod = rulesets()
    ;(
      extraMethod[0]!.rules.find((rule) => rule.type === "pull_request")!.parameters!.allowed_merge_methods as string[]
    ).push("squash")
    const wrongIntegration = rulesets()
    ;(
      wrongIntegration[0]!.rules.find((rule) => rule.type === "required_status_checks")!.parameters!
        .required_status_checks as Array<{ context: string; integration_id: number }>
    )[0]!.integration_id = 999
    const fetchAndMerge = rulesets()
    fetchAndMerge[1]!.rules.find((rule) => rule.type === "update")!.parameters = {
      update_allows_fetch_and_merge: true,
    }
    const candidateWorkflow = rulesets()
    ;(
      candidateWorkflow[2]!.rules.find((rule) => rule.type === "workflows")!.parameters!.workflows as Array<{
        path: string
        ref: string
        repository_id: number
      }>
    )[0]!.ref = "refs/heads/feature"
    const repositoryWorkflow = rulesets()
    repositoryWorkflow[2]!.sourceType = "Repository"
    const inheritedAppBypass = rulesets()
    inheritedAppBypass[2]!.currentUserCanBypass = "always"
    for (const input of [
      { repository: settings({ defaultBranch: "trunk" }), rulesets: rulesets() },
      { repository: settings({ allowAutoMerge: false }), rulesets: rulesets() },
      { repository: settings(), rulesets: missingCheck },
      { repository: settings(), rulesets: wrongQueue },
      { repository: settings(), rulesets: mainBypass },
      { repository: settings(), rulesets: nonAppMainBypass },
      { repository: settings(), rulesets: wildcardExclude },
      { repository: settings(), rulesets: extraContext },
      { repository: settings(), rulesets: extraRule },
      { repository: settings(), rulesets: extraMethod },
      { repository: settings(), rulesets: wrongIntegration },
      { repository: settings(), rulesets: fetchAndMerge },
      { repository: settings(), rulesets: candidateWorkflow },
      { repository: settings(), rulesets: repositoryWorkflow },
      { repository: settings(), rulesets: inheritedAppBypass },
    ]) {
      expect(() =>
        validateRepositorySettings({
          ...input,
          repositoryId,
          nameWithOwner: repository,
          appId,
        }),
      ).toThrow("settings unavailable")
    }
  })
})

describe("exact-head auto-merge transaction", () => {
  function api(
    pullRequests: ProvenancePullRequest[],
    state: Partial<Awaited<ReturnType<PublisherApi["getAutoMergeState"]>>> = {},
  ): PublisherApi {
    let index = 0
    const unused = async (): Promise<never> => {
      throw new Error("unexpected publisher API call")
    }
    return {
      getPublisherIdentity: unused,
      getRepository: async () => settings(),
      getRef: async (ref) => (ref === branch ? headSha : undefined),
      getCommit: unused,
      listOpenPullRequests: unused,
      createPullRequest: unused,
      updatePullRequest: unused,
      closePullRequest: unused,
      getPullRequest: async () => pullRequests[Math.min(index++, pullRequests.length - 1)]!,
      listRulesets: async () => rulesets(),
      getAutoMergeState: async () => ({
        number: 17,
        state: "OPEN",
        headSha,
        autoMergeMethod: "REBASE",
        ...state,
      }),
    }
  }

  test("revalidates settings and the exact head before and after mutation", async () => {
    let merged = false
    expect(
      await enablePreparedAutoMerge({
        repository,
        repositoryId,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
        token: "installation-token",
        settingsToken: "settings-token",
        api: api([pullRequest(), pullRequest(), pullRequest()]),
        merge: async (input) => {
          merged = true
          expect(input).toMatchObject({ repository, prNumber: 17, headSha })
          return true
        },
      }),
    ).toEqual({ phase: "auto_merge_enabled" })
    expect(merged).toBeTrue()
  })

  test("allows main and the live PR base SHA to advance after publication", async () => {
    const advancedMain = "7".repeat(40)
    let merged = false
    expect(
      await enablePreparedAutoMerge({
        repository,
        repositoryId,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
        token: "mutation-token",
        settingsToken: "settings-read-token",
        api: api([
          pullRequest({ baseSha: advancedMain }),
          pullRequest({ baseSha: advancedMain }),
          pullRequest({ baseSha: advancedMain }),
        ]),
        merge: async (input) => {
          merged = true
          expect(input.token).toBe("mutation-token")
          return true
        },
      }),
    ).toEqual({ phase: "auto_merge_enabled" })
    expect(merged).toBeTrue()
  })

  test("does not mutate after a head race", async () => {
    let merged = false
    expect(
      enablePreparedAutoMerge({
        repository,
        repositoryId,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
        token: "installation-token",
        settingsToken: "settings-token",
        api: api([pullRequest(), pullRequest({ headSha: "8".repeat(40) })]),
        merge: async () => {
          merged = true
          return true
        },
      }),
    ).rejects.toThrow()
    expect(merged).toBeFalse()
  })

  test("rejects a non-REBASE or ambiguous final state", async () => {
    expect(
      enablePreparedAutoMerge({
        repository,
        repositoryId,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
        token: "installation-token",
        settingsToken: "settings-token",
        api: api([pullRequest(), pullRequest(), pullRequest()], {
          autoMergeMethod: "SQUASH",
          queuePullRequestNumber: 17,
          queuePullRequestHeadSha: headSha,
          queueHeadSha: "9".repeat(40),
        }),
        merge: async () => true,
      }),
    ).rejects.toThrow("state mismatch")
  })

  test("rejects repository settings drift after queue enrollment", async () => {
    const client = api([pullRequest(), pullRequest(), pullRequest()])
    let reads = 0
    client.listRulesets = async () => (++reads === 3 ? [] : rulesets())
    expect(
      enablePreparedAutoMerge({
        repository,
        repositoryId,
        appId,
        publisherBotId,
        prId: 99,
        prNumber: 17,
        branch,
        headSha,
        token: "installation-token",
        settingsToken: "settings-token",
        api: client,
        merge: async () => true,
      }),
    ).rejects.toThrow("settings unavailable")
  })
})

describe("merge group constituent binding", () => {
  const entry = (position: number, pullRequestNumber: number, overrides: Record<string, unknown> = {}) => ({
    id: `entry-${position}`,
    position,
    baseSha,
    headSha: String(position).repeat(40),
    pullRequestHeadSha: String(position + 2).repeat(40),
    pullRequestNumber,
    ...overrides,
  })

  test("requires the unique contiguous base-to-event-head chain", () => {
    const first = entry(4, 17)
    const second = entry(5, 18, { baseSha: first.headSha })
    const entries = [first, second]
    expect(selectMergeGroupChain({ entries, baseSha, headSha: second.headSha })).toEqual(entries)
    expect(
      selectMergeGroupChain({
        entries: [...entries, entry(6, 19, { baseSha })],
        baseSha,
        headSha: second.headSha,
      }),
    ).toEqual(entries)
    for (const input of [
      { entries: [first], headSha: second.headSha },
      { entries: [first, entry(6, 18, { baseSha: first.headSha })], headSha: "6".repeat(40) },
      {
        entries: [first, second, entry(6, 19, { baseSha: first.headSha, headSha: second.headSha })],
        headSha: second.headSha,
      },
    ]) {
      expect(() => selectMergeGroupChain({ ...input, baseSha })).toThrow("constituent mismatch")
    }
  })

  test("retains a foreign human PR head without treating it as automation provenance", async () => {
    const api = createProvenanceApi({
      token: "read-token",
      repository,
      repositoryId,
      baseUrl: "https://api.github.test",
      graphqlUrl: "https://api.github.test/graphql",
      fetch: async () =>
        Response.json({
          data: {
            repository: {
              databaseId: repositoryId,
              nameWithOwner: repository,
              mergeQueue: {
                entries: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "MQE_fork",
                      position: 1,
                      baseCommit: { oid: baseSha },
                      headCommit: { oid: headSha },
                      pullRequest: {
                        number: 21,
                        headRefOid: "7".repeat(40),
                        baseRefName: "main",
                        baseRepository: { databaseId: repositoryId, nameWithOwner: repository },
                        headRepository: { databaseId: 777, nameWithOwner: "contributor/fork" },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
    })
    expect(await api.listMergeQueueEntries()).toEqual([
      {
        id: "MQE_fork",
        position: 1,
        baseSha,
        headSha,
        pullRequestHeadSha: "7".repeat(40),
        pullRequestNumber: 21,
      },
    ])
  })
})

describe("durable path policy", () => {
  const oid = "a".repeat(40)
  const encode = (value: string) => new TextEncoder().encode(value)

  test("accepts regular modes and rejects protected paths and symlinks", () => {
    expect(
      validateProvenancePathRecords(
        encode(`:100644 100644 ${oid} ${oid} M\0packages/app/src/feature.ts\0`),
        encode("1\t1\tpackages/app/src/feature.ts\0"),
      ),
    ).toEqual(["packages/app/src/feature.ts"])
    expect(() =>
      validateProvenancePathRecords(
        encode(`:100644 100644 ${oid} ${oid} M\0.github/workflows/pwn.yml\0`),
        encode("1\t1\t.github/workflows/pwn.yml\0"),
      ),
    ).toThrow("protected")
    expect(() =>
      validateProvenancePathRecords(
        encode(`:000000 120000 ${"0".repeat(40)} ${oid} A\0link\0`),
        encode("1\t0\tlink\0"),
      ),
    ).toThrow("mode")
  })
})

test("provenance workflow uses only trusted pinned read-only inputs", async () => {
  const workflow = await Bun.file(join(import.meta.dir, "..", ".github", "workflows", "oc2-provenance.yml")).text()
  expect(workflow).toContain("permissions: {}")
  expect(workflow).toContain("name: provenance/path-policy")
  expect(workflow).toContain("pull_request_target:")
  expect(workflow).toContain("merge_group:")
  expect(workflow.match(/actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/g)).toHaveLength(1)
  expect(workflow).toContain("ref: ${{ github.workflow_sha }}")
  expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
  expect(workflow).not.toContain("secrets.")
  expect(workflow).not.toContain("contents: write")
  expect(workflow).not.toContain("pull-requests: write")
  expect(workflow).not.toContain("pull_request.head.sha }}")
})
