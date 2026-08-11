import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { TodoWriteTool } from "../../src/tool/todo"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const updates: Array<{ sessionID: SessionID; todos: Todo.Info[] }> = []
const todoLayer = Layer.mock(Todo.Service, {
  update: (input) =>
    Effect.sync(() => {
      updates.push(input)
    }),
})
const it = testEffect(Layer.mergeAll(todoLayer, Truncate.defaultLayer, Agent.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_todo_test"),
  messageID: MessageID.make("msg_todo_test"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("TodoWriteTool", () => {
  it.instance("returns fixed model output while preserving title, metadata, and todo order", () =>
    Effect.gen(function* () {
      updates.length = 0
      const info = yield* TodoWriteTool
      const tool = yield* info.init()
      const todos: Todo.Info[] = [
        { content: "Keep first", status: "in_progress", priority: "high" },
        { content: "Keep second", status: "completed", priority: "low" },
      ]

      const result = yield* tool.execute({ todos }, ctx)

      expect(result.output).toBe("Todos updated.")
      expect(result.title).toBe("1 todos")
      expect(result.metadata.todos).toEqual(todos)
      expect(updates).toEqual([{ sessionID: ctx.sessionID, todos }])
    }),
  )
})
