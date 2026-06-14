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
  expect(service.listWorkspaceRoots("session-1").map((root) => root.path)).toEqual(["/repo", "/reference"])
  expect(service.listSessions().map((item) => item.id)).toEqual(["session-1"])
  expect(emitted).toEqual(["session.created"])
  db.close()
})

test("session service adds workspace roots and emits updates", () => {
  const db = openOc2Database({ path: ":memory:" })
  const events = createRuntimeEventBus()
  const emitted: string[] = []
  events.all((event) => emitted.push(event.type))
  const service = createSessionService({ database: db, events })
  service.createSession({
    id: "session-1",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
  })

  const added = service.addWorkspaceRoot("session-1", { path: "/reference", readonly: true })

  expect(added.path).toBe("/reference")
  expect(service.listWorkspaceRoots("session-1").map((root) => [root.path, root.readonly])).toEqual([
    ["/repo", false],
    ["/reference", true],
  ])
  expect(emitted).toEqual(["session.created", "session.updated"])
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

test("session service collects recursive transcripts in hierarchy order", () => {
  const db = openOc2Database({ path: ":memory:" })
  const service = createSessionService({ database: db })
  service.createSession({
    id: "root",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:00.000Z",
  })
  service.createSession({
    id: "child-b",
    parentSessionId: "root",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:01.000Z",
  })
  service.createSession({
    id: "child-a",
    parentSessionId: "root",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:01.000Z",
  })
  service.createSession({
    id: "grandchild",
    parentSessionId: "child-a",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2026-01-01T00:00:02.000Z",
  })
  service.appendMessage({ id: "message-root", sessionId: "root", role: "user", parts: [createTextPart("root")] })

  const transcripts = service.collectTranscripts("root", { recursive: true })

  expect(transcripts.map((transcript) => transcript.session.id)).toEqual(["root", "child-a", "grandchild", "child-b"])
  expect(transcripts[0]?.messages.map((message) => message.id)).toEqual(["message-root"])
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
