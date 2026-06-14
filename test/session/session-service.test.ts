import { expect, test } from "bun:test"
import { createRuntimeEventBus, createSessionService, createTextPart, openOc2Database } from "../../src"

test("session service creates, resumes, lists, and persists explicit workspace roots", () => {
  const db = openOc2Database({ path: ":memory:" })
  const events = createRuntimeEventBus()
  const emitted: string[] = []
  events.all((event) => emitted.push(event.type))
  const service = createSessionService({ database: db, events })

  const session = service.createSession({
    id: "session-1",
    title: "Persistence",
    workspaceRoots: [
      { path: "/repo", label: "repo", readonly: false },
      { path: "/reference", label: "reference", readonly: true },
    ],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    metadata: { purpose: "test" },
    now: "2026-01-01T00:00:00.000Z",
  })

  expect(session.workspaceRoots.map((root) => [root.path, root.readonly])).toEqual([
    ["/repo", false],
    ["/reference", true],
  ])
  expect(service.resumeSession("session-1")?.metadata).toEqual({ purpose: "test" })
  expect(service.listSessions().map((item) => item.id)).toEqual(["session-1"])
  expect(emitted).toEqual(["session.created"])
  db.close()
})

test("session service appends and updates messages with ordered parts", () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionService({ database: db })
  service.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })

  const message = service.appendMessage({
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    parts: [createTextPart("hello")],
    status: "running",
  })
  const updated = service.updateMessage(message.id, {
    parts: [createTextPart("hello"), { type: "reasoning", text: "because" }],
    status: "completed",
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  })

  expect(updated.parts).toEqual([createTextPart("hello"), { type: "reasoning", text: "because" }])
  expect(updated.status).toBe("completed")
  expect(updated.usage?.totalTokens).toBe(3)
  expect(service.messages.listBySession("session-1").map((item) => item.id)).toEqual(["message-1"])
  db.close()
})

test("message errors are stored without non-serializable cause fields", () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionService({ database: db })
  service.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })

  const message = service.appendMessage({
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    parts: [createTextPart("failed")],
    status: "failed",
    error: {
      name: "RuntimeError",
      code: "unknown",
      message: "failed",
      recoverable: true,
      cause: { token: "do-not-store" },
    },
  })

  expect(message.error).toEqual({ name: "RuntimeError", code: "unknown", message: "failed", recoverable: true })
  db.close()
})

test("message parts redact nested tool result error causes and secret keys", () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionService({ database: db })
  service.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })

  const message = service.appendMessage({
    id: "message-1",
    sessionId: "session-1",
    role: "tool",
    parts: [
      {
        type: "tool-result",
        result: {
          toolCallId: "tool-1",
          error: {
            name: "RuntimeError",
            code: "unknown",
            message: "failed",
            recoverable: true,
            cause: { token: "do-not-store" },
            details: { authorization: "Bearer secret" },
          },
        },
      },
    ],
  })

  expect(message.parts).toEqual([
    {
      type: "tool-result",
      result: {
        toolCallId: "tool-1",
        error: {
          name: "RuntimeError",
          code: "unknown",
          message: "failed",
          recoverable: true,
          details: { authorization: "[redacted]" },
        },
      },
    },
  ])
  db.close()
})
