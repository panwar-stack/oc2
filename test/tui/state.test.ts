import { expect, test } from "bun:test"

import { appendLocalMessage, applyTuiEvent, completeTuiRun, createInitialTuiState, failTuiRun, hydrateTuiState, toggleSidePanel } from "../../src/tui/state"
import { RuntimeError } from "../../src/events/events"

test("projects model streaming into an assistant message", () => {
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, { id: "1", timestamp: new Date(), type: "model.started", payload: { sessionId: "s1", taskId: "m1", model: "test" } })
  state = applyTuiEvent(state, { id: "2", timestamp: new Date(), type: "model.delta", payload: { sessionId: "s1", taskId: "m1", delta: "hello" } })
  state = applyTuiEvent(state, { id: "3", timestamp: new Date(), type: "model.delta", payload: { sessionId: "s1", taskId: "m1", delta: " world" } })

  expect(state.running).toBe(true)
  expect(state.streamingText).toBe("hello world")

  state = applyTuiEvent(state, { id: "4", timestamp: new Date(), type: "model.completed", payload: { sessionId: "s1", taskId: "m1" } })

  expect(state.running).toBe(false)
  expect(state.streamingText).toBe("")
  expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "hello world", status: "completed" })
})

test("projects tool status and errors", () => {
  const error = new RuntimeError({ code: "task_failed", message: "denied", kind: "tool" }).toJSON()
  let state = createInitialTuiState(true)
  state = applyTuiEvent(state, { id: "1", timestamp: new Date(), type: "tool.started", payload: { sessionId: "s1", taskId: "t1", toolName: "bash" } })
  state = applyTuiEvent(state, { id: "2", timestamp: new Date(), type: "tool.failed", payload: { sessionId: "s1", taskId: "t1", toolName: "bash", error } })

  expect(state.toolCalls).toEqual([{ id: "t1", name: "bash", status: "failed", error: "denied" }])
})

test("toggles side panel and hydrates persisted transcript", () => {
  const state = hydrateTuiState(toggleSidePanel(createInitialTuiState(true)), [
    {
      id: "m1",
      sessionId: "s1",
      role: "user",
      createdAt: "now",
      updatedAt: "now",
      parts: [{ type: "text", text: "hello" }],
      status: "completed",
    },
  ], [])

  expect(state.sidePanel).toBe(false)
  expect(state.sessionId).toBe("s1")
  expect(state.messages).toEqual([{ id: "m1", role: "user", text: "hello", status: "completed" }])
})

test("runtime events preserve hydrated and locally submitted messages", () => {
  let state = hydrateTuiState(createInitialTuiState(true), [
    {
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      createdAt: "now",
      updatedAt: "now",
      parts: [{ type: "text", text: "previous" }],
      status: "completed",
    },
  ], [])
  state = appendLocalMessage(state, "user", "next")
  state = applyTuiEvent(state, { id: "1", timestamp: new Date(), type: "model.started", payload: { sessionId: "s1", taskId: "m2", model: "test" } })

  expect(state.messages.map((message) => message.text)).toEqual(["previous", "next"])
})

test("run completion helpers preserve cancellation and surface submit errors", () => {
  const running = { ...createInitialTuiState(true), running: true, status: "running" as const }

  expect(completeTuiRun(running, { sessionId: "s1", status: "failed" }, true)).toMatchObject({ running: false, status: "cancelled" })

  const failed = failTuiRun(running, new Error("bad resume"), false)
  expect(failed).toMatchObject({ running: false, status: "failed" })
  expect(failed.errors).toEqual(["bad resume"])
})
