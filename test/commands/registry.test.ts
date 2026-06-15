import { expect, test } from "bun:test"

import { createCommandRegistry } from "../../src/commands/registry"
import type { SlashCommand } from "../../src/commands/types"

const command = (input: Partial<SlashCommand> & Pick<SlashCommand, "name">): SlashCommand => ({
  description: `${input.name} description`,
  source: "builtin",
  template: `$ARGUMENTS ${input.name}`,
  ...input,
})

test("command registry gets registered commands by name and alias", () => {
  const registry = createCommandRegistry()
  const review = command({ name: "review", aliases: ["rev"] })

  registry.register(review)

  expect(registry.get("review")).toBe(review)
  expect(registry.get("rev")).toBe(review)
  expect(registry.list()).toEqual([review])
})

test("command registry overwrites by name and removes stale aliases", () => {
  const registry = createCommandRegistry([command({ name: "review", aliases: ["rev"] })])
  const replacement = command({ name: "review", aliases: ["check"] })

  registry.register(replacement)

  expect(registry.get("review")).toBe(replacement)
  expect(registry.get("check")).toBe(replacement)
  expect(registry.get("rev")).toBeUndefined()
  expect(registry.list()).toEqual([replacement])
})

test("command registry preserves aliases claimed by other commands", () => {
  const registry = createCommandRegistry([command({ name: "review", aliases: ["rev"] })])
  const revise = command({ name: "revise", aliases: ["rev"] })

  registry.register(revise)
  registry.register(command({ name: "review" }))

  expect(registry.get("rev")).toBe(revise)
})

test("command registry searches by exact prefix across names and aliases without duplicates", () => {
  const review = command({ name: "review", aliases: ["rev"] })
  const registry = createCommandRegistry([
    review,
    command({ name: "resume" }),
    command({ name: "clarify", aliases: ["revise"] }),
  ])

  expect(registry.search("rev").map((match) => match.name)).toEqual(["review", "clarify"])
  expect(registry.search("review")).toEqual([review])
  expect(registry.search("missing")).toEqual([])
})
