import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"

import { runCli } from "../../src/cli/index"
import { createSessionRunService } from "../../src/session/run"
import { defaultConfig, openOc2Database } from "../../src"
import type { ModelRequest } from "../../src/model/provider"

test("run forwards team and timeout flags", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-run-flags-"))
  const requests: ModelRequest[] = []
  const provider = {
    id: "fake",
    name: "Capturing",
    async listModels() {
      return [{ id: "test", supportsTools: true }]
    },
    async *stream(request: ModelRequest) {
      requests.push(request)
      yield { type: "text-delta" as const, text: "ok" }
      yield { type: "done" as const }
    },
  }

  try {
    const result = await runCli({
      argv: ["run", "hello", "--model", "fake/test", "--team", "--timeout", "5000", "--max-concurrency", "2", "--json"],
      cwd: "/repo",
      homeDir: dataDir,
      env: { OC2_DATA_DIR: dataDir },
      fileExists: async () => false,
      modelProviders: [provider],
      streams: { stdout: () => undefined },
    })

    expect(result.exitCode).toBe(0)
    expect(requests[0]?.providerOptions?.timeoutMs).toBe(5000)
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain("team_create")
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("resume --tui launches TUI without --run", async () => {
  const launches: unknown[] = []
  const result = await runCli({
    argv: ["resume", "session-1", "--tui", "--model", "fake/test"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async () => false,
    tuiLauncher: async (options) => {
      launches.push({ sessionId: options.sessionId, model: options.model })
    },
  })

  expect(result.exitCode).toBe(0)
  expect(launches).toEqual([{ sessionId: "session-1", model: "fake/test" }])
})

test("team tools do not leak into later non-team runs on reused service", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const requests: ModelRequest[] = []
  const provider = {
    id: "fake",
    name: "Capturing",
    async listModels() {
      return [{ id: "test", supportsTools: true }]
    },
    async *stream(request: ModelRequest) {
      requests.push(request)
      yield { type: "text-delta" as const, text: "ok" }
      yield { type: "done" as const }
    },
  }
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })

  await service.run({ prompt: "team", model: "fake/test", team: true })
  await service.run({ prompt: "plain", model: "fake/test" })

  expect(requests[0]?.tools.map((tool) => tool.name)).toContain("team_create")
  expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain("team_create")
  db.close()
})
