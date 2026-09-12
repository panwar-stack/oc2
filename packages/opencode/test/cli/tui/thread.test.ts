import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { resolveCliEntrypoint, resolveThreadDirectory, workerEnv } from "../../../src/cli/cmd/tui"
import { resolveMemberExecutableArgs } from "../../../src/team/member-process"

describe("tui thread", () => {
  test("resolves the real CLI entrypoint for a Bun source checkout", () => {
    expect(resolveCliEntrypoint("/repo/packages/opencode/src/index.ts", "/usr/local/bin/bun")).toBe(
      path.resolve("/repo/packages/opencode/src/index.ts"),
    )
  })

  test("resolves no CLI entrypoint for a compiled binary", () => {
    expect(resolveCliEntrypoint("/ignored", "/usr/local/bin/oc2")).toBeUndefined()
    expect(resolveCliEntrypoint(undefined, "/usr/local/bin/bun")).toBeUndefined()
  })

  test("forwards the CLI entrypoint into the worker environment", () => {
    const env = workerEnv({ cliEntrypoint: "/repo/packages/opencode/src/index.ts", runID: "run-1" })
    expect(env.OC2_PROCESS_ROLE).toBe("worker")
    expect(env.OC2_RUN_ID).toBe("run-1")
    expect(env.OC2_CLI_ENTRY).toBe("/repo/packages/opencode/src/index.ts")
  })

  test("omits the CLI entrypoint when the host is compiled", () => {
    const env = workerEnv({ cliEntrypoint: undefined, runID: "run-2" })
    expect(env.OC2_CLI_ENTRY).toBeUndefined()
  })

  // Regression: the team server runs inside the TUI worker thread, whose argv[1]
  // is worker.ts. Without the worker env forwarding OC2_CLI_ENTRY, a teammate
  // spawned from the worker resolved argv[1] and ran `worker.ts teammate`, so it
  // never dispatched the `teammate` command or started a heartbeat and was
  // settled as a lost member. This asserts the worker env is sufficient to make
  // the member spawner resolve the real CLI entry.
  test("spawns teammates against the real CLI entry from the worker environment", () => {
    const cliEntry = "/repo/packages/opencode/src/index.ts"
    const previous = process.env.OC2_CLI_ENTRY
    try {
      process.env.OC2_CLI_ENTRY = workerEnv({ cliEntrypoint: cliEntry, runID: "run-3" }).OC2_CLI_ENTRY
      expect(resolveMemberExecutableArgs().args).toEqual([path.resolve(cliEntry), "teammate"])
    } finally {
      if (previous === undefined) delete process.env.OC2_CLI_ENTRY
      else process.env.OC2_CLI_ENTRY = previous
    }
  })

  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).toContain('await import("../tui/validate-session")')
    expect(source).not.toMatch(/import\s+\{\s*validateSession\s*\}\s+from\s+["']\.\.\/tui\/validate-session["']/)
    expect(source).not.toContain('import("./app")')
  })

  test("keeps the CLI installation check lightweight", async () => {
    const source = await Bun.file(new URL("../../../src/index.ts", import.meta.url)).text()

    expect(source).toContain("InstallationLocal")
    expect(source).not.toMatch(/from\s+["']\.\/installation["']/)
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })
})
