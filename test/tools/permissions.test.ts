import { expect, test } from "bun:test"

import { createRuntimeEventBus } from "../../src/events/event-bus"
import { createToolPermissionService } from "../../src/tools/permissions"

const request = { toolName: "write", action: "write", resource: "src/file.ts", callId: "call-1" }

test("permission rules use last matching wildcard decision", async () => {
  const permissions = createToolPermissionService({
    rules: [
      { match: "write:*", decision: "deny" },
      { match: "write:src/*", decision: "allow" },
    ],
  })

  await expect(permissions.decide(request, new AbortController().signal)).resolves.toBe("allow")
})

test("ask permissions emit request and resolved events", async () => {
  const events: string[] = []
  const bus = createRuntimeEventBus()
  bus.all((event) => events.push(event.type))
  const permissions = createToolPermissionService({
    events: bus,
    rules: [{ match: "write:*", decision: "ask" }],
    resolver: async () => ({ decision: "deny" }),
  })

  await expect(permissions.decide(request, new AbortController().signal)).resolves.toBe("deny")
  expect(events).toEqual(["permission.requested", "permission.resolved"])
})
