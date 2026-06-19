import fuzzysort from "fuzzysort"

import type { TuiCommand } from "./client"
import type { SlashMatch, TuiState } from "./state"

export type TuiPaletteCommandId =
  | "app.toggleSidebar"
  | "status.open"
  | "theme.list"
  | "model.list"
  | "session.new"
  | "session.list"

export interface TuiPaletteCommand extends TuiCommand {
  readonly id: TuiPaletteCommandId | string
}

export interface TuiPaletteCommandInput {
  readonly clientCommands: readonly TuiCommand[]
  readonly state: TuiState
  readonly themeName: string
}

interface SlashEntry {
  readonly name: string
  readonly commandName: string
  readonly display: string
  readonly description: string
  readonly source: SlashMatch["source"]
}

export function buildTuiPaletteCommands(input: TuiPaletteCommandInput): readonly TuiPaletteCommand[] {
  const backedCommands: readonly TuiPaletteCommand[] = [
    {
      id: "app.toggleSidebar",
      title: "Toggle Sidebar",
      category: "app",
      description: "Show or hide the session sidebar",
      keybindings: ["<leader>b", "ctrl+b"],
      enabled: true,
    },
    {
      id: "status.open",
      title: "Show Status",
      category: "status",
      description: "Show current diagnostics and runtime status",
      keybindings: ["<leader>s"],
      enabled: true,
    },
    {
      id: "theme.list",
      title: "Theme List",
      category: "theme",
      description: `Current theme: ${input.themeName}`,
      keybindings: ["<leader>t"],
      enabled: true,
    },
    {
      id: "model.list",
      title: "Model List",
      category: "model",
      description: "Open configured model options",
      keybindings: ["<leader>m"],
      enabled: true,
    },
    {
      id: "session.new",
      title: "New Session",
      category: "session",
      description: "Clear the current prompt and start a new session on next submit",
      keybindings: ["<leader>n"],
      enabled: true,
    },
    {
      id: "session.list",
      title: "Session List",
      category: "session",
      description: "Open persisted sessions",
      keybindings: ["<leader>l"],
      enabled: true,
    },
  ]

  const slashCommands = input.clientCommands
    .filter((command) => command.enabled)
    .map((command) => ({ ...command, id: `slash.${command.id}` }))

  return [...backedCommands, ...slashCommands].filter((command) => command.enabled)
}

export function filterTuiPaletteCommands(
  commands: readonly TuiPaletteCommand[],
  query: string,
): readonly TuiPaletteCommand[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return commands
  return commands.filter((command) =>
    [
      command.title,
      command.description,
      command.category,
      command.slashName,
      ...(command.slashAliases ?? []),
      ...(command.keybindings ?? []),
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalized)),
  )
}

export function buildSlashMatches(commands: readonly TuiCommand[], query: string): readonly SlashMatch[] {
  const entries: SlashEntry[] = commands.flatMap((command) => {
    if (!command.enabled || !command.slashName) return []
    return [command.slashName, ...(command.slashAliases ?? [])].map((name) => ({
      name,
      commandName: command.slashName!,
      display: `/${name}`,
      description: command.description ?? command.title,
      source: command.source ?? (command.category === "app" ? "tui" : "user"),
    }))
  })
  const normalized = query.trim()
  if (!normalized) return entries.map(toSlashMatch)
  return fuzzysort
    .go(normalized, entries, { keys: ["name", "commandName", "description"] })
    .map((result) => toSlashMatch(result.obj))
}

export function resolveSlashCommand(commands: readonly TuiCommand[], name: string): TuiCommand | undefined {
  return commands.find(
    (command) =>
      command.enabled && command.slashName && (command.slashName === name || command.slashAliases?.includes(name)),
  )
}

function toSlashMatch(input: SlashEntry): SlashMatch {
  return {
    name: input.name,
    display: input.display,
    description: input.description,
    source: input.source,
  }
}
