import { expect, test } from "bun:test"

import { createBuiltinCommands } from "../../src/commands/builtins"
import { resolveCommandTemplate } from "../../src/commands/resolver"

test("built-in slash commands include review and skill-backed commands", () => {
  const commands = createBuiltinCommands()
  const byName = new Map(commands.map((command) => [command.name, command]))

  expect(commands.map((command) => command.name)).toEqual([
    "review",
    "clarify",
    "spec-planner",
    "spec-implement",
    "team-report",
    "init",
  ])
  expect(byName.get("review")).toMatchObject({ source: "builtin", subtask: true })
  expect(byName.get("review")?.template).toContain("$ARGUMENTS")
  expect(byName.get("clarify")?.template).toBe("skill:clarify")
  expect(byName.get("spec-planner")?.template).toBe("skill:spec-planner")
  expect(byName.get("spec-implement")?.template).toBe("skill:spec-implement")
  expect(byName.get("team-report")?.template).toBe("skill:team-report")
  expect(byName.get("init")?.template).toBe("skill:initialize")
})

test("command resolver substitutes arguments and applies subtask marker", async () => {
  const review = createBuiltinCommands().find((command) => command.name === "review")

  await expect(resolveCommandTemplate(review!, "diff --git a/file b/file")).resolves.toContain(
    "[SUBTASK] Review the following code changes",
  )
  await expect(resolveCommandTemplate(review!, "diff --git a/file b/file")).resolves.toContain(
    "diff --git a/file b/file",
  )
  await expect(resolveCommandTemplate(review!, "")).resolves.not.toContain("$ARGUMENTS")
})

test("command resolver handles empty args and loads skill templates", async () => {
  const clarify = createBuiltinCommands().find((command) => command.name === "clarify")
  const resolved = await resolveCommandTemplate(clarify!, "")

  expect(resolved).toContain("# Clarify")
  expect(resolved).not.toContain("$ARGUMENTS")
})
