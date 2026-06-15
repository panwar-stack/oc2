import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"

import { runCli } from "../../src/cli/index"
import { openOc2Database } from "../../src/persistence/db"
import { createSessionService } from "../../src/session/session-service"

test("sessions list returns persisted sessions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-sessions-"))
  const databasePath = join(dataDir, "oc2.sqlite")
  const db = openOc2Database({ path: databasePath })
  createSessionService({ database: db }).createSession({
    id: "session-1",
    title: "Test session",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    status: "completed",
  })
  db.close()

  try {
    const output: string[] = []
    const result = await runCli({
      argv: ["sessions", "list"],
      cwd: "/repo",
      homeDir: dataDir,
      env: { OC2_DATA_DIR: dataDir },
      streams: {
        stdout: (text) => {
          output.push(text)
        },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(output.join("")).toContain("session-1\tcompleted")
    expect(output.join("")).toContain("Test session")
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("sessions list handles missing database", async () => {
  const output: string[] = []
  const result = await runCli({
    argv: ["sessions", "list", "--json"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: { OC2_DATA_DIR: "/missing" },
    fileExists: async () => false,
    streams: {
      stdout: (text) => {
        output.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(output.join(""))).toEqual({ sessions: [] })
})
