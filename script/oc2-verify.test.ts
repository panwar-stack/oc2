import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isProtectedAutomationPath,
  normalizeRepositoryPath,
  validateChangedPaths,
  validateRepositoryPathSet,
} from "./oc2-automation-policy"
import {
  assertSourceReadOnly,
  materializeSandboxWorkspace,
  runSandboxChecks,
  sandboxChecks,
  type SandboxChild,
  type SandboxSpawn,
} from "./oc2-verify-sandbox"
import {
  maximumChangedFiles,
  maximumChangedLines,
  maximumPatchBytes,
  runVerificationSandbox,
  validatePatch,
  verifyPatch,
  type SandboxCommandRunner,
} from "./oc2-verify"

const roots: string[] = []
const repository = "panwar-stack/oc2"
const repositoryId = 123
const image = `ghcr.io/panwar-stack/oc2-verify@sha256:${"a".repeat(64)}`
const sourcePath = "packages/app/src/source.txt"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function command(cwd: string, args: string[], input?: Uint8Array) {
  const child = Bun.spawn(args, {
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr)
  return new Uint8Array(stdout)
}

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => "",
    (error) => (error instanceof Error ? error.message : String(error)),
  )
}

interface RepositoryFixture {
  root: string
  checkout: string
  artifacts: string
  baseSha: string
}

async function repositoryFixture(files: Readonly<Record<string, string | Uint8Array>> = { [sourcePath]: "base\n" }) {
  const root = await mkdtemp(join(tmpdir(), "oc2-verify-test-"))
  roots.push(root)
  const checkout = join(root, "checkout")
  const artifacts = join(root, "artifacts")
  await mkdir(checkout)
  await mkdir(artifacts)
  await command(checkout, ["git", "init", "--quiet"])
  await command(checkout, ["git", "config", "user.email", "automation@example.test"])
  await command(checkout, ["git", "config", "user.name", "Automation Test"])
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(checkout, path, ".."), { recursive: true })
    await writeFile(join(checkout, path), contents)
  }
  await command(checkout, ["git", "add", "--all"])
  await command(checkout, ["git", "commit", "--quiet", "-m", "base"])
  const baseSha = new TextDecoder().decode(await command(checkout, ["git", "rev-parse", "HEAD"])).trim()
  return { root, checkout, artifacts, baseSha } satisfies RepositoryFixture
}

async function stagedPatch(fixture: RepositoryFixture) {
  await command(fixture.checkout, ["git", "add", "--all"])
  return indexedPatch(fixture)
}

async function indexedPatch(fixture: RepositoryFixture) {
  return command(fixture.checkout, [
    "git",
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-renames",
    "--no-textconv",
  ])
}

async function updateBase(fixture: RepositoryFixture, message: string) {
  await command(fixture.checkout, ["git", "add", "--all"])
  await command(fixture.checkout, ["git", "commit", "--quiet", "--allow-empty", "-m", message])
  fixture.baseSha = new TextDecoder().decode(await command(fixture.checkout, ["git", "rev-parse", "HEAD"])).trim()
}

function generation(fixture: RepositoryFixture, patch: Uint8Array, fileCount: number) {
  return {
    version: 1,
    repository: { id: repositoryId, nameWithOwner: repository },
    issue: { number: 42, label: "task", labelEventNodeId: "LE_test" },
    baseSha: fixture.baseSha,
    cliVersion: "1.2.3",
    model: "openai/gpt-5.6-sol",
    variant: "high",
    patch: {
      sha256: createHash("sha256").update(patch).digest("hex"),
      fileCount,
      byteCount: patch.byteLength,
    },
  }
}

async function validate(
  fixture: RepositoryFixture,
  patch: Uint8Array,
  fileCount: number,
  transform: (value: ReturnType<typeof generation>) => unknown = (value) => value,
) {
  const patchPath = join(fixture.artifacts, "changes.patch")
  const generationPath = join(fixture.artifacts, "generation.json")
  await writeFile(patchPath, patch)
  await writeFile(generationPath, JSON.stringify(transform(generation(fixture, patch, fileCount))))
  return validatePatch({
    generationPath,
    patchPath,
    repository,
    repositoryId,
    baseSha: fixture.baseSha,
    cwd: fixture.checkout,
  })
}

async function verificationFixture() {
  const fixture = await repositoryFixture({
    ".gitignore": "node_modules/\n",
    "package.json": '{"name":"verify-fixture","private":true,"scripts":{}}\n',
    [sourcePath]: "base\n",
  })
  await command(fixture.checkout, [process.execPath, "install", "--lockfile-only"])
  await rm(join(fixture.checkout, "node_modules"), { recursive: true, force: true })
  await updateBase(fixture, "lock dependencies")
  await writeFile(join(fixture.checkout, sourcePath), "candidate\n")
  const patch = await stagedPatch(fixture)
  const patchPath = join(fixture.artifacts, "changes.patch")
  const generationPath = join(fixture.artifacts, "generation.json")
  await writeFile(patchPath, patch)
  await writeFile(generationPath, JSON.stringify(generation(fixture, patch, 1)))
  await writeFile(join(fixture.checkout, sourcePath), "base\n")
  await command(fixture.checkout, ["git", "add", sourcePath])
  return {
    fixture,
    input: {
      generationPath,
      patchPath,
      repository,
      repositoryId,
      baseSha: fixture.baseSha,
      cwd: fixture.checkout,
      image,
      outputPath: join(fixture.root, "verification.json"),
    },
  }
}

function successfulDocker(commands: Array<{ argv: string[]; timeoutMs: number }>): SandboxCommandRunner {
  return async (readonlyArgv, timeoutMs) => {
    const argv = [...readonlyArgv]
    commands.push({ argv, timeoutMs })
    if (argv[1] === "image")
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode(JSON.stringify({ id: `sha256:${"b".repeat(64)}`, env: [], volumes: null })),
      }
    if (argv[1] === "create") return { exitCode: 0, stdout: new TextEncoder().encode(`${"c".repeat(64)}\n`) }
    if (argv[1] === "wait") return { exitCode: 0, stdout: new TextEncoder().encode("0\n") }
    return { exitCode: 0, stdout: new Uint8Array() }
  }
}

async function sandboxFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oc2-sandbox-test-")))
  roots.push(root)
  const checkout = join(root, "checkout")
  const gitDir = join(checkout, ".git")
  const dependencyDir = join(root, "dependencies")
  await mkdir(gitDir, { recursive: true })
  await mkdir(dependencyDir)
  await mkdir(join(checkout, "packages/app"), { recursive: true })
  await writeFile(join(checkout, "packages/app/package.json"), '{"name":"app"}\n')
  return { cwd: checkout, gitDir, dependencyDir }
}

describe("canonical automation path policy", () => {
  test("rejects traversal, absolute, backslash, control, and non-NFC paths", () => {
    for (const path of ["../escape", "/absolute", "C:/drive", "a\\b", "a\u0001b", "caf\u0065\u0301.ts"])
      expect(() => normalizeRepositoryPath(path)).toThrow("invalid repository path")
  })

  test("protects policy paths case-insensitively at any depth", () => {
    for (const path of [
      "nested/.Git/config",
      "nested/.ENV.production",
      "nested/.GitHub/workflows/pwn.yml",
      "nested/.ＧitHub/workflows/pwn.yml",
      "nested/.OC2/agents/pwn.md",
      "nested/AGENTS.md",
      "nested/Package.JSON",
      "nested/tsconfig.build.json",
      "script/OC2-VERIFY-extra.ts",
      "script/oc2-issue-new.ts",
      "script/oc2-automation-new.ts",
      "script/oc2-automation-policy.ts",
      "script/oc2-publish.ts",
      "script/ci-scope.ts",
      "script/check-generated.ts",
      "script/package-boundaries.ts",
      "script/package-boundary-baseline.jsonc",
      "packages/opencode/script/docs-check.ts",
      "docs/issue-automation.md",
      "specs/secure-issue-driven-oc2-automation.md",
    ])
      expect(isProtectedAutomationPath(path)).toBeTrue()
  })

  test("allows ordinary normalized checkout paths by default", () => {
    for (const path of [
      "src/ordinary.ts",
      "packages/opencode/src/ordinary.ts",
      "packages/core/src/ordinary.ts",
      "packages/opencode/test/ordinary.test.ts",
      "script/ordinary.ts",
      "packages/clock/src/file.ts",
      "docs/ordinary.md",
      "specs/ordinary.md",
    ]) {
      expect(isProtectedAutomationPath(path)).toBeFalse()
    }
    expect(
      validateChangedPaths(["src/ordinary.ts", "packages/opencode/src/ordinary.ts", "script/ordinary.ts"]),
    ).toEqual(["src/ordinary.ts", "packages/opencode/src/ordinary.ts", "script/ordinary.ts"])
  })

  test("rejects exact, case-folded, and Unicode case-folded duplicates", () => {
    expect(() => validateChangedPaths(["src/a.ts", "src/a.ts"])).toThrow("duplicate")
    expect(() => validateChangedPaths(["src/Foo.ts", "src/foo.ts"])).toThrow("duplicate")
    expect(() => validateChangedPaths(["src/Straße.ts", "src/STRASSE.ts"])).toThrow("duplicate")
    expect(() => validateRepositoryPathSet(["src/ff.ts", "src/ﬀ.ts"])).toThrow("duplicate")
    expect(() => validateRepositoryPathSet(["LICENSE", "license/child"])).toThrow("duplicate")
  })
})

describe("patch validation", () => {
  test("accepts a regular text patch and returns its exact candidate tree", async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.checkout, sourcePath), "changed\n")
    const patch = await stagedPatch(fixture)
    const objectsBefore = await command(fixture.checkout, ["git", "count-objects", "-v"])
    const result = await validate(fixture, patch, 1)
    expect(result.paths).toEqual([sourcePath])
    expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await command(fixture.checkout, ["git", "count-objects", "-v"])).toEqual(objectsBefore)
  })

  test("standalone validation boots without preinstalled dependencies", async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.checkout, sourcePath), "changed\n")
    const patch = await stagedPatch(fixture)
    const patchPath = join(fixture.artifacts, "changes.patch")
    const generationPath = join(fixture.artifacts, "generation.json")
    const tools = join(fixture.root, "tools")
    await mkdir(tools)
    await writeFile(patchPath, patch)
    await writeFile(generationPath, JSON.stringify(generation(fixture, patch, 1)))
    await copyFile(join(import.meta.dir, "oc2-verify.ts"), join(tools, "oc2-verify.ts"))
    await copyFile(join(import.meta.dir, "oc2-automation-policy.ts"), join(tools, "oc2-automation-policy.ts"))
    await command(fixture.checkout, [
      process.execPath,
      join(tools, "oc2-verify.ts"),
      "validate",
      "--generation",
      generationPath,
      "--patch",
      patchPath,
      "--repository",
      repository,
      "--repository-id",
      String(repositoryId),
      "--base-sha",
      fixture.baseSha,
    ])
  })

  test("accepts regular executable mode changes and deletions", async () => {
    const executable = await repositoryFixture()
    await writeFile(join(executable.checkout, sourcePath), "executable\n")
    await chmod(join(executable.checkout, sourcePath), 0o755)
    expect((await validate(executable, await stagedPatch(executable), 1)).paths).toEqual([sourcePath])

    const deleted = await repositoryFixture()
    await rm(join(deleted.checkout, sourcePath))
    expect((await validate(deleted, await stagedPatch(deleted), 1)).paths).toEqual([sourcePath])
  })

  test("strictly rejects excess and mismatched manifest fields", async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.checkout, sourcePath), "changed\n")
    const patch = await stagedPatch(fixture)
    expect(await rejection(validate(fixture, patch, 1, (value) => ({ ...value, unexpected: true })))).not.toBe("")
    expect(await rejection(validate(fixture, patch, 2))).toContain("mismatch")
    expect(
      await rejection(
        validate(fixture, patch, 1, (value) => ({ ...value, patch: { ...value.patch, sha256: "0".repeat(64) } })),
      ),
    ).toContain("mismatch")
    expect(await rejection(validate(fixture, patch, 1, (value) => ({ ...value, variant: "xhigh" })))).toContain(
      "mismatch",
    )
  })

  test("rejects a base argument or manifest that does not match", async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.checkout, sourcePath), "changed\n")
    const patch = await stagedPatch(fixture)
    const patchPath = join(fixture.artifacts, "changes.patch")
    const generationPath = join(fixture.artifacts, "generation.json")
    await writeFile(patchPath, patch)
    await writeFile(generationPath, JSON.stringify(generation(fixture, patch, 1)))
    expect(
      await rejection(
        validatePatch({
          generationPath,
          patchPath,
          repository,
          repositoryId,
          baseSha: "0".repeat(40),
          cwd: fixture.checkout,
        }),
      ),
    ).toContain("mismatch")
  })

  test("rejects protected paths through the Git-derived path set", async () => {
    const fixture = await repositoryFixture()
    await mkdir(join(fixture.checkout, ".github", "workflows"), { recursive: true })
    await writeFile(join(fixture.checkout, ".github", "workflows", "pwn.yml"), "name: pwn\n")
    expect(await rejection(validate(fixture, await stagedPatch(fixture), 1))).toContain("protected")
  })

  test("rejects symlink and gitlink modes", async () => {
    const symlinkFixture = await repositoryFixture()
    await symlink("source.txt", join(symlinkFixture.checkout, "packages/app/src/link"))
    expect(await rejection(validate(symlinkFixture, await stagedPatch(symlinkFixture), 1))).toContain("mode")

    const gitlinkFixture = await repositoryFixture()
    await command(gitlinkFixture.checkout, [
      "git",
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${gitlinkFixture.baseSha},packages/app/src/module`,
    ])
    expect(await rejection(validate(gitlinkFixture, await indexedPatch(gitlinkFixture), 1))).toContain("mode")
  })

  test("accepts valid binary data and rejects a corrupted binary patch", async () => {
    const imagePath = "packages/app/src/image.bin"
    const fixture = await repositoryFixture({ [imagePath]: new Uint8Array([0, 1, 2, 3, 4, 5]) })
    await writeFile(
      join(fixture.checkout, imagePath),
      Uint8Array.from({ length: 4096 }, (_, index) => index % 251),
    )
    const patch = await stagedPatch(fixture)
    expect((await validate(fixture, patch, 1)).paths).toEqual([imagePath])

    const corrupted = patch.slice()
    const corruptedIndex = Math.floor(corrupted.length / 2)
    corrupted[corruptedIndex] = corrupted[corruptedIndex]! ^ 1
    expect(await rejection(validate(fixture, corrupted, 1))).not.toBe("")
  })

  test("rejects noncanonical patches and oversized decoded candidate blobs", async () => {
    const text = await repositoryFixture()
    await writeFile(join(text.checkout, sourcePath), "candidate\n")
    const patch = await stagedPatch(text)
    expect(await rejection(validate(text, Buffer.concat([patch, new TextEncoder().encode("\n")]), 1))).toContain(
      "canonical",
    )

    const largePath = "packages/app/src/large.bin"
    const binary = await repositoryFixture({ [largePath]: new Uint8Array([0]) })
    await writeFile(join(binary.checkout, largePath), new Uint8Array(20 * 1024 * 1024 + 1))
    expect(await rejection(validate(binary, await stagedPatch(binary), 1))).toContain("size limit")
  })

  test("rejects a patch artifact symlink and bytes beyond the 2 MiB boundary", async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.checkout, sourcePath), "changed\n")
    const patch = await stagedPatch(fixture)
    const realPatch = join(fixture.artifacts, "real.patch")
    const patchPath = join(fixture.artifacts, "changes.patch")
    const generationPath = join(fixture.artifacts, "generation.json")
    await writeFile(realPatch, patch)
    await symlink(realPatch, patchPath)
    await writeFile(generationPath, JSON.stringify(generation(fixture, patch, 1)))
    expect(
      await rejection(
        validatePatch({
          generationPath,
          patchPath,
          repository,
          repositoryId,
          baseSha: fixture.baseSha,
          cwd: fixture.checkout,
        }),
      ),
    ).toContain("input")

    await rm(patchPath)
    const oversized = new Uint8Array(maximumPatchBytes + 1)
    await writeFile(patchPath, oversized)
    await writeFile(generationPath, JSON.stringify(generation(fixture, oversized, 1)))
    expect(
      await rejection(
        validatePatch({
          generationPath,
          patchPath,
          repository,
          repositoryId,
          baseSha: fixture.baseSha,
          cwd: fixture.checkout,
        }),
      ),
    ).toContain("input")
  })

  test("allows exactly 100 files and rejects 101 files", async () => {
    const accepted = await repositoryFixture()
    for (let index = 0; index < maximumChangedFiles; index++)
      await writeFile(
        join(accepted.checkout, `packages/app/src/file-${index.toString().padStart(3, "0")}.txt`),
        "new\n",
      )
    expect((await validate(accepted, await stagedPatch(accepted), maximumChangedFiles)).paths).toHaveLength(
      maximumChangedFiles,
    )

    const rejected = await repositoryFixture()
    for (let index = 0; index <= maximumChangedFiles; index++)
      await writeFile(
        join(rejected.checkout, `packages/app/src/file-${index.toString().padStart(3, "0")}.txt`),
        "new\n",
      )
    expect(await rejection(validate(rejected, await stagedPatch(rejected), maximumChangedFiles))).not.toBe("")
  })

  test("allows exactly 50,000 changed text lines and rejects 50,001", async () => {
    const linesPath = "packages/app/src/lines.txt"
    const accepted = await repositoryFixture({ [linesPath]: "a\n".repeat(maximumChangedLines / 2) })
    await writeFile(join(accepted.checkout, linesPath), "b\n".repeat(maximumChangedLines / 2))
    expect((await validate(accepted, await stagedPatch(accepted), 1)).paths).toEqual([linesPath])

    const rejected = await repositoryFixture({ [linesPath]: "a\n".repeat(maximumChangedLines / 2) })
    await writeFile(join(rejected.checkout, linesPath), "b\n".repeat(maximumChangedLines / 2 + 1))
    expect(await rejection(validate(rejected, await stagedPatch(rejected), 1))).toContain("line limit")
  })

  test("rejects traversal syntax before Git can interpret it", async () => {
    const fixture = await repositoryFixture()
    const patch = new TextEncoder().encode(
      "diff --git a/../escape b/../escape\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..78981922613b2afb6025042ff6bd878ac1994e85\n--- /dev/null\n+++ b/../escape\n@@ -0,0 +1 @@\n+payload\n",
    )
    expect(await rejection(validate(fixture, patch, 1))).not.toBe("")
  })

  test("rejects rename, copy, duplicate, and hostile path records", async () => {
    const renamed = await repositoryFixture()
    await command(renamed.checkout, ["git", "mv", sourcePath, "packages/app/src/renamed.txt"])
    const renamePatch = await command(renamed.checkout, [
      "git",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--find-renames=50%",
    ])
    expect(await rejection(validate(renamed, renamePatch, 1))).toContain("rename")

    const copied = await repositoryFixture()
    await copyFile(join(copied.checkout, sourcePath), join(copied.checkout, "packages/app/src/copied.txt"))
    await command(copied.checkout, ["git", "add", "packages/app/src/copied.txt"])
    const copyPatch = await command(copied.checkout, [
      "git",
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--find-copies-harder",
      "--find-copies=50%",
    ])
    expect(await rejection(validate(copied, copyPatch, 1))).toContain("rename")

    const duplicated = await repositoryFixture()
    await writeFile(join(duplicated.checkout, sourcePath), "candidate\n")
    const patch = await stagedPatch(duplicated)
    expect(await rejection(validate(duplicated, Buffer.concat([patch, patch]), 1))).toContain("duplicate")

    const hostile = await repositoryFixture()
    await writeFile(join(hostile.checkout, "bad\tname.txt"), "candidate\n")
    expect(await rejection(validate(hostile, await stagedPatch(hostile), 1))).toContain("invalid repository path")
  })

  test("real verification applies the candidate tree and atomically emits output only on success", async () => {
    const { input } = await verificationFixture()
    const commands: Array<{ argv: string[]; timeoutMs: number }> = []
    const output = await verifyPatch(input, successfulDocker(commands))
    expect(output.treeSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await Bun.file(input.outputPath).json()).toEqual(output)
    expect(commands.some((item) => item.argv[1] === "wait")).toBeTrue()
  })

  test("real verification rejects dirty bases and post-test tree mismatches without output", async () => {
    const dirty = await verificationFixture()
    await writeFile(join(dirty.fixture.checkout, "unexpected.txt"), "dirty\n")
    expect(await rejection(verifyPatch(dirty.input, successfulDocker([])))).toContain("clean")
    expect(await Bun.file(dirty.input.outputPath).exists()).toBeFalse()

    const changed = await verificationFixture()
    const commands: Array<{ argv: string[]; timeoutMs: number }> = []
    const run = successfulDocker(commands)
    expect(
      await rejection(
        verifyPatch(changed.input, async (argv, timeoutMs) => {
          if (argv[1] === "wait") {
            const mount = commands
              .find((item) => item.argv[1] === "create")!
              .argv.find((value) => value.startsWith("type=bind") && value.endsWith("dst=/source,readonly"))!
            const candidate = mount.slice("type=bind,src=".length, -",dst=/source,readonly".length)
            await writeFile(join(candidate, sourcePath), "sandbox mutation\n")
            await command(candidate, ["git", "add", sourcePath])
          }
          return run(argv, timeoutMs)
        }),
      ),
    ).toContain("candidate tree")
    expect(await Bun.file(changed.input.outputPath).exists()).toBeFalse()

    const poisoned = await verificationFixture()
    await mkdir(join(poisoned.fixture.checkout, "node_modules"))
    await writeFile(join(poisoned.fixture.checkout, "node_modules", "poison"), "secret\n")
    expect(await rejection(verifyPatch(poisoned.input, successfulDocker([])))).toContain("ignored state")
  })
})

describe("verification sandbox", () => {
  test("uses the inspected image ID, strict resources, mounts, environment, and timeouts", async () => {
    const fixture = await sandboxFixture()
    const commands: Array<{ argv: string[]; timeoutMs: number }> = []
    await runVerificationSandbox({ ...fixture, image }, successfulDocker(commands))
    expect(commands.map((item) => item.argv.slice(0, 3))).toEqual([
      ["docker", "pull", image],
      ["docker", "image", "inspect"],
      ["docker", "create", "--name"],
      ["docker", "start", expect.any(String)],
      ["docker", "wait", expect.any(String)],
      ["docker", "kill", expect.any(String)],
      ["docker", "rm", "--force"],
    ])
    const create = commands.find((item) => item.argv[1] === "create")!.argv
    for (const pair of [
      ["--pull", "never"],
      ["--network", "none"],
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
      ["--pids-limit", "1024"],
      ["--memory", "8g"],
      ["--memory-swap", "8g"],
      ["--cpus", "4"],
      ["--ulimit", "nofile=4096:4096"],
      ["--log-driver", "none"],
    ]) {
      const index = create.indexOf(pair[0]!)
      expect(create[index + 1]).toBe(pair[1])
    }
    expect(create).toContain("--read-only")
    expect(create).toContain("--init")
    expect(create).toContain("--no-healthcheck")
    expect(create).toContain("fsize=20971520:20971520")
    expect(create).toContain("/workspace:rw,nosuid,nodev,size=2147483648")
    expect(create.at(-2)).toBe(`sha256:${"b".repeat(64)}`)
    expect(create.join(" ")).not.toContain("docker.sock")
    expect(create.filter((value) => value.startsWith("type=bind"))).toEqual([
      `type=bind,src=${fixture.cwd},dst=/source,readonly`,
      `type=bind,src=${fixture.gitDir},dst=/workspace/.git,readonly`,
      `type=bind,src=${fixture.dependencyDir},dst=/workspace/node_modules,readonly`,
      `type=bind,src=${fixture.dependencyDir},dst=/source/node_modules,readonly`,
      expect.stringMatching(/dst=\/opt\/oc2\/oc2-verify-sandbox\.ts,readonly$/),
    ])
    expect(create).toContain("/source/packages/app/.artifacts:rw,noexec,nosuid,nodev,size=67108864")
    expect(create).toContain("TURBO_CACHE_DIR=/tmp/turbo-cache")
    expect(commands.find((item) => item.argv[1] === "rm")!.argv).toContain("--volumes")
    expect(commands.find((item) => item.argv[1] === "wait")!.timeoutMs).toBe(65 * 60_000)
  })

  test("unconditionally kills and removes a failed container without exposing child output", async () => {
    const fixture = await sandboxFixture()
    const commands: Array<{ argv: string[]; timeoutMs: number }> = []
    const run = successfulDocker(commands)
    expect(
      await rejection(
        runVerificationSandbox({ ...fixture, image }, async (argv, timeout) => {
          if (argv[1] === "wait") return { exitCode: 0, stdout: new TextEncoder().encode("17\nTOP_SECRET_LOG") }
          return run(argv, timeout)
        }),
      ),
    ).toContain("verification checks failed")
    expect(commands.some((item) => item.argv[1] === "kill")).toBeTrue()
    expect(commands.some((item) => item.argv[1] === "rm")).toBeTrue()
  })

  test("requires an immutable digest before invoking Docker", async () => {
    let invoked = false
    expect(
      await rejection(
        runVerificationSandbox(
          { cwd: "/tmp/checkout", gitDir: "/tmp/checkout/.git", image: "ghcr.io/panwar-stack/oc2-verify:latest" },
          async () => {
            invoked = true
            return { exitCode: 0, stdout: new Uint8Array() }
          },
        ),
      ),
    ).toContain("digest")
    expect(invoked).toBeFalse()
  })

  test("rejects image-declared environment, volumes, and symlinked mount sources", async () => {
    const fixture = await sandboxFixture()
    const unsafeMetadata: SandboxCommandRunner = async (argv) => {
      if (argv[1] === "image")
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(
            JSON.stringify({ id: `sha256:${"b".repeat(64)}`, env: ["TOP_SECRET=value"], volumes: null }),
          ),
        }
      return { exitCode: 0, stdout: new Uint8Array() }
    }
    expect(await rejection(runVerificationSandbox({ ...fixture, image }, unsafeMetadata))).toContain(
      "unsafe environment",
    )

    const volumeMetadata: SandboxCommandRunner = async (argv) => {
      if (argv[1] === "image")
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(
            JSON.stringify({ id: `sha256:${"b".repeat(64)}`, env: [], volumes: { "/data": {} } }),
          ),
        }
      return { exitCode: 0, stdout: new Uint8Array() }
    }
    expect(await rejection(runVerificationSandbox({ ...fixture, image }, volumeMetadata))).not.toBe("")

    const dependencyLink = join(fixture.cwd, "linked-dependencies")
    await symlink(fixture.dependencyDir, dependencyLink)
    expect(
      await rejection(
        runVerificationSandbox({ cwd: fixture.cwd, gitDir: fixture.gitDir, dependencyDir: dependencyLink, image }),
      ),
    ).toContain("mount source")
  })

  test("fails closed when a created container cannot be removed with its volumes", async () => {
    const fixture = await sandboxFixture()
    const commands: Array<{ argv: string[]; timeoutMs: number }> = []
    const run = successfulDocker(commands)
    expect(
      await rejection(
        runVerificationSandbox({ ...fixture, image }, async (argv, timeoutMs) => {
          if (argv[1] === "rm") return { exitCode: 1, stdout: new Uint8Array() }
          return run(argv, timeoutMs)
        }),
      ),
    ).toContain("cleanup failed")
  })

  test("entrypoint runs only fixed checks with ignored logs and kills timed-out children", async () => {
    const invocations: Array<{ argv: string[]; cwd: string; stdout: string; stderr: string }> = []
    const spawn: SandboxSpawn = (argv, options) => {
      invocations.push({ argv, cwd: options.cwd, stdout: options.stdout, stderr: options.stderr })
      return { exited: Promise.resolve(0), kill() {} }
    }
    let probed = false
    await runSandboxChecks(spawn, sandboxChecks, async () => {
      probed = true
    })
    expect(invocations.map((item) => item.argv.slice(1))).toEqual(sandboxChecks.map((check) => [...check.argv]))
    expect(invocations.every((item) => item.stdout === "ignore" && item.stderr === "ignore")).toBeTrue()
    expect(invocations.slice(0, -1).every((item) => item.cwd === "/workspace")).toBeTrue()
    expect(invocations.at(-1)?.cwd).toBe("/source")
    expect(probed).toBeTrue()

    let killed = false
    let finish = (_code: number) => {}
    const timeoutChild: SandboxChild = {
      exited: new Promise((resolve) => {
        finish = resolve
      }),
      kill() {
        killed = true
        finish(137)
      },
    }
    expect(
      await rejection(runSandboxChecks(() => timeoutChild, [{ argv: ["run", "docs:check"], timeoutMs: 1 }])),
    ).toContain("verification check failed")
    expect(killed).toBeTrue()
  })

  test("entrypoint materializes only repository files into the bounded workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oc2-materialize-test-")))
    roots.push(root)
    const source = join(root, "source")
    const target = join(root, "target")
    await mkdir(join(source, ".git"), { recursive: true })
    await mkdir(join(source, "node_modules"))
    await mkdir(target)
    await writeFile(join(source, ".git", "config"), "secret\n")
    await writeFile(join(source, "node_modules", "dependency"), "dependency\n")
    await writeFile(join(source, "source.txt"), "candidate\n")
    await materializeSandboxWorkspace(source, target)
    expect(await Bun.file(join(target, "source.txt")).text()).toBe("candidate\n")
    expect(await Bun.file(join(target, ".git")).exists()).toBeFalse()
    expect(await Bun.file(join(target, "node_modules")).exists()).toBeFalse()
  })

  test("entrypoint rejects a writable candidate source mount", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oc2-readonly-test-")))
    roots.push(root)
    expect(assertSourceReadOnly(root)).rejects.toThrow("source is writable")
  })
})

test("exports the specified limits", () => {
  expect(maximumPatchBytes).toBe(2 * 1024 * 1024)
  expect(maximumChangedFiles).toBe(100)
  expect(maximumChangedLines).toBe(50_000)
})
