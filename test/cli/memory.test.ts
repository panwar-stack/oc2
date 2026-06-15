import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"

import { runCli } from "../../src/cli/index"
import { openOc2Database } from "../../src/persistence/db"
import { RepositoryMemoryRepository } from "../../src/persistence/repositories/memory"

test("memory list returns retrieval logs for repository", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-memory-"))
  const db = openOc2Database({ path: join(dataDir, "oc2.sqlite") })
  const memory = new RepositoryMemoryRepository(db.sqlite)
  const repository = resolve("/repo", "project")
  const record = memory.ensureRepository({ identity: repository })
  memory.logRetrieval({
    repositoryId: record.id,
    sessionId: "session-1",
    tool: "memory",
    query: "api",
    returnedEntryIds: ["e1"],
    selectedEntryIds: ["e1"],
  })
  db.close()

  try {
    const output: string[] = []
    const result = await runCli({
      argv: ["memory", "list", "--repository", "project"],
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
    expect(output.join("")).toContain("session-1\tapi\t1 returned\t1 selected")
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
