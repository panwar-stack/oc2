import { expect, test } from "bun:test"

import { createCommandRegistry } from "../../src/commands/registry"
import { defaultConfig, ModelProviderError, openOc2Database } from "../../src"
import { createSessionRunService } from "../../src/session/run"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

test("command resolves review template with arguments and subtask marker", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })

  const result = await service.command({ name: "review", arguments: "diff --git a/file b/file", model: "fake/test" })

  expect(result.status).toBe("completed")
  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toContain("[SUBTASK] Review the following code changes")
  expect(userMessage?.content).toContain("diff --git a/file b/file")
  db.close()
})

test("command substitutes empty arguments and loads skill templates", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })

  await service.command({ name: "clarify", model: "fake/test" })

  const userMessage = provider.requests[0]?.messages.find((message) => message.role === "user")
  expect(userMessage?.content).toContain("# Clarify")
  expect(userMessage?.content).not.toContain("$ARGUMENTS")
  db.close()
})

test("command resumes an existing session when sessionId is provided", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents])
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [provider] })
  const first = await service.run({ prompt: "first", model: "fake/test" })

  const second = await service.command({
    name: "review",
    arguments: "second",
    sessionId: first.sessionId,
    model: "fake/test",
  })

  expect(second.sessionId).toBe(first.sessionId)
  expect(
    service.sessions.messages.listBySession(first.sessionId).filter((message) => message.role === "user"),
  ).toHaveLength(2)
  db.close()
})

test("command rejects unknown or TUI-local commands", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: db,
    providers: [createScriptedModelProvider([simpleAssistantEvents])],
    commands: createCommandRegistry([{ name: "help", description: "help", source: "tui", onExecute: () => undefined }]),
  })

  const missing = await service.command({ name: "missing", model: "fake/test" })
  const tuiLocal = await service.command({ name: "help", model: "fake/test" })

  expect(missing).toMatchObject({
    status: "failed",
    errors: [{ code: "invalid_task", message: "Slash command not found: missing" }],
  })
  expect(tuiLocal).toMatchObject({
    status: "failed",
    errors: [{ code: "invalid_task", message: "Slash command not found: help" }],
  })
  expect(missing.sessionId).toBeString()
  db.close()
})

test("command model failures return failed run results", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const failing = {
    id: "fake",
    name: "Failing",
    async listModels() {
      return [{ id: "test" }]
    },
    async *stream() {
      throw new ModelProviderError({ message: "bad key", classification: "auth", retryable: false })
      yield { type: "done" as const }
    },
  }
  const service = createSessionRunService({ config: defaultConfig, cwd: "/repo", database: db, providers: [failing] })

  const result = await service.command({ name: "review", arguments: "diff", model: "fake/test" })

  expect(result.status).toBe("failed")
  expect(result.errors[0]?.message).toBe("bad key")
  db.close()
})
