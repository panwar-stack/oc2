import { expect, test } from "bun:test"

import { createBuiltInToolRegistry } from "../../src/tools/builtins/index"
import { createToolExecutor } from "../../src/tools/execution"
import { ToolExecutionError } from "../../src/tools/tool"
import { readSkillContent } from "../../src/tools/builtins/skill"

test("built-in registry includes the skill tool", () => {
  expect(createBuiltInToolRegistry().get("skill")?.name).toBe("skill")
})

test("skill tool reads bundled skill markdown", async () => {
  const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
  const result = await executor.execute(
    { id: "skill", name: "skill", arguments: { name: "clarify" } },
    { workspaceRoots: [] },
  )

  expect(result).toMatchObject({ ok: true, output: { content: expect.stringContaining("# Clarify") } })
})

test("skill reader rejects traversal and nested paths", async () => {
  await expect(readSkillContent("../config")).rejects.toMatchObject({
    name: "ToolExecutionError",
    code: "invalid_skill_name",
  })
  await expect(readSkillContent("foo/bar")).rejects.toMatchObject({
    name: "ToolExecutionError",
    code: "invalid_skill_name",
  })
})

test("skill tool returns structured errors for invalid and missing skills", async () => {
  const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })

  await expect(
    executor.execute({ id: "traversal", name: "skill", arguments: { name: "../config" } }, { workspaceRoots: [] }),
  ).resolves.toMatchObject({ ok: false, error: { code: "invalid_skill_name" } })
  await expect(
    executor.execute({ id: "missing", name: "skill", arguments: { name: "missing" } }, { workspaceRoots: [] }),
  ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } })
})

test("skill reader exposes expected tool error type", async () => {
  await expect(readSkillContent("missing")).rejects.toBeInstanceOf(ToolExecutionError)
})
