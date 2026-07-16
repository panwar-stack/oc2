#!/usr/bin/env bun

import { cp, open, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

export const sandboxChecks = [
  { argv: ["run", "docs:check"], timeoutMs: 5 * 60_000 },
  { argv: ["run", "check:packages"], timeoutMs: 5 * 60_000 },
  { argv: ["run", "check:generated"], timeoutMs: 10 * 60_000 },
  { argv: ["run", "typecheck:automation"], timeoutMs: 5 * 60_000 },
  {
    argv: [
      "test",
      "script/oc2-issue.test.ts",
      "script/oc2-verify.test.ts",
      "script/oc2-publish.test.ts",
      "script/oc2-automation-provenance.test.ts",
      "script/ci-scope.test.ts",
    ],
    timeoutMs: 10 * 60_000,
  },
  { argv: ["turbo", "typecheck"], timeoutMs: 15 * 60_000 },
  {
    argv: ["turbo", "test:ci", "--log-order=stream", "--log-prefix=task"],
    timeoutMs: 30 * 60_000,
    readonly: true,
  },
] as const

export interface SandboxChild {
  exited: Promise<number>
  kill(signal: number | NodeJS.Signals): void
}

export type SandboxSpawn = (
  argv: string[],
  options: {
    cwd: string
    env: Readonly<Record<string, string>>
    stdin: "ignore"
    stdout: "ignore"
    stderr: "ignore"
  },
) => SandboxChild

const sandboxEnvironment = {
  BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache",
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  CHOKIDAR_USEPOLLING: "0",
  CI: "1",
  FORCE_COLOR: "0",
  GIT_OPTIONAL_LOCKS: "0",
  HOME: "/home/oc2",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NO_COLOR: "1",
  OC2_DISABLE_EXTERNAL_SKILLS: "1",
  OC2_DISABLE_SHARE: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  TMPDIR: "/tmp",
  TURBO_CACHE_DIR: "/tmp/turbo-cache",
}

export async function runSandboxChecks(
  spawn: SandboxSpawn = (argv, options) => Bun.spawn(argv, options),
  checks: ReadonlyArray<{
    readonly argv: ReadonlyArray<string>
    readonly timeoutMs: number
    readonly readonly?: boolean
  }> = sandboxChecks,
  assertReadonly: (root?: string) => Promise<void> = assertSourceReadOnly,
) {
  for (const check of checks) {
    if (check.readonly) await assertReadonly()
    const child = spawn([process.execPath, ...check.argv], {
      cwd: check.readonly ? "/source" : "/workspace",
      env: sandboxEnvironment,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, check.timeoutMs)
    const exitCode = await child.exited
    clearTimeout(timer)
    if (timedOut || exitCode !== 0) throw new Error("verification check failed")
  }
}

export async function assertSourceReadOnly(root = "/source") {
  const probe = join(root, ".oc2-readonly-probe")
  try {
    const file = await open(probe, "wx", 0o600)
    await file.close()
    await rm(probe, { force: true })
    throw new Error("verification source is writable")
  } catch (error) {
    if (error instanceof Error && error.message === "verification source is writable") throw error
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code !== "EACCES" && code !== "EROFS") throw new Error("verification source mount check failed")
  }
}

export async function materializeSandboxWorkspace(source = "/source", target = "/workspace") {
  for (const entry of await readdir(source)) {
    if (entry === ".git" || entry === "node_modules") continue
    await cp(join(source, entry), join(target, entry), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    })
  }
}

export async function main() {
  await materializeSandboxWorkspace()
  await runSandboxChecks()
}

if (import.meta.main) {
  await main().catch(() => {
    process.exitCode = 1
  })
}
