import { expect, test } from "bun:test"

import type { TuiCommand } from "../../src/tui/client"
import { buildSlashMatches, buildTuiPaletteCommands, filterTuiPaletteCommands } from "../../src/tui/commands"
import { createInitialTuiState } from "../../src/tui/state"

test("builds enabled command palette entries from backed app and slash commands", () => {
  const commands = buildTuiPaletteCommands({
    clientCommands: [slashCommand("review", ["rev"]), { ...slashCommand("disabled"), enabled: false }],
    state: {
      ...createInitialTuiState(true),
      diagnostics: [{ message: "status exists" }],
      modelProviderCount: 1,
    },
    themeName: "opencode",
  })

  expect(commands.map((command) => command.id)).toEqual([
    "app.toggleSidebar",
    "status.open",
    "theme.list",
    "model.list",
    "session.new",
    "session.list",
    "slash.review",
  ])
  expect(commands.find((command) => command.id === "app.toggleSidebar")?.keybindings).toContain("<leader>b")
  expect(commands.find((command) => command.id === "slash.review")?.slashAliases).toEqual(["rev"])
})

test("includes backed app entries", () => {
  const commands = buildTuiPaletteCommands({
    clientCommands: [],
    state: createInitialTuiState(true),
    themeName: "opencode",
  })

  expect(commands.map((command) => command.id)).toEqual([
    "app.toggleSidebar",
    "status.open",
    "theme.list",
    "model.list",
    "session.new",
    "session.list",
  ])
})

test("filters command palette by title, keybinding, and slash alias", () => {
  const commands = buildTuiPaletteCommands({
    clientCommands: [slashCommand("review", ["rev"])],
    state: createInitialTuiState(true),
    themeName: "opencode",
  })

  expect(filterTuiPaletteCommands(commands, "side").map((command) => command.id)).toEqual(["app.toggleSidebar"])
  expect(filterTuiPaletteCommands(commands, "leader>n").map((command) => command.id)).toEqual(["session.new"])
  expect(filterTuiPaletteCommands(commands, "rev").map((command) => command.id)).toEqual(["slash.review"])
})

test("builds fuzzy slash matches from command names and aliases", () => {
  const matches = buildSlashMatches([slashCommand("review", ["rev"]), slashCommand("status")], "rv")

  expect(matches.map((match) => match.display)).toContain("/rev")
  expect(matches.map((match) => match.display)).toContain("/review")
  expect(matches.every((match) => match.source === "user")).toBe(true)
})

function slashCommand(name: string, aliases: readonly string[] = []): TuiCommand {
  return {
    id: name,
    title: name,
    category: "session",
    description: `${name} command`,
    slashName: name,
    slashAliases: aliases,
    source: "user",
    enabled: true,
  }
}
