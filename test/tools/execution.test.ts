import { expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { z } from "zod"

import { createRuntimeEventBus, type RuntimeEventBus } from "../../src/events/event-bus"
import { createTaskScheduler } from "../../src/scheduler/scheduler"
import { createToolExecutor } from "../../src/tools/execution"
import { createToolPermissionService } from "../../src/tools/permissions"
import { createToolRegistry } from "../../src/tools/registry"
import type { ToolDefinition } from "../../src/tools/tool"
import { createTempWorkspace } from "./helpers"

const createScheduler = (timeoutMs = 1_000, events?: RuntimeEventBus<unknown>) =>
  createTaskScheduler({
    defaultTimeoutMs: timeoutMs,
    events,
    limits: { model: 1, tool: 1, mcp: 1, subagent: 1, "team-member": 1 },
  })

test("executor validates schema, schedules execution, bounds output, and emits events", async () => {
  const workspace = await createTempWorkspace()
  try {
    const events: string[] = []
    const bus = createRuntimeEventBus()
    bus.all((event) => events.push(event.type))
    const registry = createToolRegistry([
      {
        name: "big",
        description: "big output",
        inputSchema: z.object({ value: z.string() }),
        modelInputSchema: { type: "object" },
        execute: (input) => `${input.value}\n`.repeat(10),
      } satisfies ToolDefinition<{ value: string }>,
    ])
    const executor = createToolExecutor({ registry, scheduler: createScheduler(1_000, bus), events: bus, outputBounds: { maxChars: 8, maxLines: 3 } })

    const invalid = await executor.execute({ id: "invalid", name: "big", arguments: {} }, { workspaceRoots: [workspace.root] })
    const result = await executor.execute({ id: "call-1", name: "big", arguments: { value: "x" } }, { workspaceRoots: [workspace.root] })

    expect(invalid).toMatchObject({ ok: false, error: { code: "validation_failed" } })
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(events).toContain("tool.started")
    expect(events).toContain("tool.completed")
    expect(events).toContain("tool.failed")
    expect(events).toContain("scheduler.task.updated")
  } finally {
    await workspace.cleanup()
  }
})

test("executor returns denied and timed out tools as structured tool errors", async () => {
  const workspace = await createTempWorkspace()
  try {
    const registry = createToolRegistry([
      {
        name: "slow",
        description: "slow tool",
        inputSchema: z.object({}),
        modelInputSchema: { type: "object" },
        permission: { action: "execute", resource: () => "slow" },
        async execute(_input, context) {
          await new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }))
        },
      } satisfies ToolDefinition<Record<string, never>>,
    ])

    const denied = await createToolExecutor({
      registry,
      permissions: createToolPermissionService({ rules: [{ match: "execute:*", decision: "deny" }] }),
    }).execute({ id: "denied", name: "slow", arguments: {} }, { workspaceRoots: [workspace.root] })
    const timedOut = await createToolExecutor({ registry, scheduler: createScheduler(5) }).execute({ id: "timeout", name: "slow", arguments: {} }, { workspaceRoots: [workspace.root] })

    expect(denied).toMatchObject({ ok: false, error: { code: "permission_denied" } })
    expect(timedOut).toMatchObject({ ok: false, error: { code: "timed_out" } })
  } finally {
    await workspace.cleanup()
  }
})

test("executor applies config-backed permission rules", async () => {
  const workspace = await createTempWorkspace()
  try {
    const registry = createToolRegistry([
      {
        name: "write",
        description: "write test",
        inputSchema: z.object({ filePath: z.string() }),
        modelInputSchema: { type: "object" },
        permission: { action: "write", resource: (input) => input.filePath },
        execute: () => ({ wrote: true }),
      } satisfies ToolDefinition<{ filePath: string }>,
    ])
    const executor = createToolExecutor({
      registry,
      config: {
        tools: { write: { enabled: true, permissions: [{ match: "write:*", decision: "deny" }] } },
        runtime: { defaultTimeoutMs: 1_000, maxConcurrentSubAgents: 1, maxConcurrentTeamMembers: 1, maxConcurrentTools: 1, logLevel: "info" },
      },
    })

    await expect(executor.execute({ id: "config-denied", name: "write", arguments: { filePath: "a.txt" } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } })
  } finally {
    await workspace.cleanup()
  }
})

test("executor enforces config permissions even with an injected permission service", async () => {
  const workspace = await createTempWorkspace()
  try {
    const registry = createToolRegistry([
      {
        name: "write",
        description: "write test",
        inputSchema: z.object({ filePath: z.string() }),
        modelInputSchema: { type: "object" },
        permission: { action: "write", resource: (input) => input.filePath },
        execute: () => ({ wrote: true }),
      } satisfies ToolDefinition<{ filePath: string }>,
    ])
    const executor = createToolExecutor({
      registry,
      permissions: createToolPermissionService(),
      config: {
        tools: { write: { enabled: true, permissions: [{ match: "write:*", decision: "deny" }] } },
        runtime: { defaultTimeoutMs: 1_000, maxConcurrentSubAgents: 1, maxConcurrentTeamMembers: 1, maxConcurrentTools: 1, logLevel: "info" },
      },
    })

    await expect(executor.execute({ id: "config-denied-injected", name: "write", arguments: { filePath: "a.txt" } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } })
  } finally {
    await workspace.cleanup()
  }
})

test("executor does not duplicate injected permission prompts for config ask rules", async () => {
  const workspace = await createTempWorkspace()
  try {
    let promptCount = 0
    const registry = createToolRegistry([
      {
        name: "write",
        description: "write test",
        inputSchema: z.object({ filePath: z.string() }),
        modelInputSchema: { type: "object" },
        permission: { action: "write", resource: (input) => input.filePath },
        execute: () => ({ wrote: true }),
      } satisfies ToolDefinition<{ filePath: string }>,
    ])
    const executor = createToolExecutor({
      registry,
      permissions: { decide: async () => {
        promptCount += 1
        return "allow"
      } },
      config: {
        tools: { write: { enabled: true, permissions: [{ match: "write:*", decision: "ask" }] } },
        runtime: { defaultTimeoutMs: 1_000, maxConcurrentSubAgents: 1, maxConcurrentTeamMembers: 1, maxConcurrentTools: 1, logLevel: "info" },
      },
    })

    await expect(executor.execute({ id: "config-ask", name: "write", arguments: { filePath: "a.txt" } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: true })
    expect(promptCount).toBe(1)
  } finally {
    await workspace.cleanup()
  }
})

test("root checks accept canonical root aliases for legitimate paths", async () => {
  const workspace = await createTempWorkspace()
  try {
    const canonical = await realpath(workspace.path)
    const registry = createToolRegistry([
      {
        name: "touch",
        description: "touch test",
        inputSchema: z.object({ filePath: z.string() }),
        modelInputSchema: { type: "object" },
        execute: async (input, context) => {
          const { resolveWorkspacePath } = await import("../../src/tools/roots")
          return resolveWorkspacePath(input.filePath, context.workspaceRoots, { cwd: context.cwd, writable: true })
        },
      } satisfies ToolDefinition<{ filePath: string }>,
    ])
    const executor = createToolExecutor({ registry })

    await expect(
      executor.execute(
        { id: "canonical", name: "touch", arguments: { filePath: "nested/file.txt" } },
        { workspaceRoots: [{ ...workspace.root, path: canonical }], cwd: workspace.path },
      ),
    ).resolves.toMatchObject({ ok: true })
  } finally {
    await workspace.cleanup()
  }
})
