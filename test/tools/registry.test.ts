import { expect, test } from "bun:test"

import { createBuiltInToolRegistry } from "../../src/tools/builtins/index"
import { createToolRegistry } from "../../src/tools/registry"

test("built-in registry exposes shipped tools as model definitions", () => {
  const registry = createBuiltInToolRegistry()
  const names = registry
    .materialize()
    .map((tool) => tool.name)
    .toSorted()

  expect(names).toEqual([
    "apply_patch",
    "bash",
    "edit",
    "glob",
    "grep",
    "memory",
    "opengrep",
    "question",
    "read",
    "skill",
    "todowrite",
    "webfetch",
    "write",
  ])
  expect(registry.materialize().every((tool) => typeof tool.inputSchema === "object")).toBe(true)
})

test("registry filters disabled tools and returns structured unknown tool errors", () => {
  const registry = createBuiltInToolRegistry()

  expect(registry.list({ tools: { bash: { enabled: false } } }).some((tool) => tool.name === "bash")).toBe(false)
  expect(createToolRegistry().unknown({ id: "call-1", name: "missing", arguments: {} })).toMatchObject({
    ok: false,
    error: { code: "unknown_tool" },
  })
})
