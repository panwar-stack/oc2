import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { OC2_TUI_STARTUP_PROFILE, OC2_TUI_STARTUP_PROFILE_FD } from "@oc2-ai/core/util/tui-startup-profile"

const root = path.join(import.meta.dir, "../../../..")
const entry = path.join(root, "packages/opencode/src/index.ts")

function run(fd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; trace: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["run", "--conditions=browser", entry, "--version"], {
      cwd: root,
      env: {
        ...process.env,
        OC2_RUN_ID: "run_test-1",
        [OC2_TUI_STARTUP_PROFILE]: "1",
        [OC2_TUI_STARTUP_PROFILE_FD]: fd,
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const trace: Buffer[] = []
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.stdio[3]?.on("data", (chunk) => trace.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        trace: Buffer.concat(trace).toString(),
      })
    })
  })
}

describe("CLI startup trace", () => {
  test("initializes before argument parsing and keeps an exit fallback", async () => {
    const source = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text()
    const metadata = source.indexOf('ensureProcessMetadata("main")')
    const initialize = source.indexOf("initializeTuiStartupProfile()")
    const entry = source.indexOf('startupProfile.emit({ event: "cli.entry"')
    const fallback = source.indexOf('process.once("exit", () => startupProfile.close())')
    const args = source.indexOf("hideBin(process.argv)")
    const commands = source.indexOf("await loadCommands()")
    const close = source.lastIndexOf("startupProfile.close()")
    const exit = source.lastIndexOf("process.exit()")

    expect(metadata).toBeGreaterThan(-1)
    expect(initialize).toBeGreaterThan(metadata)
    expect(entry).toBeGreaterThan(initialize)
    expect(fallback).toBeGreaterThan(entry)
    expect(fallback).toBeLessThan(args)
    expect(entry).toBeLessThan(args)
    expect(entry).toBeLessThan(commands)
    expect(close).toBeGreaterThan(commands)
    expect(close).toBeLessThan(exit)
  })

  test("emits allowlisted CLI phases only to the inherited trace pipe and closes it on non-TUI exit", async () => {
    const result = await run("3")
    const lines = result.trace.trim().split("\n")

    expect(result.code).toBe(0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({
      version: 1,
      runID: "run_test-1",
      sequence: 0,
      elapsedMs: expect.any(Number),
      event: "cli.entry",
      role: "main",
    })
    expect(JSON.parse(lines[1])).toEqual({
      version: 1,
      runID: "run_test-1",
      sequence: 1,
      elapsedMs: expect.any(Number),
      event: "phase",
      role: "main",
      phase: "cli.command.load",
      outcome: "ok",
      durationMs: expect.any(Number),
    })
    expect(result.stdout).not.toContain("cli.entry")
    expect(result.stderr).not.toContain("cli.entry")
  })

  test("invalid trace configuration remains silent", async () => {
    const result = await run("2")

    expect(result.code).toBe(0)
    expect(result.trace).toBe("")
    expect(result.stdout).not.toContain("cli.entry")
    expect(result.stderr).not.toContain("cli.entry")
  })
})
