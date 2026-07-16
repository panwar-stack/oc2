import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  branchName,
  createPublisherApi,
  decodeVerification,
  deriveStatusPhase,
  pullRequestText,
  pushArguments,
  requireBranchLease,
  requireRepositoryBase,
  requireVerifiedTree,
  type PublicationStateInput,
  type PullRequest,
} from "./oc2-publish"

const baseSha = "1".repeat(40)
const headSha = "2".repeat(40)
const treeSha = "3".repeat(40)
const patchSha256 = "4".repeat(64)
const key = "5".repeat(64)
const runUrl = "https://github.com/octo/oc2/actions/runs/800/attempts/1"
const branch = branchName(42, key)
const appSlug = "oc2-publisher"

function commit(overrides: Partial<{ message: string; author: { name: string; email: string } }> = {}) {
  const identity = { name: `${appSlug}[bot]`, email: `9002+${appSlug}[bot]@users.noreply.github.com` }
  return {
    message: `OC2 issue #42\n\nAutomation-Key: ${key}`,
    author: identity,
    committer: identity,
    ...overrides,
  }
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  const text = pullRequestText(42, runUrl, baseSha, headSha, patchSha256)
  return {
    id: 90,
    number: 12,
    url: "https://github.com/octo/oc2/pull/12",
    userId: 9002,
    title: text.title,
    body: text.body,
    headSha,
    headRef: branch,
    headRepositoryId: 1234,
    baseRef: "main",
    baseSha,
    baseRepositoryId: 1234,
    ...overrides,
  }
}

function states(overrides: Partial<PublicationStateInput> = {}): PublicationStateInput {
  return {
    admitResult: "success",
    ingestResult: "success",
    ingestState: "running",
    generateResult: "success",
    generateState: "generated",
    verifyResult: "success",
    verifyState: "verified",
    publishResult: "success",
    publishState: "pr_opened",
    autoMergeResult: "success",
    autoMergeState: "auto_merge_enabled",
    ...overrides,
  }
}

describe("publication repository and ref gates", () => {
  test("resolves the App bot identity without using the user-token endpoint", async () => {
    const requested: string[] = []
    const api = createPublisherApi({
      token: "installation-token",
      repository: "octo/oc2",
      baseUrl: "https://api.github.test",
      fetch: async (request) => {
        requested.push(String(request))
        return Response.json({ id: 9002, login: "oc2-publisher[bot]", type: "Bot" })
      },
    })
    expect(await api.getPublisherIdentity("oc2-publisher")).toEqual({
      id: 9002,
      login: "oc2-publisher[bot]",
      type: "Bot",
    })
    expect(new URL(requested[0]!).pathname).toBe("/users/oc2-publisher%5Bbot%5D")
    expect(requested[0]).not.toEndWith("/user")
  })

  test("decodes the fixed multiline PR body returned by GitHub", async () => {
    const text = pullRequestText(42, runUrl, baseSha, headSha, patchSha256)
    const api = createPublisherApi({
      token: "installation-token",
      repository: "octo/oc2",
      baseUrl: "https://api.github.test",
      fetch: async () =>
        Response.json([
          {
            id: 90,
            number: 12,
            html_url: "https://github.com/octo/oc2/pull/12",
            user: { id: 9002 },
            title: text.title,
            body: text.body,
            head: { sha: headSha, ref: branch, repo: { id: 1234 } },
            base: { sha: baseSha, ref: "main", repo: { id: 1234 } },
          },
        ]),
    })
    expect(await api.listOpenPullRequests(branch)).toEqual([pullRequest()])
  })

  test("aborts when the default branch or admitted main SHA moved", () => {
    expect(() =>
      requireRepositoryBase(
        { repositoryId: 1234, repository: "octo/oc2", baseSha },
        { id: 1234, nameWithOwner: "octo/oc2", defaultBranch: "trunk", mainSha: baseSha },
      ),
    ).toThrow("stale_base")
    expect(() =>
      requireRepositoryBase(
        { repositoryId: 1234, repository: "octo/oc2", baseSha },
        { id: 1234, nameWithOwner: "octo/oc2", defaultBranch: "main", mainSha: "9".repeat(40) },
      ),
    ).toThrow("stale_base")
  })

  test("creates only an absent ref with an explicit empty lease", () => {
    expect(
      requireBranchLease({
        branchSha: undefined,
        pullRequests: [],
        publisherBotId: 9002,
        repositoryId: 1234,
        branch,
        issueNumber: 42,
        runUrl,
        baseSha,
        patchSha256,
        key,
        appSlug,
      }),
    ).toBeUndefined()
    expect(pushArguments("https://github.com/octo/oc2.git", branch, headSha)).toEqual([
      "push",
      `--force-with-lease=refs/heads/${branch}:`,
      "https://github.com/octo/oc2.git",
      `${headSha}:refs/heads/${branch}`,
    ])
  })

  test("updates only with the exact known SHA and App-owned PR", () => {
    expect(
      requireBranchLease({
        branchSha: headSha,
        pullRequests: [pullRequest()],
        publisherBotId: 9002,
        repositoryId: 1234,
        branch,
        issueNumber: 42,
        runUrl,
        baseSha,
        patchSha256,
        key,
        appSlug,
        commit: commit(),
      }),
    ).toBe(headSha)
    expect(pushArguments("https://github.com/octo/oc2.git", branch, baseSha, headSha)[1]).toBe(
      `--force-with-lease=refs/heads/${branch}:${headSha}`,
    )
    for (const unowned of [
      pullRequest({ userId: 666 }),
      pullRequest({ headRepositoryId: 999 }),
      pullRequest({ headSha: baseSha }),
      pullRequest({ body: "Issue: #42" }),
    ]) {
      expect(() =>
        requireBranchLease({
          branchSha: headSha,
          pullRequests: [unowned],
          publisherBotId: 9002,
          repositoryId: 1234,
          branch,
          issueNumber: 42,
          runUrl,
          baseSha,
          patchSha256,
          key,
          appSlug,
          commit: commit(),
        }),
      ).toThrow("push_race")
    }
  })

  test("rejects orphan and duplicate pull requests", () => {
    for (const input of [
      { branchSha: undefined, pullRequests: [pullRequest()] },
      { branchSha: headSha, pullRequests: [] },
      { branchSha: headSha, pullRequests: [pullRequest(), pullRequest({ id: 91, number: 13 })] },
    ]) {
      expect(() =>
        requireBranchLease({
          ...input,
          publisherBotId: 9002,
          repositoryId: 1234,
          branch,
          issueNumber: 42,
          runUrl,
          baseSha,
          patchSha256,
          key,
          appSlug,
          commit: input.branchSha === undefined ? undefined : commit(),
        }),
      ).toThrow("push_race")
    }
    expect(() =>
      requireBranchLease({
        branchSha: headSha,
        pullRequests: [pullRequest()],
        publisherBotId: 9002,
        repositoryId: 1234,
        branch,
        issueNumber: 42,
        runUrl,
        baseSha,
        patchSha256,
        key,
        appSlug,
        commit: commit({ message: `OC2 issue #42\n\nAutomation-Key: ${"6".repeat(64)}` }),
      }),
    ).toThrow("push_race")
  })
})

describe("publication artifact binding", () => {
  const verification = {
    version: 1 as const,
    repository: { id: 1234, nameWithOwner: "octo/oc2" },
    baseSha,
    patchSha256,
    treeSha,
  }

  test("requires the exact verifier tree and rejects extra fields", () => {
    expect(() =>
      requireVerifiedTree({
        repositoryId: 1234,
        repository: "octo/oc2",
        baseSha,
        patchSha256,
        treeSha: headSha,
        verification,
      }),
    ).toThrow("verification tree mismatch")
    expect(() => decodeVerification(JSON.stringify({ ...verification, modelOutput: "secret" }))).toThrow(
      "invalid verification artifact",
    )
    expect(decodeVerification(`${JSON.stringify(verification)}\n`)).toEqual(verification)
  })

  test("uses bounded fixed PR text without issue or model content", () => {
    const text = pullRequestText(42, runUrl, baseSha, headSha, patchSha256)
    expect(text.title).toBe("OC2 issue #42")
    expect(text.body.split("\n")).toEqual([
      "Issue: #42",
      `Run: ${runUrl}`,
      `Base: ${baseSha}`,
      `Head: ${headSha}`,
      `Patch: ${patchSha256}`,
    ])
  })
})

describe("fixed status phase precedence", () => {
  test.each([
    ["no changes", { generateState: "no_changes" }, "no_changes"],
    ["patch rejected", { generateResult: "failure", generateState: "patch_rejected" }, "patch_rejected"],
    ["permission denied", { generateResult: "failure", generateState: "permission_denied" }, "permission_denied"],
    ["verification failure", { verifyResult: "failure", verifyState: "verification_failed" }, "verification_failed"],
    ["stale base", { publishState: "stale_base" }, "stale_base"],
    ["push race", { publishResult: "failure", publishState: "push_race" }, "push_race"],
    ["auto-merge enabled", {}, "auto_merge_enabled"],
    [
      "auto-merge unavailable",
      { autoMergeResult: "failure", autoMergeState: "auto_merge_unavailable" },
      "auto_merge_unavailable",
    ],
  ] as const)("selects %s", (_name, override, expected) => {
    expect(deriveStatusPhase(states(override))).toBe(expected)
  })

  test("fails closed by pipeline order without reading logs", () => {
    expect(
      deriveStatusPhase(
        states({
          ingestResult: "failure",
          ingestState: "none",
          generateResult: "failure",
          generateState: "patch_rejected",
          verifyResult: "failure",
          verifyState: "verification_failed",
          publishResult: "failure",
          publishState: "stale_base",
        }),
      ),
    ).toBe("tool_failed")
    expect(deriveStatusPhase(states({ admitResult: "failure", ingestResult: "skipped" }))).toBe("tool_failed")
    expect(() => deriveStatusPhase(states({ publishResult: "timed_out" }))).toThrow("invalid job result")
  })
})

describe("workflow secret boundaries", () => {
  test("keeps the token transient and disables credential persistence", async () => {
    const workflow = await Bun.file(join(import.meta.dir, "..", ".github", "workflows", "oc2-issue.yml")).text()
    const helper = await Bun.file(join(import.meta.dir, "oc2-publish.ts")).text()
    expect(workflow.match(/persist-credentials: false/g)?.length).toBeGreaterThanOrEqual(5)
    expect(workflow).toContain("actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349")
    expect(workflow).toContain("permission-contents: write")
    expect(workflow).toContain("permission-pull-requests: write")
    expect(workflow).toContain("permission-administration: read")
    expect(workflow).not.toContain("permission-administration: write")
    const publicationToken = workflow.slice(
      workflow.indexOf("      - name: Create repository-scoped publisher token"),
      workflow.indexOf("      - name: Publish verified change"),
    )
    expect(publicationToken).toContain("permission-contents: write")
    expect(publicationToken).toContain("permission-pull-requests: write")
    expect(publicationToken).not.toContain("permission-administration:")
    const settingsToken = workflow.slice(
      workflow.indexOf("      - name: Create ruleset settings App token"),
      workflow.indexOf("      - name: Create exact auto-merge App token"),
    )
    expect(settingsToken).toContain("permission-administration: read")
    expect(settingsToken).not.toContain("permission-administration: write")
    expect(workflow).toContain("if: always() && github.repository == 'panwar-stack/oc2'")
    expect(workflow).toContain("ref: ${{ github.sha }}")
    const status = workflow.slice(workflow.indexOf("  status:"))
    expect(status).not.toContain("download-artifact")
    expect(status).not.toContain("needs.admit.outputs.execute")
    expect(status).toContain('--run-id "$RUN_ID"')
    expect(status).toContain('--admit-result "$ADMIT_RESULT"')
    expect(helper).toContain('"--auto"')
    expect(helper).toContain('"--rebase"')
    expect(helper).toContain('"--match-head-commit"')
    expect(workflow).not.toContain("update-branch")
    expect(helper).not.toContain("https://x-access-token:")
    expect(helper).not.toContain("remote add")
    expect(helper).toContain("GIT_ASKPASS_REQUIRE")
    expect(helper).toContain("rm(askpassDir, { recursive: true, force: true })")
    expect(pushArguments("https://github.com/octo/oc2.git", branch, headSha).join(" ")).not.toContain("secret-token")
  })
})
