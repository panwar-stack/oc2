import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"

import { createSessionService, createTextPart, openOc2Database } from "../../src"
import { runCli } from "../../src/cli/index"

test("oc2 export emits a persisted session transcript as markdown", async () => {
  const dataDir = await createExportFixture()
  const stdout: string[] = []

  const result = await runCli({
    argv: ["export", "root", "--format", "markdown"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    streams: { stdout: (text) => void stdout.push(text) },
  })

  expect(result.exitCode).toBe(0)
  expect(stdout.join("")).toBe("# Session root\n\n## user\n\nroot prompt\n")
  await rm(dataDir, { recursive: true, force: true })
})

test("oc2 export --recursive preserves nested transcript order", async () => {
  const dataDir = await createExportFixture()
  const stdout: string[] = []

  const result = await runCli({
    argv: ["export", "root", "--format", "json", "--recursive"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    streams: { stdout: (text) => void stdout.push(text) },
  })

  expect(result.exitCode).toBe(0)
  const output = JSON.parse(stdout.join(""))
  expect(output.sessions.map((entry: { session: { id: string } }) => entry.session.id)).toEqual([
    "root",
    "child-a",
    "grandchild",
    "child-b",
  ])
  expect(output.sessions[1].messages[0].parts[0].text).toBe("child a")
  await rm(dataDir, { recursive: true, force: true })
})

test("oc2 export reports missing sessions", async () => {
  const dataDir = await createExportFixture()
  const stderr: string[] = []

  const result = await runCli({
    argv: ["export", "missing", "--format", "json"],
    cwd: "/repo",
    homeDir: dataDir,
    env: { OC2_DATA_DIR: dataDir },
    streams: { stderr: (text) => void stderr.push(text) },
  })

  expect(result.exitCode).toBe(1)
  expect(stderr.join("")).toBe("Session not found: missing\n")
  await rm(dataDir, { recursive: true, force: true })
})

async function createExportFixture(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-export-"))
  const db = openOc2Database({ path: join(dataDir, "oc2.sqlite") })
  const sessions = createSessionService({ database: db })
  sessions.createSession({
    id: "root",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:00.000Z",
  })
  sessions.createSession({
    id: "child-b",
    parentSessionId: "root",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:01.000Z",
  })
  sessions.createSession({
    id: "child-a",
    parentSessionId: "root",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:01.000Z",
  })
  sessions.createSession({
    id: "grandchild",
    parentSessionId: "child-a",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:02.000Z",
  })
  sessions.appendMessage({
    id: "message-root",
    sessionId: "root",
    role: "user",
    parts: [createTextPart("root prompt")],
  })
  sessions.appendMessage({
    id: "message-child-a",
    sessionId: "child-a",
    role: "assistant",
    parts: [createTextPart("child a")],
  })
  sessions.appendMessage({
    id: "message-child-b",
    sessionId: "child-b",
    role: "assistant",
    parts: [createTextPart("child b")],
  })
  sessions.appendMessage({
    id: "message-grandchild",
    sessionId: "grandchild",
    role: "tool",
    parts: [createTextPart("grandchild")],
  })
  db.close()
  return dataDir
}
