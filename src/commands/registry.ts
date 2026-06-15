import type { CommandRegistry, SlashCommand } from "./types"

export const createCommandRegistry = (commands: readonly SlashCommand[] = []): CommandRegistry => {
  const byName = new Map<string, SlashCommand>()
  const aliases = new Map<string, string>()

  const registry: CommandRegistry = {
    register(command) {
      const existing = byName.get(command.name)
      if (existing) {
        for (const alias of existing.aliases ?? []) {
          if (aliases.get(alias) === command.name) aliases.delete(alias)
        }
      }

      byName.set(command.name, command)
      for (const alias of command.aliases ?? []) aliases.set(alias, command.name)
    },

    get(name) {
      return byName.get(name) ?? byName.get(aliases.get(name) ?? "")
    },

    list() {
      return [...byName.values()]
    },

    search(prefix) {
      const matches = new Map<string, SlashCommand>()
      for (const command of byName.values()) {
        if (command.name.startsWith(prefix) || (command.aliases ?? []).some((alias) => alias.startsWith(prefix))) {
          matches.set(command.name, command)
        }
      }
      return [...matches.values()]
    },
  }

  for (const command of commands) registry.register(command)
  return registry
}
