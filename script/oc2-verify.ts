#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { validateChangedPaths, validateRepositoryPathSet } from "./oc2-automation-policy"

export const maximumPatchBytes = 2 * 1024 * 1024
export const maximumChangedFiles = 100
export const maximumChangedLines = 50_000

const maximumManifestBytes = 64 * 1024
const maximumCommandOutputBytes = 8 * 1024 * 1024
const maximumCandidateBlobBytes = 20 * 1024 * 1024
const maximumCandidateTreeBytes = 100 * 1024 * 1024
const shaPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const imagePattern = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[0-9a-f]{64}$/
const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

interface GenerationManifest {
  version: 1
  repository: { id: number; nameWithOwner: string }
  issue: { number: number; label: "task" | "feature"; labelEventNodeId: string }
  baseSha: string
  cliVersion: string
  model: "openai/gpt-5.6-sol"
  variant: "high" | "xhigh"
  patch: { sha256: string; fileCount: number; byteCount: number }
}
const sandboxEnvironment = [
  "CI=1",
  "HOME=/home/oc2",
  "TMPDIR=/tmp",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NO_COLOR=1",
  "FORCE_COLOR=0",
  "GIT_OPTIONAL_LOCKS=0",
  "OC2_DISABLE_SHARE=1",
  "OC2_DISABLE_EXTERNAL_SKILLS=1",
  "CHOKIDAR_USEPOLLING=0",
  "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
  "TURBO_CACHE_DIR=/tmp/turbo-cache",
  "PATH=/usr/local/bin:/usr/bin:/bin",
] as const
const sandboxEnvironmentNames = new Set(sandboxEnvironment.map((entry) => entry.slice(0, entry.indexOf("="))))

export interface ValidationInput {
  generationPath: string
  patchPath: string
  repository: string
  repositoryId: number
  baseSha: string
  cwd?: string
}

export interface VerificationInput extends ValidationInput {
  image: string
  outputPath: string
}

export interface ValidatedPatch {
  manifest: GenerationManifest
  patchBytes: Uint8Array
  paths: string[]
  treeSha: string
}

interface CommandResult {
  exitCode: number
  stdout: Uint8Array
}

export type SandboxCommandRunner = (argv: ReadonlyArray<string>, timeoutMs: number) => Promise<CommandResult>

function hasExactKeys(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function isPositiveInt(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string")
}

function decodeGenerationManifest(source: string): GenerationManifest {
  const value: unknown = JSON.parse(source)
  if (
    !hasExactKeys(value, ["version", "repository", "issue", "baseSha", "cliVersion", "model", "variant", "patch"]) ||
    !hasExactKeys(value.repository, ["id", "nameWithOwner"]) ||
    !hasExactKeys(value.issue, ["number", "label", "labelEventNodeId"]) ||
    !hasExactKeys(value.patch, ["sha256", "fileCount", "byteCount"]) ||
    value.version !== 1 ||
    !isPositiveInt(value.repository.id) ||
    typeof value.repository.nameWithOwner !== "string" ||
    !repositoryPattern.test(value.repository.nameWithOwner) ||
    !isPositiveInt(value.issue.number) ||
    (value.issue.label !== "task" && value.issue.label !== "feature") ||
    typeof value.issue.labelEventNodeId !== "string" ||
    value.issue.labelEventNodeId.length < 1 ||
    value.issue.labelEventNodeId.length > 256 ||
    /[\p{Cc}\p{Cf}]/u.test(value.issue.labelEventNodeId) ||
    typeof value.baseSha !== "string" ||
    !shaPattern.test(value.baseSha) ||
    typeof value.cliVersion !== "string" ||
    value.cliVersion.length > 128 ||
    !semverPattern.test(value.cliVersion) ||
    value.model !== "openai/gpt-5.6-sol" ||
    (value.variant !== "high" && value.variant !== "xhigh") ||
    typeof value.patch.sha256 !== "string" ||
    !sha256Pattern.test(value.patch.sha256) ||
    !isPositiveInt(value.patch.fileCount, maximumChangedFiles) ||
    !isPositiveInt(value.patch.byteCount, maximumPatchBytes)
  )
    throw new Error("invalid generation manifest")
  return {
    version: 1,
    repository: { id: value.repository.id, nameWithOwner: value.repository.nameWithOwner },
    issue: {
      number: value.issue.number,
      label: value.issue.label,
      labelEventNodeId: value.issue.labelEventNodeId,
    },
    baseSha: value.baseSha,
    cliVersion: value.cliVersion,
    model: "openai/gpt-5.6-sol",
    variant: value.variant,
    patch: {
      sha256: value.patch.sha256,
      fileCount: value.patch.fileCount,
      byteCount: value.patch.byteCount,
    },
  }
}

function decodeDockerImageMetadata(source: string) {
  const value: unknown = JSON.parse(source)
  if (
    !hasExactKeys(value, ["id", "env", "volumes"]) ||
    typeof value.id !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.id) ||
    !isStringArray(value.env) ||
    value.volumes !== null
  )
    throw new Error("invalid verification image metadata")
  return { id: value.id, env: value.env }
}

async function readRegularFile(path: string, maximumBytes: number) {
  const before = await lstat(path)
  if (!before.isFile() || before.size < 1 || before.size > maximumBytes) throw new Error("invalid verification input")
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (
      !current.isFile() ||
      current.size !== before.size ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size > maximumBytes
    )
      throw new Error("invalid verification input")
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.byteLength !== current.size) throw new Error("invalid verification input")
    return bytes
  } finally {
    await handle.close()
  }
}

async function runCommand(
  argv: ReadonlyArray<string>,
  options: {
    cwd: string
    env?: Readonly<Record<string, string>>
    input?: Uint8Array
    timeoutMs?: number
  },
) {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env ?? {},
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, options.timeoutMs ?? 60_000)
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()])
  clearTimeout(timer)
  if (timedOut || output.byteLength > maximumCommandOutputBytes) throw new Error("verification command failed")
  return { exitCode, stdout: new Uint8Array(output) }
}

function gitEnvironment(
  home: string,
  options: { indexPath?: string; objectDirectory?: string; alternateObjectDirectory?: string } = {},
) {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    XDG_CONFIG_HOME: join(home, "xdg"),
    ...(options.indexPath ? { GIT_INDEX_FILE: options.indexPath } : {}),
    ...(options.objectDirectory ? { GIT_OBJECT_DIRECTORY: options.objectDirectory } : {}),
    ...(options.alternateObjectDirectory ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: options.alternateObjectDirectory } : {}),
  }
}

async function git(
  cwd: string,
  home: string,
  args: ReadonlyArray<string>,
  options: {
    indexPath?: string
    input?: Uint8Array
    objectDirectory?: string
    alternateObjectDirectory?: string
    resourceLimits?: boolean
  } = {},
) {
  const executable =
    options.resourceLimits && process.platform === "linux"
      ? ["/usr/bin/prlimit", "--as=1073741824", "--fsize=134217728", "--cpu=60", "--nofile=4096", "--", "git"]
      : ["git"]
  const result = await runCommand(
    [
      ...executable,
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
      env: gitEnvironment(home, options),
      input: options.input,
    },
  )
  if (result.exitCode !== 0) throw new Error("patch rejected")
  return result.stdout
}

function decodeGitPath(bytes: Uint8Array) {
  return decoder.decode(bytes)
}

function parseNumstat(output: Uint8Array) {
  const records = splitNul(output)
  const paths: string[] = []
  let changedLines = 0
  for (let index = 0; index < records.length; index++) {
    const record = decodeGitPath(records[index]!)
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab < 1 || secondTab < firstTab + 2) throw new Error("patch rejected")
    const added = record.slice(0, firstTab)
    const deleted = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    if (!path) throw new Error("rename and copy patches are not allowed")
    if (added === "-" || deleted === "-") {
      if (added !== "-" || deleted !== "-") throw new Error("patch rejected")
    } else {
      if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) throw new Error("patch rejected")
      changedLines += Number(added) + Number(deleted)
      if (!Number.isSafeInteger(changedLines) || changedLines > maximumChangedLines)
        throw new Error("patch exceeds changed line limit")
    }
    paths.push(path)
  }
  if (paths.length < 1 || paths.length > maximumChangedFiles) throw new Error("patch exceeds file limit")
  return validateChangedPaths(paths)
}

function splitNul(output: Uint8Array) {
  if (output.length === 0 || output[output.length - 1] !== 0) throw new Error("invalid Git output")
  const records: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue
    records.push(output.subarray(start, index))
    start = index + 1
  }
  if (records.some((record) => record.length === 0)) throw new Error("invalid Git output")
  return records
}

function parseRawTree(output: Uint8Array) {
  const records = splitNul(output)
  if (records.length % 2 !== 0) throw new Error("invalid candidate tree")
  const paths: string[] = []
  const blobs: string[] = []
  for (let index = 0; index < records.length; index += 2) {
    const metadata = decoder.decode(records[index])
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADM])$/.exec(metadata)
    if (!match) throw new Error("patch contains an unsupported change")
    const oldMode = match[1]!
    const newMode = match[2]!
    const status = match[5]!
    if (status === "A" && (oldMode !== "000000" || !isRegularMode(newMode)))
      throw new Error("patch contains an unsupported file mode")
    if (status === "D" && (!isRegularMode(oldMode) || newMode !== "000000"))
      throw new Error("patch contains an unsupported file mode")
    if (status === "M" && (!isRegularMode(oldMode) || !isRegularMode(newMode)))
      throw new Error("patch contains an unsupported file mode")
    if (status !== "D") blobs.push(match[4]!)
    paths.push(decodeGitPath(records[index + 1]!))
  }
  return { paths: validateChangedPaths(paths), blobs }
}

function rejectRenameCopyTree(output: Uint8Array) {
  const records = splitNul(output)
  for (let index = 0; index < records.length; ) {
    const metadata = decoder.decode(records[index++])
    const match = /^:\d{6} \d{6} [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\d*$/.exec(metadata)
    if (!match) throw new Error("invalid candidate tree")
    if (match[1] === "R" || match[1] === "C") throw new Error("rename and copy patches are not allowed")
    index++
    if (index > records.length) throw new Error("invalid candidate tree")
  }
}

function isRegularMode(mode: string) {
  return mode === "100644" || mode === "100755"
}

function exactPathSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return (
    left.length === right.length && new Set(left).size === left.length && left.every((path) => right.includes(path))
  )
}

async function validateCandidateBlobs(
  cwd: string,
  home: string,
  blobs: ReadonlyArray<string>,
  objectDirectory: string,
  alternateObjectDirectory: string,
) {
  const unique = [...new Set(blobs)]
  if (unique.length === 0) return
  const output = decoder
    .decode(
      await git(cwd, home, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
        objectDirectory,
        alternateObjectDirectory,
        input: encoder.encode(`${unique.join("\n")}\n`),
      }),
    )
    .trim()
    .split("\n")
  if (output.length !== unique.length) throw new Error("invalid candidate objects")
  let total = 0
  for (const line of output) {
    const match = /^([0-9a-f]{40}) blob ([1-9]\d*|0)$/.exec(line)
    if (!match || !unique.includes(match[1]!)) throw new Error("invalid candidate objects")
    const size = Number(match[2])
    total += size
    if (!Number.isSafeInteger(size) || size > maximumCandidateBlobBytes || total > maximumCandidateTreeBytes)
      throw new Error("candidate objects exceed size limit")
  }
}

export async function validatePatch(input: ValidationInput): Promise<ValidatedPatch> {
  if (!isAbsolute(input.generationPath) || !isAbsolute(input.patchPath))
    throw new Error("verification inputs must be absolute")
  if (!repositoryPattern.test(input.repository) || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1)
    throw new Error("invalid repository identity")
  if (!shaPattern.test(input.baseSha)) throw new Error("invalid base SHA")

  const manifestBytes = await readRegularFile(input.generationPath, maximumManifestBytes)
  const patchBytes = await readRegularFile(input.patchPath, maximumPatchBytes)
  const manifest = decodeGenerationManifest(decoder.decode(manifestBytes))
  if (
    manifest.repository.nameWithOwner !== input.repository ||
    manifest.repository.id !== input.repositoryId ||
    manifest.baseSha !== input.baseSha ||
    manifest.patch.byteCount !== patchBytes.byteLength ||
    manifest.patch.sha256 !== createHash("sha256").update(patchBytes).digest("hex") ||
    manifest.model !== "openai/gpt-5.6-sol" ||
    (manifest.issue.label === "task" ? manifest.variant !== "high" : manifest.variant !== "xhigh")
  )
    throw new Error("generation manifest mismatch")

  const cwd = resolve(input.cwd ?? process.cwd())
  const temporary = await mkdtemp(join(tmpdir(), "oc2-verify-git-"))
  try {
    const localAttributes = decoder
      .decode(await git(cwd, temporary, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]))
      .trim()
    if (await Bun.file(localAttributes).exists()) throw new Error("local Git attributes are not allowed")
    const commit = decoder
      .decode(await git(cwd, temporary, ["rev-parse", "--verify", `${input.baseSha}^{commit}`]))
      .trim()
    if (commit !== input.baseSha) throw new Error("base commit mismatch")
    const baseTree = decoder
      .decode(await git(cwd, temporary, ["rev-parse", "--verify", `${input.baseSha}^{tree}`]))
      .trim()
    const alternateObjectDirectory = await realpath(
      decoder
        .decode(await git(cwd, temporary, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]))
        .trim(),
    )
    const objectDirectory = join(temporary, "objects")
    await mkdir(objectDirectory)
    const numstatPaths = parseNumstat(
      await git(cwd, temporary, ["apply", "--numstat", "-z", "--"], { input: patchBytes }),
    )
    const indexPath = join(temporary, "candidate.index")
    const isolated = { indexPath, objectDirectory, alternateObjectDirectory }
    await git(cwd, temporary, ["read-tree", `${input.baseSha}^{tree}`], isolated)
    await git(cwd, temporary, ["apply", "--cached", "--3way", "--binary", "--whitespace=nowarn", "--"], {
      ...isolated,
      input: patchBytes,
      resourceLimits: true,
    })
    if ((await git(cwd, temporary, ["ls-files", "--unmerged", "-z"], isolated)).length !== 0)
      throw new Error("patch contains conflicts")
    const treeSha = decoder.decode(await git(cwd, temporary, ["write-tree"], isolated)).trim()
    if (!shaPattern.test(treeSha) || treeSha === baseTree) throw new Error("patch contains no changes")
    rejectRenameCopyTree(
      await git(
        cwd,
        temporary,
        [
          "diff-tree",
          "--raw",
          "-z",
          "-r",
          "--no-abbrev",
          "--find-renames=1%",
          "--find-copies=1%",
          "--find-copies-harder",
          baseTree,
          treeSha,
          "--",
        ],
        isolated,
      ),
    )
    const tree = parseRawTree(
      await git(
        cwd,
        temporary,
        ["diff-tree", "--raw", "-z", "-r", "--no-renames", "--no-abbrev", baseTree, treeSha, "--"],
        isolated,
      ),
    )
    if (!exactPathSet(numstatPaths, tree.paths) || manifest.patch.fileCount !== tree.paths.length)
      throw new Error("patch path set mismatch")
    const allTreePaths = await git(cwd, temporary, ["ls-tree", "-r", "-z", "--name-only", treeSha, "--"], isolated)
    validateRepositoryPathSet(
      allTreePaths.length === 0 ? [] : splitNul(allTreePaths).map((path) => decodeGitPath(path)),
    )
    await validateCandidateBlobs(cwd, temporary, tree.blobs, objectDirectory, alternateObjectDirectory)
    const canonicalPatch = await git(
      cwd,
      temporary,
      ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", "--no-textconv", baseTree, treeSha, "--"],
      isolated,
    )
    if (!Buffer.from(canonicalPatch).equals(Buffer.from(patchBytes))) throw new Error("patch is not canonical")
    return { manifest, patchBytes, paths: tree.paths, treeSha }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function runFrozenInstall(cwd: string, home: string) {
  const result = await runCommand([process.execPath, "install", "--frozen-lockfile"], {
    cwd,
    env: {
      CI: "1",
      HOME: home,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_CONFIG_HOME: join(home, "config"),
    },
    timeoutMs: 15 * 60_000,
  })
  if (result.exitCode !== 0) throw new Error("dependency installation failed")
}

async function productionSandboxRunner(argv: ReadonlyArray<string>, timeoutMs: number) {
  return runCommand(argv, {
    cwd: "/",
    env: {
      DOCKER_CONFIG: "/nonexistent",
      HOME: "/nonexistent",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    timeoutMs,
  })
}

export async function runVerificationSandbox(
  input: { cwd: string; gitDir: string; dependencyDir?: string; image: string },
  run: SandboxCommandRunner = productionSandboxRunner,
) {
  if (!imagePattern.test(input.image)) throw new Error("verification image must be pinned by digest")
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (!uid || !gid) throw new Error("verification sandbox must run as an unprivileged user")
  const nodeModules = input.dependencyDir ?? join(input.cwd, "node_modules")
  const sandboxEntrypoint = join(dirname(fileURLToPath(import.meta.url)), "oc2-verify-sandbox.ts")
  for (const path of [input.cwd, input.gitDir, nodeModules, sandboxEntrypoint]) {
    if (!isAbsolute(path) || /[,\p{Cc}]/u.test(path)) throw new Error("unsupported sandbox mount path")
  }
  const checkoutStat = await lstat(input.cwd)
  const gitStat = await lstat(input.gitDir)
  const dependencyStat = await lstat(nodeModules)
  const entrypointStat = await lstat(sandboxEntrypoint)
  if (
    !checkoutStat.isDirectory() ||
    !gitStat.isDirectory() ||
    !dependencyStat.isDirectory() ||
    !entrypointStat.isFile() ||
    (await realpath(input.cwd)) !== input.cwd ||
    (await realpath(input.gitDir)) !== input.gitDir ||
    (await realpath(nodeModules)) !== nodeModules ||
    (await realpath(sandboxEntrypoint)) !== sandboxEntrypoint ||
    !input.gitDir.startsWith(`${input.cwd}${sep}`)
  )
    throw new Error("invalid sandbox mount source")

  const pull = await run(["docker", "pull", input.image], 10 * 60_000)
  if (pull.exitCode !== 0) throw new Error("verification image pull failed")
  const inspect = await run(
    [
      "docker",
      "image",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"env":{{json .Config.Env}},"volumes":{{json .Config.Volumes}}}',
      input.image,
    ],
    60_000,
  )
  if (inspect.exitCode !== 0) throw new Error("verification image inspection failed")
  const metadata = decodeDockerImageMetadata(decoder.decode(inspect.stdout))
  const imageEnvironment = new Set<string>()
  for (const entry of metadata.env) {
    const separator = entry.indexOf("=")
    const name = entry.slice(0, separator)
    if (separator < 1 || !sandboxEnvironmentNames.has(name) || imageEnvironment.has(name))
      throw new Error("verification image has unsafe environment")
    imageEnvironment.add(name)
  }

  const artifactDirs: string[] = []
  for await (const manifest of new Bun.Glob("packages/**/package.json").scan({ cwd: input.cwd, onlyFiles: true })) {
    const path = join(input.cwd, dirname(manifest), ".artifacts")
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await realpath(path)) !== path || !path.startsWith(`${input.cwd}${sep}`))
      throw new Error("invalid sandbox artifact directory")
    artifactDirs.push(path)
  }
  const containerName = `oc2-verify-${randomBytes(12).toString("hex")}`
  let cleanupRequired = false
  let failure: Error | undefined
  await (async () => {
    cleanupRequired = true
    const create = await run(
      [
        "docker",
        "create",
        "--name",
        containerName,
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "1024",
        "--memory",
        "8g",
        "--memory-swap",
        "8g",
        "--cpus",
        "4",
        "--ulimit",
        "nofile=4096:4096",
        "--ulimit",
        "fsize=20971520:20971520",
        "--user",
        `${uid}:${gid}`,
        "--init",
        "--no-healthcheck",
        "--log-driver",
        "none",
        "--workdir",
        "/workspace",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=1073741824",
        "--tmpfs",
        "/home/oc2:rw,noexec,nosuid,nodev,size=67108864",
        "--tmpfs",
        "/workspace:rw,nosuid,nodev,size=2147483648",
        "--mount",
        `type=bind,src=${input.cwd},dst=/source,readonly`,
        "--mount",
        `type=bind,src=${input.gitDir},dst=/workspace/.git,readonly`,
        "--mount",
        `type=bind,src=${nodeModules},dst=/workspace/node_modules,readonly`,
        "--mount",
        `type=bind,src=${nodeModules},dst=/source/node_modules,readonly`,
        "--mount",
        `type=bind,src=${sandboxEntrypoint},dst=/opt/oc2/oc2-verify-sandbox.ts,readonly`,
        ...artifactDirs.flatMap((path) => [
          "--tmpfs",
          `/source/${relative(input.cwd, path)}:rw,noexec,nosuid,nodev,size=67108864`,
        ]),
        ...sandboxEnvironment.flatMap((entry) => ["--env", entry]),
        "--entrypoint",
        "bun",
        metadata.id,
        "/opt/oc2/oc2-verify-sandbox.ts",
      ],
      60_000,
    )
    if (create.exitCode !== 0 || !/^[0-9a-f]{64}\n?$/.test(decoder.decode(create.stdout)))
      throw new Error("verification container creation failed")
    if ((await run(["docker", "start", containerName], 60_000)).exitCode !== 0)
      throw new Error("verification container start failed")
    const wait = await run(["docker", "wait", containerName], 65 * 60_000)
    if (wait.exitCode !== 0 || decoder.decode(wait.stdout).trim() !== "0") throw new Error("verification checks failed")
  })().then(undefined, (error) => {
    failure = error instanceof Error ? error : new Error("verification container failed")
  })
  await run(["docker", "kill", containerName], 60_000).catch(() => ({ exitCode: 1, stdout: new Uint8Array() }))
  const removed = await run(["docker", "rm", "--force", "--volumes", containerName], 60_000).catch(() => ({
    exitCode: 1,
    stdout: new Uint8Array(),
  }))
  await Promise.all(artifactDirs.map((path) => rm(path, { recursive: true, force: true })))
  if (cleanupRequired && removed.exitCode !== 0) throw new Error("verification container cleanup failed")
  if (failure) throw failure
}

async function atomicWriteVerification(path: string, value: unknown) {
  const parent = await realpath(dirname(path))
  const target = join(parent, basename(path))
  const temporary = join(parent, `.oc2-verification-${randomBytes(12).toString("hex")}.tmp`)
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
  await link(temporary, target).finally(() => rm(temporary, { force: true }))
}

export async function verifyPatch(input: VerificationInput, run?: SandboxCommandRunner) {
  const cwd = await realpath(resolve(input.cwd ?? process.cwd()))
  if (!isAbsolute(input.outputPath)) throw new Error("verification output must be absolute")
  const outputParent = await realpath(dirname(input.outputPath))
  const outputPath = join(outputParent, basename(input.outputPath))
  const outputRelative = relative(cwd, outputPath)
  if ((outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`)) || isAbsolute(outputRelative))
    throw new Error("verification output must be outside the checkout")
  if (await Bun.file(outputPath).exists()) throw new Error("verification output already exists")
  if (!(await lstat(join(cwd, ".git"))).isDirectory()) throw new Error("invalid Git checkout")

  const temporary = await mkdtemp(join(tmpdir(), "oc2-verify-run-"))
  let output:
    | {
        version: 1
        repository: GenerationManifest["repository"]
        baseSha: string
        patchSha256: string
        treeSha: string
      }
    | undefined
  try {
    const topLevel = await realpath(
      decoder.decode(await git(cwd, temporary, ["rev-parse", "--path-format=absolute", "--show-toplevel"])).trim(),
    )
    if (topLevel !== cwd || (await realpath(join(cwd, ".git"))) !== join(cwd, ".git"))
      throw new Error("invalid Git checkout")
    if (await Bun.file(join(cwd, ".git", "info", "attributes")).exists()) throw new Error("invalid Git checkout")
    const head = decoder.decode(await git(cwd, temporary, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
    if (head !== input.baseSha) throw new Error("checkout is not the exact base")
    if ((await git(cwd, temporary, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length !== 0)
      throw new Error("checkout is not clean")
    if (
      (await git(cwd, temporary, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]))
        .length !== 0
    )
      throw new Error("checkout contains ignored state")
    const validated = await validatePatch({ ...input, cwd })
    await runFrozenInstall(cwd, temporary)
    if ((await git(cwd, temporary, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length !== 0)
      throw new Error("dependency installation changed the checkout")
    const dependencyDir = await realpath(join(cwd, "node_modules"))
    if (!dependencyDir.startsWith(`${cwd}${sep}`) || !(await lstat(dependencyDir)).isDirectory())
      throw new Error("invalid dependency directory")

    const candidate = join(temporary, "candidate")
    await git(cwd, temporary, ["clone", "--no-hardlinks", "--no-checkout", "--", cwd, candidate])
    const candidateRoot = await realpath(candidate)
    await git(candidateRoot, temporary, ["checkout", "--detach", input.baseSha])
    const candidateHead = decoder
      .decode(await git(candidateRoot, temporary, ["rev-parse", "--verify", "HEAD^{commit}"]))
      .trim()
    if (candidateHead !== input.baseSha) throw new Error("candidate checkout base mismatch")
    await git(candidateRoot, temporary, ["apply", "--index", "--3way", "--binary", "--whitespace=nowarn", "--"], {
      input: validated.patchBytes,
    })
    const appliedTree = decoder.decode(await git(candidateRoot, temporary, ["write-tree"])).trim()
    if (appliedTree !== validated.treeSha) throw new Error("applied tree mismatch")
    await mkdir(join(candidateRoot, "node_modules"), { recursive: true })
    const statusArguments = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]
    const beforeTests = await git(candidateRoot, temporary, statusArguments)
    const gitDir = await realpath(join(candidateRoot, ".git"))
    await runVerificationSandbox({ cwd: candidateRoot, gitDir, dependencyDir, image: input.image }, run)
    const afterTree = decoder.decode(await git(candidateRoot, temporary, ["write-tree"])).trim()
    const afterTests = await git(candidateRoot, temporary, statusArguments)
    if (afterTree !== validated.treeSha || !Buffer.from(beforeTests).equals(Buffer.from(afterTests)))
      throw new Error("verification checks changed the candidate tree")
    output = {
      version: 1 as const,
      repository: validated.manifest.repository,
      baseSha: validated.manifest.baseSha,
      patchSha256: validated.manifest.patch.sha256,
      treeSha: validated.treeSha,
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  if (!output) throw new Error("verification did not complete")
  await atomicWriteVerification(input.outputPath, output)
  return output
}

function parseArguments(argv: ReadonlyArray<string>) {
  const command = argv[0]
  if (command !== "validate" && command !== "verify") throw new Error("invalid verifier command")
  const values = new Map<string, string>()
  const allowed = new Set([
    "--generation",
    "--patch",
    "--repository",
    "--repository-id",
    "--base-sha",
    ...(command === "verify" ? ["--image", "--output"] : []),
  ])
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !value || !allowed.has(key) || values.has(key)) throw new Error("invalid verifier arguments")
    values.set(key, value)
  }
  if (values.size !== allowed.size) throw new Error("missing verifier arguments")
  const repositoryId = values.get("--repository-id")!
  if (!/^[1-9]\d*$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId)))
    throw new Error("invalid repository ID")
  const common = {
    generationPath: values.get("--generation")!,
    patchPath: values.get("--patch")!,
    repository: values.get("--repository")!,
    repositoryId: Number(repositoryId),
    baseSha: values.get("--base-sha")!,
  }
  return command === "validate"
    ? { command: "validate" as const, input: common }
    : {
        command: "verify" as const,
        input: { ...common, image: values.get("--image")!, outputPath: values.get("--output")! },
      }
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)) {
  const parsed = parseArguments(argv)
  if (parsed.command === "validate") await validatePatch(parsed.input)
  else await verifyPatch(parsed.input)
}

if (import.meta.main) {
  await main().catch(() => {
    process.stderr.write("verification_failed\n")
    process.exitCode = 1
  })
}
