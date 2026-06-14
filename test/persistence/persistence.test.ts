import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeError, createRuntimeEvent, getAppliedMigrationIds, openOc2Database } from "../../src"
import { McpSnapshotRepository } from "../../src/persistence/repositories/mcp"
import { RuntimeEventRepository } from "../../src/persistence/repositories/runtime-events"
import { ToolCallRepository } from "../../src/persistence/repositories/tool-calls"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oc2-persistence-"))
  tempDirs.push(dir)
  return join(dir, "sessions.sqlite")
}

test("database migrations create PR4 tables and are idempotent", () => {
  const dbPath = tempDbPath()
  const first = openOc2Database({ path: dbPath })
  expect(getAppliedMigrationIds(first.sqlite)).toEqual([
    "0001_persistence_session_storage",
    "0002_agent_team_core",
    "0003_team_plan_approval",
  ])
  first.close()

  const second = openOc2Database({ path: dbPath })
  expect(getAppliedMigrationIds(second.sqlite)).toEqual([
    "0001_persistence_session_storage",
    "0002_agent_team_core",
    "0003_team_plan_approval",
  ])
  const table = second.sqlite
    .query<{ readonly name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("workspace_roots")
  expect(table?.name).toBe("workspace_roots")
  second.close()
})

test("opening a corrupt database returns a structured runtime error", () => {
  const dbPath = tempDbPath()
  writeFileSync(dbPath, "not a sqlite database")

  expect(() => openOc2Database({ path: dbPath })).toThrow(RuntimeError)
})

test("database parent directory is created when needed", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc2-parent-"))
  tempDirs.push(dir)
  const dbPath = join(dir, "nested", "sessions.sqlite")

  const db = openOc2Database({ path: dbPath })

  expect(existsSync(dbPath)).toBe(true)
  db.close()
})

test("tool calls, runtime events, and MCP snapshots persist explicit records", () => {
  const db = openOc2Database({ path: ":memory:" })
  db.sqlite
    .query(
      `INSERT INTO sessions
      (id, title, created_at, updated_at, provider_id, model_id, agent_id, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session-1",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "fake",
      "test",
      "main",
      "idle",
      "{}",
    )

  const toolCalls = new ToolCallRepository(db.sqlite)
  const runtimeEvents = new RuntimeEventRepository(db.sqlite)
  const mcp = new McpSnapshotRepository(db.sqlite)

  toolCalls.upsert({
    id: "tool-1",
    sessionId: "session-1",
    name: "read",
    input: { filePath: "README.md" },
    status: "completed",
    result: { text: "ok" },
  })
  runtimeEvents.append(
    createRuntimeEvent({ type: "session.updated", payload: { sessionId: "session-1", status: "idle" } }),
    "session-1",
  )
  mcp.append({ serverId: "filesystem", status: { status: "connected", tools: 1 } })

  expect(toolCalls.listBySession("session-1")).toHaveLength(1)
  expect(runtimeEvents.listBySession("session-1")).toHaveLength(1)
  expect(mcp.latest("filesystem")?.status).toEqual({ status: "connected", tools: 1 })
  db.close()
})

test("tool calls, runtime events, and MCP snapshots redact error causes and secret keys", () => {
  const db = openOc2Database({ path: ":memory:" })
  db.sqlite
    .query(
      `INSERT INTO sessions
      (id, title, created_at, updated_at, provider_id, model_id, agent_id, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "session-1",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "fake",
      "test",
      "main",
      "idle",
      "{}",
    )

  const toolCalls = new ToolCallRepository(db.sqlite)
  const runtimeEvents = new RuntimeEventRepository(db.sqlite)
  const mcp = new McpSnapshotRepository(db.sqlite)
  const error = {
    name: "RuntimeError" as const,
    code: "unknown" as const,
    message: "failed",
    recoverable: true,
    cause: { token: "do-not-store" },
    details: { clientSecret: "do-not-store" },
  }

  toolCalls.upsert({
    id: "tool-1",
    sessionId: "session-1",
    name: "read",
    input: { authorization: "Bearer secret", OPENAI_API_KEY: "sk-secret", "x-api-key": "x-secret" },
    status: "failed",
    error,
  })
  runtimeEvents.append(createRuntimeEvent({ type: "error", payload: { error } }), "session-1")
  mcp.append({
    serverId: "remote",
    status: {
      error,
      headers: { authorization: "Bearer secret", cookie: "session=secret", "set-cookie": "session=secret" },
    },
  })

  expect(toolCalls.get("tool-1")?.input).toEqual({
    authorization: "[redacted]",
    OPENAI_API_KEY: "[redacted]",
    "x-api-key": "[redacted]",
  })
  expect(toolCalls.get("tool-1")?.error).toEqual({
    name: "RuntimeError",
    code: "unknown",
    message: "failed",
    recoverable: true,
    details: { clientSecret: "[redacted]" },
  })
  expect(runtimeEvents.listBySession("session-1")[0]?.payload).toEqual({
    error: {
      name: "RuntimeError",
      code: "unknown",
      message: "failed",
      recoverable: true,
      details: { clientSecret: "[redacted]" },
    },
  })
  expect(mcp.latest("remote")?.status).toEqual({
    error: {
      name: "RuntimeError",
      code: "unknown",
      message: "failed",
      recoverable: true,
      details: { clientSecret: "[redacted]" },
    },
    headers: { authorization: "[redacted]", cookie: "[redacted]", "set-cookie": "[redacted]" },
  })
  db.close()
})
