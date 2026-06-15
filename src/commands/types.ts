export interface SlashCommand {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** "tui" = client-side action | "builtin" = system command | "user" = config-defined | "skill" = from skill/*.md | "mcp" = from MCP prompts */
  readonly source: "tui" | "builtin" | "user" | "skill" | "mcp"
  /** Prompt template. `$ARGUMENTS` is replaced with user-provided arguments. Undefined for TUI-local commands. */
  readonly template?: string
  /** If true, wrap the expanded prompt in a subtask. */
  readonly subtask?: boolean
  /** Agent profile name override. */
  readonly agent?: string
  /** Model override (providerID/modelID). */
  readonly model?: string
  /** Only for TUI-local commands: synchronous handler. */
  readonly onExecute?: () => void
}

export interface CommandRegistry {
  /** Register a command. Later registrations for the same name overwrite. */
  register(command: SlashCommand): void
  /** Get a single command by name or alias. */
  get(name: string): SlashCommand | undefined
  /** List all registered commands. */
  list(): readonly SlashCommand[]
  /** List commands that only match by prefix (for autocomplete). */
  search(prefix: string): readonly SlashCommand[]
}
