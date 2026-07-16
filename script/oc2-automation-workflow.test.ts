import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { Admission } from "./oc2-issue"
import { runGeneration } from "./oc2-automation-workflow"

const rawTitle = "RAW_ISSUE_TITLE"
const rawBody = "RAW_ISSUE_BODY"
const rawAttachment = "RAW_ATTACHMENT_BYTES"

function admission(label: "task" | "feature"): Admission {
  const value: Admission = {
    version: 1,
    status: "admitted",
    phase: "running",
    key: "",
    repository: { id: 1234, nameWithOwner: "octo/oc2", baseBranch: "main", baseSha: "1".repeat(40) },
    issue: {
      number: 42,
      nodeId: "I_issue42",
      label,
      labelId: 501,
      labelEventNodeId: "LE_label42",
      cutoff: "2026-07-16T10:00:00Z",
    },
    run: { id: 800, attempt: 1 },
    marker: { commentId: 700 },
  }
  value.key = createHash("sha256")
    .update(
      JSON.stringify([value.repository.id, value.issue.nodeId, value.issue.labelId, value.issue.labelEventNodeId]),
    )
    .digest("hex")
  return value
}

async function fixture(label: "task" | "feature") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc2-workflow-")))
  const checkout = join(root, "checkout")
  const bundleDir = join(root, "bundle")
  const stateDir = join(root, "state")
  const attachment = Buffer.from(rawAttachment)
  const hash = createHash("sha256").update(attachment).digest("hex")
  const attachmentPath = `attachments/${hash}.txt`
  await Promise.all([
    mkdir(join(checkout, "specs"), { recursive: true }),
    mkdir(join(bundleDir, "attachments"), { recursive: true }),
    mkdir(stateDir),
  ])
  await Bun.write(join(bundleDir, attachmentPath), attachment)
  const admitted = admission(label)
  await Bun.write(
    join(bundleDir, "issue.json"),
    JSON.stringify({
      repository: admitted.repository,
      issue: {
        number: admitted.issue.number,
        nodeId: admitted.issue.nodeId,
        title: rawTitle,
        body: rawBody,
        label: admitted.issue.label,
        labelEventNodeId: admitted.issue.labelEventNodeId,
        cutoff: admitted.issue.cutoff,
      },
      comments: [],
      attachments: [
        {
          sourceUrl: "https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000001",
          path: attachmentPath,
          mediaType: "text/plain",
          size: attachment.byteLength,
          sha256: hash,
        },
      ],
    }),
  )
  return {
    admitted,
    attachmentFile: join(bundleDir, attachmentPath),
    bundleDir,
    checkout,
    phaseFile: join(root, "phase"),
    record: join(root, "record.jsonl"),
    root,
    stateDir,
  }
}

async function fakeOc2(root: string, record: string, outputs: Record<string, { stdout: string; exitCode: number }>) {
  const executable = join(root, "fake-oc2")
  await Bun.write(
    executable,
    [
      "#!/usr/bin/env bun",
      'import { appendFileSync } from "node:fs"',
      "const args = Bun.argv.slice(2)",
      `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: process.env }) + "\\n")`,
      'const name = args.includes("issue-planner") ? "planner" : args.includes("issue-implementer") ? "implementer" : "task"',
      `const output = ${JSON.stringify(outputs)}[name]`,
      "process.stdout.write(output.stdout)",
      "process.exit(output.exitCode)",
      "",
    ].join("\n"),
  )
  await chmod(executable, 0o700)
  return executable
}

async function withProviderKey<A>(run: () => Promise<A>) {
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "test-provider-key"
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
}

function success(text: string) {
  return `${JSON.stringify({ status: "ok", sessionID: "ses_safe123", text })}\n`
}

function failure(error: string) {
  return `${JSON.stringify({ status: "error", sessionID: "ses_safe123", error })}\n`
}

describe("trusted automation execution", () => {
  test("passes only literal prompts and all admitted files to the bound task and feature agents", async () => {
    await withProviderKey(async () => {
      const feature = await fixture("feature")
      const task = await fixture("task")
      try {
        const featureOc2 = await fakeOc2(feature.root, feature.record, {
          planner: { stdout: success("# Approved feature plan"), exitCode: 0 },
          implementer: { stdout: success("implemented"), exitCode: 0 },
          task: { stdout: success("unused"), exitCode: 0 },
        })
        const taskOc2 = await fakeOc2(task.root, task.record, {
          planner: { stdout: success("unused"), exitCode: 0 },
          implementer: { stdout: success("unused"), exitCode: 0 },
          task: { stdout: success("implemented"), exitCode: 0 },
        })
        await runGeneration({ ...feature, admission: feature.admitted, oc2: featureOc2 })
        await runGeneration({ ...task, admission: task.admitted, oc2: taskOc2 })

        const featureRecord = await Bun.file(feature.record).text()
        const calls = featureRecord
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> })
        expect(calls).toHaveLength(2)
        const common = [
          "run",
          "--automation",
          "--pure",
          "--dir",
          feature.checkout,
          "--model",
          "openai/gpt-5.6-sol",
          "--format",
          "result-json",
        ]
        const fileArgs = ["--file", join(feature.bundleDir, "issue.json"), "--file", feature.attachmentFile]
        expect(calls[0]?.args).toEqual([
          ...common,
          "--agent",
          "issue-planner",
          "--variant",
          "xhigh",
          ...fileArgs,
          "--command",
          "spec:planner",
          "--",
          "Plan the admitted feature from the attached issue snapshot as exactly one implementation slice.",
        ])
        expect(calls[1]?.args).toEqual([
          ...common,
          "--agent",
          "issue-implementer",
          "--variant",
          "xhigh",
          ...fileArgs,
          "--command",
          "spec:implement",
          "--",
          "specs/issue-42.md",
          "1",
        ])
        expect(featureRecord).not.toContain(rawTitle)
        expect(featureRecord).not.toContain(rawBody)
        expect(featureRecord).not.toContain(rawAttachment)

        const taskCall = JSON.parse((await Bun.file(task.record).text()).trim()) as {
          args: string[]
          env: Record<string, string>
        }
        expect(taskCall.args).toEqual([
          "run",
          "--automation",
          "--pure",
          "--dir",
          task.checkout,
          "--model",
          "openai/gpt-5.6-sol",
          "--format",
          "result-json",
          "--agent",
          "issue-task",
          "--variant",
          "high",
          "--file",
          join(task.bundleDir, "issue.json"),
          "--file",
          task.attachmentFile,
          "--",
          "Implement the admitted task from the attached issue snapshot.",
        ])
        expect(JSON.stringify(taskCall)).not.toContain(rawTitle)
        expect(JSON.stringify(taskCall)).not.toContain(rawBody)
        expect(JSON.stringify(taskCall)).not.toContain(rawAttachment)
      } finally {
        await Promise.all([
          rm(feature.root, { recursive: true, force: true }),
          rm(task.root, { recursive: true, force: true }),
        ])
      }
    })
  })

  test("maps canonical OC2 error results from exit 1 or 2 to durable phases", async () => {
    await withProviderKey(async () => {
      for (const [error, exitCode, phase] of [
        ["permission_denied", 1, "permission_denied"],
        ["tool_error", 1, "tool_failed"],
        ["provider_error", 1, "model_failed"],
        ["session_error", 1, "model_failed"],
        ["cancelled", 1, "model_failed"],
        ["timeout", 1, "model_failed"],
        ["invalid_agent", 2, "model_failed"],
      ] as const) {
        const item = await fixture("task")
        try {
          const oc2 = await fakeOc2(item.root, item.record, {
            task: { stdout: failure(error), exitCode },
            planner: { stdout: success("unused"), exitCode: 0 },
            implementer: { stdout: success("unused"), exitCode: 0 },
          })
          await expect(runGeneration({ ...item, admission: item.admitted, oc2 })).rejects.toThrow(
            "automation execution failed",
          )
          expect(await Bun.file(item.phaseFile).text()).toBe(`${phase}\n`)
        } finally {
          await rm(item.root, { recursive: true, force: true })
        }
      }
    })
  })

  test("rejects malformed, noncanonical, missing, and exit-status-mismatched results without disclosure", async () => {
    await withProviderKey(async () => {
      for (const output of [
        { stdout: success("wrong exit"), exitCode: 1 },
        { stdout: failure("permission_denied"), exitCode: 0 },
        { stdout: failure("tool_error"), exitCode: 3 },
        { stdout: failure("invalid_agent"), exitCode: 1 },
        { stdout: failure("session_error"), exitCode: 2 },
        { stdout: '{"status":"ok"}\n', exitCode: 0 },
        { stdout: `${success("first")}${success("second")}`, exitCode: 0 },
        { stdout: "", exitCode: 1 },
      ]) {
        const item = await fixture("task")
        try {
          const oc2 = await fakeOc2(item.root, item.record, {
            task: output,
            planner: { stdout: success("unused"), exitCode: 0 },
            implementer: { stdout: success("unused"), exitCode: 0 },
          })
          await expect(runGeneration({ ...item, admission: item.admitted, oc2 })).rejects.toThrow(
            "automation execution failed",
          )
          expect(await Bun.file(item.phaseFile).text()).toBe("model_failed\n")
        } finally {
          await rm(item.root, { recursive: true, force: true })
        }
      }
    })
  })
})
