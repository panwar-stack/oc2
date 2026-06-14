import { expect, test } from "bun:test"

import { runCli } from "../../src/cli/index"

test("successful commands exit zero", async () => {
  const version = await runCli({ argv: ["version"], streams: { stdout: () => undefined } })
  const runHelp = await runCli({ argv: ["run", "--help"], streams: { stdout: () => undefined } })

  expect(version.exitCode).toBe(0)
  expect(runHelp.exitCode).toBe(0)
})

test("invalid commands exit non-zero", async () => {
  const stderr: string[] = []
  const result = await runCli({
    argv: ["wat"],
    streams: {
      stderr: (text) => {
        stderr.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(1)
  expect(stderr.join("")).toContain("Unknown command: wat")
})

test("missing config key exits non-zero", async () => {
  const result = await runCli({
    argv: ["config", "get", "missing.key"],
    env: {},
    fileExists: async () => false,
    streams: { stdout: () => undefined },
  })

  expect(result.exitCode).toBe(1)
})

test("CLI entrypoint smoke commands", async () => {
  const version = Bun.spawn(["bun", "src/index.ts", "version", "--json"], { cwd: import.meta.dir + "/../.." })
  const versionText = await new Response(version.stdout).text()
  expect(await version.exited).toBe(0)
  expect(JSON.parse(versionText)).toEqual({ name: "oc2", version: "0.0.0" })

  const diagnostics = Bun.spawn(["bun", "src/index.ts", "diagnostics", "--json"], { cwd: import.meta.dir + "/../.." })
  const diagnosticsText = await new Response(diagnostics.stdout).text()
  expect(await diagnostics.exited).toBe(0)
  expect(JSON.parse(diagnosticsText).environment.cwd).toContain("oc2")

  const runHelp = Bun.spawn(["bun", "src/index.ts", "run", "--help"], { cwd: import.meta.dir + "/../.." })
  const runHelpText = await new Response(runHelp.stdout).text()
  expect(await runHelp.exited).toBe(0)
  expect(runHelpText).toContain("Usage: oc2 run <prompt>")
})

test("CLI entrypoint writes parse errors to stderr", async () => {
  const process = Bun.spawn(["bun", "src/index.ts", "wat"], {
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()

  expect(await process.exited).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).toContain("Unknown command: wat")
})
