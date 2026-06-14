import { expect, test } from "bun:test"
import { createRuntimeEventBus } from "../../src/events/event-bus"
import { createEmptyRuntimeProjection, runtimeProjectionProjector } from "../../src/events/projector"
import type { RuntimeEvent } from "../../src/events/events"

test("runtime event bus publishes typed and wildcard events", () => {
  const bus = createRuntimeEventBus()
  const typed: RuntimeEvent[] = []
  const all: RuntimeEvent[] = []

  bus.subscribe("diagnostic.warning", (event) => typed.push(event))
  bus.all((event) => all.push(event))

  const event = bus.publish({ type: "diagnostic.warning", payload: { message: "careful", code: "test" } })

  expect(event.id).toBeString()
  expect(typed).toHaveLength(1)
  expect(all).toHaveLength(1)
  expect(typed[0]?.payload).toEqual({ message: "careful", code: "test" })
})

test("runtime event bus unsubscribe removes listeners", () => {
  const bus = createRuntimeEventBus()
  let calls = 0
  const unsubscribe = bus.subscribe("error", () => {
    calls += 1
  })

  unsubscribe()
  bus.publish({
    type: "error",
    payload: { error: { name: "RuntimeError", code: "unknown", message: "boom", recoverable: false } },
  })

  expect(calls).toBe(0)
})

test("runtime event projector runs before listeners", () => {
  const bus = createRuntimeEventBus({
    initialState: createEmptyRuntimeProjection(),
    projector: runtimeProjectionProjector,
  })
  const countsSeenByListener: number[] = []

  bus.subscribe("scheduler.task.updated", () => {
    countsSeenByListener.push(bus.getState().counts["scheduler.task.updated"] ?? 0)
  })

  bus.publish({
    type: "scheduler.task.updated",
    payload: { taskId: "task-1", kind: "tool", status: "queued" },
  })

  expect(countsSeenByListener).toEqual([1])
  expect(bus.getState().latestByType["scheduler.task.updated"]?.payload).toEqual({
    taskId: "task-1",
    kind: "tool",
    status: "queued",
  })
})

test("runtime event bus isolates listener failures", () => {
  const listenerErrors: unknown[] = []
  const bus = createRuntimeEventBus({ onListenerError: (error) => listenerErrors.push(error) })
  let secondListenerCalled = false

  bus.subscribe("diagnostic.warning", () => {
    throw new Error("listener failed")
  })
  bus.subscribe("diagnostic.warning", () => {
    secondListenerCalled = true
  })

  bus.publish({ type: "diagnostic.warning", payload: { message: "careful" } })

  expect(listenerErrors).toHaveLength(1)
  expect(secondListenerCalled).toBe(true)
})
