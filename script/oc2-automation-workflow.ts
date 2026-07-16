#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { appendFile, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { validateChangedPaths } from "./oc2-automation-policy"
import { maximumChangedFiles, maximumPatchBytes } from "./oc2-verify"
import type { Admission, IssueBundle } from "./oc2-issue"

const maximumAdmissionBytes = 64 * 1024
const maximumBundleTextBytes = 512 * 1024
const maximumComments = 100
const maximumAttachments = 5
const maximumAttachmentBytes = 5 * 1024 * 1024
const maximumTotalAttachmentBytes = 20 * 1024 * 1024
const maximumResultBytes = 1024 * 1024
const maximumPlanBytes = 256 * 1024
const shaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const resultErrors = new Set([
  "invalid_input",
  "invalid_agent",
  "invalid_model",
  "invalid_variant",
  "invalid_command",
  "permission_denied",
  "tool_error",
  "provider_error",
  "session_error",
  "cancelled",
  "timeout",
])

class AutomationExecutionError extends Error {
  constructor(readonly phase: "permission_denied" | "tool_failed" | "model_failed") {
    super("automation execution failed")
  }
}
const mediaExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["text/markdown", "md"],
  ["text/plain", "txt"],
  ["application/json", "json"],
])
const decoder = new TextDecoder("utf-8", { fatal: true })

type AdmissionResult =
  | Admission
  | { version: 1; status: "waiting_for_label"; phase: "waiting_for_label" }
  | { version: 1; status: "rejected"; phase: "rejected_actor" | "ambiguous_label" | "stale_base" }
  | { version: 1; status: "duplicate"; phase: "duplicate"; key: string }

function exactKeys(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("invalid workflow input")
  return value
}

function boundedString(value: unknown, maximum = 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error("invalid workflow input")
  ensureText(value)
  return value
}

function timestamp(value: unknown) {
  const text = boundedString(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || !Number.isFinite(Date.parse(text)))
    throw new Error("invalid workflow input")
  return text
}

function ensureText(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) throw new Error("invalid workflow input")
      index++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid workflow input")
  }
}

async function readRegularUtf8(path: string, maximum: number) {
  const before = await lstat(path)
  if (!before.isFile() || before.size < 1 || before.size > maximum) throw new Error("invalid workflow input")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await file.stat()
    if (!current.isFile() || current.size !== before.size || current.dev !== before.dev || current.ino !== before.ino)
      throw new Error("invalid workflow input")
    const bytes = new Uint8Array(await file.readFile())
    if (bytes.byteLength !== current.size) throw new Error("invalid workflow input")
    return decoder.decode(bytes)
  } finally {
    await file.close()
  }
}

function parseJson(source: string) {
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new Error("invalid workflow input")
  }
}

export function decodeAdmission(source: string): AdmissionResult {
  const value = parseJson(source)
  if (!exactKeys(value, ["version", "status", "phase"]) || value.version !== 1) {
    if (
      exactKeys(value, ["version", "status", "phase", "key"]) &&
      value.version === 1 &&
      value.status === "duplicate" &&
      value.phase === "duplicate" &&
      typeof value.key === "string" &&
      sha256Pattern.test(value.key)
    )
      return { version: 1, status: "duplicate", phase: "duplicate", key: value.key }
    if (!exactKeys(value, ["version", "status", "phase", "key", "repository", "issue", "run", "marker"]))
      throw new Error("invalid admission artifact")
  }
  if (value.status === "waiting_for_label" && value.version === 1 && value.phase === "waiting_for_label")
    return { version: 1, status: "waiting_for_label", phase: "waiting_for_label" }
  if (
    value.status === "rejected" &&
    value.version === 1 &&
    new Set(["rejected_actor", "ambiguous_label", "stale_base"]).has(String(value.phase))
  )
    return { version: 1, status: "rejected", phase: value.phase as "rejected_actor" | "ambiguous_label" | "stale_base" }
  if (value.status !== "admitted" || value.phase !== "running" || value.version !== 1)
    throw new Error("invalid admission artifact")
  if (
    !exactKeys(value.repository, ["id", "nameWithOwner", "baseBranch", "baseSha"]) ||
    !exactKeys(value.issue, ["number", "nodeId", "label", "labelId", "labelEventNodeId", "cutoff"]) ||
    !exactKeys(value.run, ["id", "attempt"]) ||
    !exactKeys(value.marker, ["commentId"]) ||
    typeof value.key !== "string" ||
    !sha256Pattern.test(value.key) ||
    typeof value.repository.nameWithOwner !== "string" ||
    !repositoryPattern.test(value.repository.nameWithOwner) ||
    value.repository.baseBranch !== "main" ||
    typeof value.repository.baseSha !== "string" ||
    !shaPattern.test(value.repository.baseSha) ||
    (value.issue.label !== "task" && value.issue.label !== "feature")
  )
    throw new Error("invalid admission artifact")
  const admission: Admission = {
    version: 1,
    status: "admitted",
    phase: "running",
    key: value.key,
    repository: {
      id: positiveInteger(value.repository.id),
      nameWithOwner: value.repository.nameWithOwner,
      baseBranch: "main",
      baseSha: value.repository.baseSha,
    },
    issue: {
      number: positiveInteger(value.issue.number),
      nodeId: boundedString(value.issue.nodeId),
      label: value.issue.label,
      labelId: positiveInteger(value.issue.labelId),
      labelEventNodeId: boundedString(value.issue.labelEventNodeId),
      cutoff: timestamp(value.issue.cutoff),
    },
    run: { id: positiveInteger(value.run.id), attempt: positiveInteger(value.run.attempt) },
    marker: { commentId: positiveInteger(value.marker.commentId) },
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        admission.repository.id,
        admission.issue.nodeId,
        admission.issue.labelId,
        admission.issue.labelEventNodeId,
      ]),
    )
    .digest("hex")
  if (key !== admission.key) throw new Error("invalid admission artifact")
  return admission
}

function admitted(value: AdmissionResult): Admission {
  if (value.status !== "admitted") throw new Error("admission did not authorize execution")
  return value
}

export async function validateAdmissionEvent(
  admission: AdmissionResult,
  eventPath: string,
  repository: string,
  repositoryId: number,
) {
  const event = parseJson(await readRegularUtf8(eventPath, 2 * 1024 * 1024))
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid event")
  const root = event as Record<string, unknown>
  if (
    !root.repository ||
    typeof root.repository !== "object" ||
    Array.isArray(root.repository) ||
    !root.issue ||
    typeof root.issue !== "object" ||
    Array.isArray(root.issue)
  )
    throw new Error("invalid event")
  const eventRepository = root.repository
  const eventIssue = root.issue
  if (
    !eventRepository ||
    typeof eventRepository !== "object" ||
    !eventIssue ||
    typeof eventIssue !== "object" ||
    (eventRepository as Record<string, unknown>).id !== repositoryId ||
    (eventRepository as Record<string, unknown>).full_name !== repository
  )
    throw new Error("event identity mismatch")
  if (admission.status === "waiting_for_label") {
    if (root.action !== "opened") throw new Error("event identity mismatch")
    return
  }
  if (admission.status !== "admitted") return
  const issue = eventIssue as Record<string, unknown>
  const label = root.label
  if (
    admission.repository.id !== repositoryId ||
    admission.repository.nameWithOwner !== repository ||
    root.action !== "labeled" ||
    !label ||
    typeof label !== "object" ||
    issue.number !== admission.issue.number ||
    issue.node_id !== admission.issue.nodeId ||
    issue.state !== "open" ||
    issue.updated_at !== admission.issue.cutoff ||
    (label as Record<string, unknown>).id !== admission.issue.labelId ||
    (label as Record<string, unknown>).name !== admission.issue.label
  )
    throw new Error("event identity mismatch")
}

function validateExpectedAdmission(
  admission: Admission,
  expected: { repository: string; repositoryId: number; baseSha: string; key: string },
) {
  if (
    admission.repository.nameWithOwner !== expected.repository ||
    admission.repository.id !== expected.repositoryId ||
    admission.repository.baseSha !== expected.baseSha ||
    admission.key !== expected.key
  )
    throw new Error("admission identity mismatch")
}

async function appendOutputs(path: string, values: Readonly<Record<string, string>>) {
  const lines = Object.entries(values)
  if (lines.some(([name, value]) => !/^[a-z_]+$/.test(name) || /[\r\n]/.test(value)))
    throw new Error("invalid workflow output")
  await appendFile(path, lines.map(([name, value]) => `${name}=${value}\n`).join(""), { encoding: "utf8" })
}

async function listBundleFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const paths: string[] = []
  for (const entry of entries) {
    const path = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("invalid issue bundle")
    if (entry.isDirectory()) paths.push(...(await listBundleFiles(root, path)))
    else paths.push(path)
  }
  return paths.sort()
}

export async function validateIssueBundle(bundleDir: string, admission: Admission, checkout: string) {
  const root = await realpath(bundleDir)
  const workspace = await realpath(checkout)
  const location = relative(workspace, root)
  if ((location !== ".." && !location.startsWith(`..${sep}`)) || isAbsolute(location))
    throw new Error("issue bundle must be outside checkout")
  const value = parseJson(await readRegularUtf8(join(root, "issue.json"), 1024 * 1024))
  if (
    !exactKeys(value, ["repository", "issue", "comments", "attachments"]) ||
    !exactKeys(value.repository, ["id", "nameWithOwner", "baseBranch", "baseSha"]) ||
    !exactKeys(value.issue, ["number", "nodeId", "title", "body", "label", "labelEventNodeId", "cutoff"]) ||
    value.repository.id !== admission.repository.id ||
    value.repository.nameWithOwner !== admission.repository.nameWithOwner ||
    value.repository.baseBranch !== admission.repository.baseBranch ||
    value.repository.baseSha !== admission.repository.baseSha ||
    value.issue.number !== admission.issue.number ||
    value.issue.nodeId !== admission.issue.nodeId ||
    value.issue.label !== admission.issue.label ||
    value.issue.labelEventNodeId !== admission.issue.labelEventNodeId ||
    value.issue.cutoff !== admission.issue.cutoff ||
    typeof value.issue.title !== "string" ||
    typeof value.issue.body !== "string" ||
    !Array.isArray(value.comments) ||
    value.comments.length > maximumComments ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > maximumAttachments
  )
    throw new Error("invalid issue bundle")
  ensureText(value.issue.title)
  ensureText(value.issue.body)
  let textBytes = Buffer.byteLength(value.issue.title) + Buffer.byteLength(value.issue.body)
  for (const comment of value.comments) {
    if (!exactKeys(comment, ["nodeId", "author", "createdAt", "updatedAt", "body"]) || typeof comment.body !== "string")
      throw new Error("invalid issue bundle")
    boundedString(comment.nodeId)
    boundedString(comment.author)
    timestamp(comment.createdAt)
    timestamp(comment.updatedAt)
    ensureText(comment.body)
    textBytes += Buffer.byteLength(comment.body)
  }
  if (textBytes > maximumBundleTextBytes) throw new Error("invalid issue bundle")
  const expectedPaths = ["issue.json"]
  let attachmentBytes = 0
  let previousHash = ""
  for (const attachment of value.attachments) {
    if (
      !exactKeys(attachment, ["sourceUrl", "path", "mediaType", "size", "sha256"]) ||
      typeof attachment.sourceUrl !== "string" ||
      typeof attachment.path !== "string" ||
      typeof attachment.mediaType !== "string" ||
      typeof attachment.sha256 !== "string" ||
      !sha256Pattern.test(attachment.sha256) ||
      attachment.sha256 <= previousHash ||
      typeof attachment.size !== "number" ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 1 ||
      attachment.size > maximumAttachmentBytes
    )
      throw new Error("invalid issue bundle")
    const extension = mediaExtensions.get(attachment.mediaType)
    if (!extension || attachment.path !== `attachments/${attachment.sha256}.${extension}`)
      throw new Error("invalid issue bundle")
    const file = await open(join(root, attachment.path), constants.O_RDONLY | constants.O_NOFOLLOW)
    const content = new Uint8Array(await file.readFile().finally(() => file.close()))
    if (
      content.byteLength !== attachment.size ||
      createHash("sha256").update(content).digest("hex") !== attachment.sha256
    )
      throw new Error("invalid issue bundle")
    attachmentBytes += content.byteLength
    if (attachmentBytes > maximumTotalAttachmentBytes) throw new Error("invalid issue bundle")
    previousHash = attachment.sha256
    expectedPaths.push(attachment.path)
  }
  const actualPaths = await listBundleFiles(root)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths.sort())) throw new Error("invalid issue bundle")
  return value as unknown as IssueBundle
}

export function parseAutomationResult(source: string) {
  if (!source.endsWith("\n") || source.slice(0, -1).includes("\n")) throw new Error("invalid automation result")
  const value = parseJson(source)
  if (
    !exactKeys(value, [
      "status",
      "sessionID",
      ...(exactKeys(value, ["status", "sessionID", "text"]) ? ["text"] : ["error"]),
    ])
  )
    throw new Error("invalid automation result")
  const canonical = JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
  if (source !== `${canonical}\n`) throw new Error("invalid automation result")
  if (value.status === "ok" && typeof value.sessionID === "string" && /^ses_[A-Za-z0-9]+$/.test(value.sessionID)) {
    if (typeof value.text !== "string") throw new Error("invalid automation result")
    ensureText(value.text)
    return { status: "ok" as const, text: value.text }
  }
  if (
    value.status === "error" &&
    (value.sessionID === null || (typeof value.sessionID === "string" && /^ses_[A-Za-z0-9]+$/.test(value.sessionID))) &&
    typeof value.error === "string" &&
    resultErrors.has(value.error)
  )
    throw new AutomationExecutionError(
      value.error === "permission_denied"
        ? "permission_denied"
        : value.error === "tool_error"
          ? "tool_failed"
          : "model_failed",
    )
  throw new Error("invalid automation result")
}

async function runOc2(
  oc2: string,
  args: ReadonlyArray<string>,
  cwd: string,
  stateDir: string,
  name: string,
  timeoutMs: number,
) {
  const stdoutPath = join(stateDir, `${name}.stdout`)
  const stderrPath = join(stateDir, `${name}.stderr`)
  const stdout = await open(stdoutPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  const stderr = await open(stderrPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  const env = {
    CI: "1",
    FORCE_COLOR: "0",
    HOME: join(stateDir, "home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    OC2_DISABLE_AUTOUPDATE: "1",
    OC2_DISABLE_EXTERNAL_SKILLS: "1",
    OC2_DISABLE_MODELS_FETCH: "1",
    OC2_DISABLE_SHARE: "1",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: join(stateDir, "tmp"),
    XDG_CACHE_HOME: join(stateDir, "xdg-cache"),
    XDG_CONFIG_HOME: join(stateDir, "xdg-config"),
    XDG_DATA_HOME: join(stateDir, "xdg-data"),
    XDG_STATE_HOME: join(stateDir, "xdg-state"),
  }
  if (!env.OPENAI_API_KEY) throw new Error("missing provider credential")
  const child = Bun.spawn([oc2, ...args], { cwd, env, stdin: "ignore", stdout: stdout.fd, stderr: stderr.fd })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  const exitCode = await child.exited
  clearTimeout(timer)
  await Promise.all([stdout.close(), stderr.close()])
  if (timedOut || exitCode !== 0) throw new Error("automation execution failed")
  return parseAutomationResult(await readRegularUtf8(stdoutPath, maximumResultBytes))
}

export async function runGeneration(input: {
  admission: Admission
  bundleDir: string
  checkout: string
  oc2: string
  stateDir: string
  phaseFile: string
}) {
  const phaseParent = await realpath(dirname(input.phaseFile))
  const phaseFile = join(phaseParent, basename(input.phaseFile))
  const checkout = await realpath(input.checkout)
  const stateDir = await realpath(input.stateDir)
  const bundleDir = await realpath(input.bundleDir)
  const stateLocation = relative(checkout, stateDir)
  if ((stateLocation !== ".." && !stateLocation.startsWith(`..${sep}`)) || isAbsolute(stateLocation))
    throw new Error("generation state must be outside checkout")
  const bundle = await validateIssueBundle(bundleDir, input.admission, checkout)
  if (!isAbsolute(input.oc2) || !(await lstat(input.oc2)).isFile()) throw new Error("invalid OC2 executable")
  const files = [
    join(bundleDir, "issue.json"),
    ...bundle.attachments.map((attachment) => join(bundleDir, attachment.path)),
  ]
  const fileArgs = files.flatMap((path) => ["--file", path])
  const common = [
    "run",
    "--automation",
    "--pure",
    "--dir",
    checkout,
    "--model",
    "openai/gpt-5.6-sol",
    "--format",
    "result-json",
  ]
  try {
    if (input.admission.issue.label === "task") {
      await runOc2(
        input.oc2,
        [
          ...common,
          "--agent",
          "issue-task",
          "--variant",
          "high",
          ...fileArgs,
          "--",
          "Implement the admitted task from the attached issue snapshot.",
        ],
        checkout,
        stateDir,
        "task",
        105 * 60_000,
      )
      await writeFile(phaseFile, "generated\n", { encoding: "utf8" })
      return
    }
    const plan = await runOc2(
      input.oc2,
      [
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
      ],
      checkout,
      stateDir,
      "planner",
      20 * 60_000,
    )
    const planBytes = Buffer.byteLength(plan.text)
    if (
      planBytes < 1 ||
      planBytes > maximumPlanBytes ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plan.text)
    )
      throw new Error("invalid feature plan")
    const specs = await realpath(join(checkout, "specs"))
    if (!specs.startsWith(`${checkout}${sep}`) || !(await lstat(specs)).isDirectory())
      throw new Error("invalid specs directory")
    const planName = `issue-${input.admission.issue.number}.md`
    const planFile = await open(
      join(specs, planName),
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    )
    await planFile.writeFile(plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`).finally(() => planFile.close())
    await runOc2(
      input.oc2,
      [
        ...common,
        "--agent",
        "issue-implementer",
        "--variant",
        "xhigh",
        "--command",
        "spec:implement",
        "--",
        `specs/${planName}`,
        "1",
      ],
      checkout,
      stateDir,
      "implementer",
      85 * 60_000,
    )
    await writeFile(phaseFile, "generated\n", { encoding: "utf8" })
  } catch (error) {
    await writeFile(phaseFile, `${error instanceof AutomationExecutionError ? error.phase : "model_failed"}\n`, {
      encoding: "utf8",
    })
    throw error
  }
}

function gitEnvironment(home: string, indexFile?: string) {
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
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  }
}

async function git(cwd: string, home: string, args: ReadonlyArray<string>, indexFile?: string) {
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
    { cwd, env: gitEnvironment(home, indexFile), stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  )
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()])
  if (exitCode !== 0 || stdout.byteLength > 8 * 1024 * 1024) throw new Error("generation command failed")
  return new Uint8Array(stdout)
}

function nulPaths(output: Uint8Array) {
  if (output.byteLength === 0) return []
  if (output.at(-1) !== 0) throw new Error("invalid Git output")
  const paths = decoder.decode(output).split("\0")
  paths.pop()
  if (paths.some((path) => !path)) throw new Error("invalid Git output")
  return paths
}

export async function finalizeGeneration(input: {
  admission: Admission
  checkout: string
  cliVersion: string
  outputDir: string
  stateDir: string
  githubOutput: string
}) {
  if (!semverPattern.test(input.cliVersion)) throw new Error("invalid OC2 version")
  const cwd = await realpath(input.checkout)
  const stateDir = await realpath(input.stateDir)
  const stateLocation = relative(cwd, stateDir)
  const outputLocation = relative(cwd, resolve(input.outputDir))
  if (
    (stateLocation !== ".." && !stateLocation.startsWith(`..${sep}`)) ||
    isAbsolute(stateLocation) ||
    (outputLocation !== ".." && !outputLocation.startsWith(`..${sep}`)) ||
    isAbsolute(outputLocation)
  )
    throw new Error("generation state must be outside checkout")
  const head = decoder.decode(await git(cwd, stateDir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  if (head !== input.admission.repository.baseSha) throw new Error("checkout is not the admitted base")
  if ((await git(cwd, stateDir, ["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--"])).byteLength)
    throw new Error("model staged changes")
  const tracked = nulPaths(
    await git(cwd, stateDir, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--"]),
  )
  const untracked = nulPaths(await git(cwd, stateDir, ["ls-files", "--others", "--exclude-standard", "-z", "--"]))
  if ((await git(cwd, stateDir, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--"])).byteLength)
    throw new Error("checkout contains ignored model state")
  const paths = validateChangedPaths([...new Set([...tracked, ...untracked])])
  const planPath = `specs/issue-${input.admission.issue.number}.md`
  if (paths.length === 0 || (input.admission.issue.label === "feature" && paths.every((path) => path === planPath))) {
    await appendOutputs(input.githubOutput, { state: "no_changes", execute: "false" })
    return
  }
  if (paths.length > maximumChangedFiles) throw new Error("patch exceeds file limit")
  for (const path of paths) {
    const filePath = join(cwd, path)
    const location = relative(cwd, resolve(filePath))
    if (location.startsWith(`..${sep}`) || isAbsolute(location)) throw new Error("invalid changed path")
    const metadata = await lstat(filePath).catch(() => undefined)
    if (metadata && !metadata.isFile()) throw new Error("patch contains unsupported file type")
  }
  const indexFile = join(stateDir, "generation.index")
  await git(cwd, stateDir, ["read-tree", "HEAD"], indexFile)
  if (untracked.length) await git(cwd, stateDir, ["add", "--intent-to-add", "--", ...untracked], indexFile)
  await mkdir(input.outputDir, { mode: 0o700 })
  const patchPath = join(input.outputDir, "changes.patch")
  const patch = await git(
    cwd,
    stateDir,
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--"],
    indexFile,
  )
  if (patch.byteLength < 1 || patch.byteLength > maximumPatchBytes) throw new Error("patch exceeds byte limit")
  const patchFile = await open(patchPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  await patchFile.writeFile(patch).finally(() => patchFile.close())
  const generation = {
    version: 1,
    repository: { id: input.admission.repository.id, nameWithOwner: input.admission.repository.nameWithOwner },
    issue: {
      number: input.admission.issue.number,
      label: input.admission.issue.label,
      labelEventNodeId: input.admission.issue.labelEventNodeId,
    },
    baseSha: input.admission.repository.baseSha,
    cliVersion: input.cliVersion,
    model: "openai/gpt-5.6-sol",
    variant: input.admission.issue.label === "task" ? "high" : "xhigh",
    patch: {
      sha256: createHash("sha256").update(patch).digest("hex"),
      fileCount: paths.length,
      byteCount: patch.byteLength,
    },
  }
  const generationPath = join(input.outputDir, "generation.json")
  const manifest = await open(generationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  await manifest.writeFile(`${JSON.stringify(generation)}\n`).finally(() => manifest.close())
  await appendOutputs(input.githubOutput, { state: "generated", execute: "true" })
}

function options(argv: ReadonlyArray<string>, allowed: ReadonlyArray<string>) {
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !allowed.includes(name) || values.has(name)) throw new Error("invalid workflow arguments")
    values.set(name, value)
  }
  if (values.size !== allowed.length) throw new Error("missing workflow arguments")
  return Object.fromEntries(allowed.map((name) => [name.slice(2).replaceAll("-", "_"), values.get(name)!]))
}

function expected(values: Record<string, string>) {
  if (
    !repositoryPattern.test(values.repository!) ||
    !/^[1-9]\d*$/.test(values.repository_id!) ||
    !Number.isSafeInteger(Number(values.repository_id)) ||
    !shaPattern.test(values.base_sha!) ||
    !sha256Pattern.test(values.key!)
  )
    throw new Error("invalid expected identity")
  return {
    repository: values.repository!,
    repositoryId: Number(values.repository_id),
    baseSha: values.base_sha!,
    key: values.key!,
  }
}

export function validateReleaseConfig(version: string, installerSha256: string, assetSha256: string) {
  if (!semverPattern.test(version) || !sha256Pattern.test(installerSha256) || !sha256Pattern.test(assetSha256))
    throw new Error("invalid release configuration")
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)) {
  if (argv[0] === "config") {
    const values = options(argv, ["--version", "--installer-sha256", "--asset-sha256"])
    validateReleaseConfig(values.version!, values.installer_sha256!, values.asset_sha256!)
    return
  }
  if (argv[0] === "admission") {
    const values = options(argv, ["--admission", "--event-file", "--repository", "--repository-id", "--github-output"])
    if (!repositoryPattern.test(values.repository!) || !/^[1-9]\d*$/.test(values.repository_id!))
      throw new Error("invalid expected identity")
    const repositoryId = positiveInteger(Number(values.repository_id))
    const admission = decodeAdmission(await readRegularUtf8(values.admission!, maximumAdmissionBytes))
    await validateAdmissionEvent(admission, values.event_file!, values.repository!, repositoryId)
    await appendOutputs(
      values.github_output!,
      admission.status === "admitted"
        ? { state: "running", execute: "true", key: admission.key, base_sha: admission.repository.baseSha }
        : {
            state: admission.phase,
            execute: "false",
            ...(admission.status === "duplicate" ? { key: admission.key } : {}),
          },
    )
    return
  }
  if (argv[0] === "validate-admission") {
    const values = options(argv, [
      "--admission",
      "--event-file",
      "--repository",
      "--repository-id",
      "--base-sha",
      "--key",
    ])
    const identity = expected(values)
    const admission = admitted(decodeAdmission(await readRegularUtf8(values.admission!, maximumAdmissionBytes)))
    validateExpectedAdmission(admission, identity)
    await validateAdmissionEvent(admission, values.event_file!, identity.repository, identity.repositoryId)
    return
  }
  if (argv[0] === "ingest") {
    const values = options(argv, [
      "--admission",
      "--bundle-dir",
      "--result",
      "--repository",
      "--repository-id",
      "--base-sha",
      "--key",
      "--checkout",
      "--github-output",
    ])
    const identity = expected(values)
    const admission = admitted(decodeAdmission(await readRegularUtf8(values.admission!, maximumAdmissionBytes)))
    validateExpectedAdmission(admission, identity)
    const result = parseJson(await readRegularUtf8(values.result!, 1024))
    if (exactKeys(result, ["version", "status", "phase"]) && result.version === 1 && result.status === "stopped") {
      if (result.phase !== "input_too_large" && result.phase !== "attachment_rejected")
        throw new Error("invalid ingest result")
      await appendOutputs(values.github_output!, { state: result.phase, execute: "false" })
      return
    }
    if (
      !exactKeys(result, ["version", "status", "issuePath", "attachmentCount", "attachmentBytes"]) ||
      result.version !== 1 ||
      result.status !== "ok" ||
      result.issuePath !== "issue.json" ||
      typeof result.attachmentCount !== "number" ||
      !Number.isSafeInteger(result.attachmentCount) ||
      result.attachmentCount < 0 ||
      result.attachmentCount > maximumAttachments ||
      typeof result.attachmentBytes !== "number" ||
      !Number.isSafeInteger(result.attachmentBytes) ||
      result.attachmentBytes < 0 ||
      result.attachmentBytes > maximumTotalAttachmentBytes
    )
      throw new Error("invalid ingest result")
    const bundle = await validateIssueBundle(values.bundle_dir!, admission, values.checkout!)
    if (
      bundle.attachments.length !== result.attachmentCount ||
      bundle.attachments.reduce((total, attachment) => total + attachment.size, 0) !== result.attachmentBytes
    )
      throw new Error("ingest result mismatch")
    await appendOutputs(values.github_output!, { state: "running", execute: "true" })
    return
  }
  if (argv[0] === "validate-input") {
    const values = options(argv, [
      "--admission",
      "--bundle-dir",
      "--repository",
      "--repository-id",
      "--base-sha",
      "--key",
      "--checkout",
    ])
    const identity = expected(values)
    const admission = admitted(decodeAdmission(await readRegularUtf8(values.admission!, maximumAdmissionBytes)))
    validateExpectedAdmission(admission, identity)
    await validateIssueBundle(values.bundle_dir!, admission, values.checkout!)
    return
  }
  if (argv[0] === "run") {
    const values = options(argv, ["--admission", "--bundle-dir", "--checkout", "--oc2", "--state-dir", "--phase-file"])
    await runGeneration({
      admission: admitted(decodeAdmission(await readRegularUtf8(values.admission!, maximumAdmissionBytes))),
      bundleDir: values.bundle_dir!,
      checkout: values.checkout!,
      oc2: values.oc2!,
      stateDir: values.state_dir!,
      phaseFile: values.phase_file!,
    })
    return
  }
  if (argv[0] === "finalize") {
    const values = options(argv, [
      "--admission",
      "--checkout",
      "--cli-version",
      "--output-dir",
      "--state-dir",
      "--github-output",
    ])
    await finalizeGeneration({
      admission: admitted(decodeAdmission(await readRegularUtf8(values.admission!, maximumAdmissionBytes))),
      checkout: values.checkout!,
      cliVersion: values.cli_version!,
      outputDir: values.output_dir!,
      stateDir: values.state_dir!,
      githubOutput: values.github_output!,
    })
    return
  }
  throw new Error("invalid workflow command")
}

if (import.meta.main) {
  await main().catch(() => {
    process.stderr.write("automation_workflow_failed\n")
    process.exitCode = 1
  })
}
