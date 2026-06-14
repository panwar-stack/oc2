import { expect, test } from "bun:test"
import { join } from "node:path"

import { openOc2Database } from "../../src/persistence/db"
import { RepositoryMemoryRepository } from "../../src/persistence/repositories/memory"
import { createToolExecutor } from "../../src/tools/execution"
import { createToolRegistry } from "../../src/tools/registry"
import { createMemoryTool } from "../../src/tools/builtins/memory"
import { createTempWorkspace } from "./helpers"

test("memory tool stores, searches, retrieves, and logs local repository memory", async () => {
  const workspace = await createTempWorkspace()
  const db = openOc2Database({ path: ":memory:" })
  try {
    const repositoryMemory = new RepositoryMemoryRepository(db.sqlite)
    const executor = createToolExecutor({ registry: createToolRegistry([createMemoryTool()]) })
    const context = {
      workspaceRoots: [workspace.root],
      cwd: workspace.path,
      memory: repositoryMemory,
      sessionId: "session-1",
    }

    const store = await executor.execute(
      {
        id: "store-memory",
        name: "memory",
        arguments: {
          action: "store",
          kind: "decision",
          key: "tool-registry",
          content: "Memory is injected through ToolContext and stays local-only.",
          metadata: { file: "src/tools/tool.ts" },
        },
      },
      context,
    )
    expect(store).toMatchObject({ ok: true })

    const search = await executor.execute(
      { id: "search-memory", name: "memory", arguments: { action: "search", query: "injected local", limit: 5 } },
      context,
    )
    expect(search).toMatchObject({ ok: true })
    if (!search.ok) throw new Error(search.error.message)
    expect(search.output).toMatchObject({
      action: "search",
      entries: [expect.objectContaining({ kind: "decision", key: "tool-registry" })],
    })

    const get = await executor.execute(
      { id: "get-memory", name: "memory", arguments: { action: "get", kind: "decision", key: "tool-registry" } },
      context,
    )
    expect(get).toMatchObject({ ok: true })
    if (!get.ok) throw new Error(get.error.message)
    expect(get.output).toMatchObject({
      action: "get",
      entry: expect.objectContaining({ content: expect.stringContaining("local-only") }),
    })

    const logs = repositoryMemory.listRetrievalLogs(workspace.path)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ sessionId: "session-1", tool: "memory", query: "injected local" })
    expect(logs[0]?.returnedEntryIds).toHaveLength(1)
  } finally {
    db.close()
    await workspace.cleanup()
  }
})

test("repository memory schema has no GitHub review fields", async () => {
  const workspace = await createTempWorkspace()
  const db = openOc2Database({ path: join(workspace.path, "memory.sqlite") })
  try {
    const fields = db.sqlite
      .query<{ readonly table_name: string; readonly name: string }, []>(
        `SELECT m.name AS table_name, p.name AS name
         FROM sqlite_master m, pragma_table_info(m.name) p
         WHERE m.type = 'table' AND m.name LIKE 'repository_memory_%'`,
      )
      .all()
      .map((field) => `${field.table_name}.${field.name}`)
      .join("\n")

    expect(fields).not.toMatch(/github|provider|owner|issue|review/i)
  } finally {
    db.close()
    await workspace.cleanup()
  }
})

test("repository memory redacts obvious secrets before persistence", async () => {
  const workspace = await createTempWorkspace()
  const db = openOc2Database({ path: ":memory:" })
  try {
    const repositoryMemory = new RepositoryMemoryRepository(db.sqlite)
    repositoryMemory.storeEntry({
      repositoryIdentity: workspace.path,
      kind: "note",
      key: "secret-handling",
      content: "Do not persist Bearer raw-bearer-token or openai-rawapikey123.",
      metadata: {
        apiKey: "openai-metadataapikey123",
        nested: {
          authorization: "Bearer nested-raw-token",
          note: "Inline anthropic-nestedapikey123 should be redacted too.",
        },
      },
    })

    const row = db.sqlite
      .query<
        { readonly content: string; readonly token_text: string; readonly metadata_json: string },
        []
      >("SELECT content, token_text, metadata_json FROM repository_memory_entries LIMIT 1")
      .get()
    if (!row) throw new Error("Repository memory entry was not stored")

    const persisted = `${row.content}\n${row.token_text}\n${row.metadata_json}`
    expect(persisted).not.toContain("raw-bearer-token")
    expect(persisted).not.toContain("openai-rawapikey123")
    expect(persisted).not.toContain("openai-metadataapikey123")
    expect(persisted).not.toContain("nested-raw-token")
    expect(persisted).not.toContain("anthropic-nestedapikey123")
    expect(persisted).toContain("[REDACTED]")
  } finally {
    db.close()
    await workspace.cleanup()
  }
})

test("repository memory redacts obvious secrets when logging retrieval queries directly", async () => {
  const workspace = await createTempWorkspace()
  const db = openOc2Database({ path: ":memory:" })
  try {
    const repositoryMemory = new RepositoryMemoryRepository(db.sqlite)
    const repository = repositoryMemory.ensureRepository({ identity: workspace.path })

    repositoryMemory.logRetrieval({
      repositoryId: repository.id,
      tool: "direct-test",
      query: "deployment Bearer rawBearerToken123 api key sk-testapikey123 openai-rawapikey123",
      returnedEntryIds: [],
    })

    const row = db.sqlite
      .query<{ readonly query: string }, []>("SELECT query FROM repository_memory_retrieval_logs LIMIT 1")
      .get()
    if (!row) throw new Error("Repository memory retrieval log was not stored")

    expect(row.query).not.toContain("rawBearerToken123")
    expect(row.query).not.toContain("sk-testapikey123")
    expect(row.query).not.toContain("openai-rawapikey123")
    expect(row.query).toContain("Bearer [REDACTED]")
    expect(row.query).toContain("[REDACTED]")
  } finally {
    db.close()
    await workspace.cleanup()
  }
})
