import { expect, test } from "bun:test"
import { createTextPart, exportTranscriptJson, exportTranscriptMarkdown } from "../../src"
import type { SessionRecord } from "../../src/persistence/repositories/sessions"
import type { SessionMessage } from "../../src/session/message"

const session: SessionRecord = {
  id: "session-1",
  title: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  workspaceRoots: [{ id: "root-1", path: "/repo", readonly: false }],
  providerId: "fake",
  modelId: "test",
  agentId: "main",
  status: "idle",
  metadata: {},
}

const messages: readonly SessionMessage[] = [
  {
    id: "message-1",
    sessionId: "session-1",
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parts: [createTextPart("hello")],
    status: "completed",
  },
  {
    id: "message-2",
    sessionId: "session-1",
    role: "assistant",
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    parts: [createTextPart("hi"), { type: "tool-call", toolCall: { id: "tool-1", name: "read", input: {}, status: "completed" } }],
    status: "completed",
  },
]

test("transcript exports markdown in persisted message order", () => {
  expect(exportTranscriptMarkdown({ session, messages })).toBe(
    "# Session session-1\n\n## user\n\nhello\n\n## assistant\n\nhi\n[tool-call:read]\n",
  )
})

test("transcript exports JSON primitives", () => {
  expect(JSON.parse(exportTranscriptJson({ session, messages }))).toMatchObject({
    session: { id: "session-1", workspaceRoots: [{ path: "/repo" }] },
    messages: [{ role: "user" }, { role: "assistant" }],
  })
})
