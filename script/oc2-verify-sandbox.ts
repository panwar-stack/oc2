#!/usr/bin/env bun

import { cp, readdir } from "node:fs/promises"
import { join } from "node:path"

export const sandboxChecks = [
  { argv: ["run", "docs:check"], timeoutMs: 5 * 60_000 },
  { argv: ["run", "check:packages"], timeoutMs: 5 * 60_000 },
  { argv: ["run", "check:generated"], timeoutMs: 10 * 60_000 },
  { argv: ["turbo", "typecheck"], timeoutMs: 15 * 60_000 },
  { argv: ["turbo", "test:ci", "--log-order=stream", "--log-prefix=task"], timeoutMs: 30 * 60_000 },
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
  checks: ReadonlyArray<{ readonly argv: ReadonlyArray<string>; readonly timeoutMs: number }> = sandboxChecks,
) {
  for (const check of checks) {
    const child = spawn([process.execPath, ...check.argv], {
      cwd: "/workspace",
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
