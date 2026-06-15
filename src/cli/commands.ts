export type CommandName =
  | "version"
  | "diagnostics"
  | "config"
  | "tools"
  | "mcp"
  | "commands"
  | "sessions"
  | "memory"
  | "run"
  | "resume"
  | "tui"
  | "export"
  | "help"

export type ParsedCommand =
  | { name: "version"; json: boolean }
  | { name: "diagnostics"; json: boolean }
  | { name: "config"; action: "path"; json: boolean }
  | { name: "config"; action: "get"; key?: string; json: boolean }
  | { name: "config"; action: "set"; key: string; value: string; json: boolean }
  | { name: "tools"; action: "list"; json: boolean }
  | { name: "tools"; action: "enable" | "disable"; toolName: string; json: boolean }
  | { name: "mcp"; action: "list"; json: boolean }
  | { name: "mcp"; action: "enable" | "disable" | "test"; serverId: string; json: boolean }
  | { name: "commands"; json: boolean }
  | { name: "sessions"; action: "list"; json: boolean }
  | { name: "memory"; action: "list"; repository?: string; json: boolean }
  | { name: "run"; help: true }
  | {
      name: "run"
      help?: false
      prompt: string
      json: boolean
      model?: string
      tools: readonly string[]
      disabledTools: readonly string[]
      mcp: readonly string[]
      disabledMcp: readonly string[]
      roots: readonly string[]
      team: boolean
      timeoutMs?: number
      maxConcurrency?: number
    }
  | { name: "resume"; sessionId: string; run: string; tui?: false; json: boolean; model?: string }
  | { name: "resume"; sessionId: string; tui: true; json: boolean; model?: string; roots: readonly string[] }
  | { name: "tui"; sessionId?: string; model?: string; roots: readonly string[] }
  | { name: "export"; sessionId: string; format: "markdown" | "json"; recursive: boolean }
  | { name: "help" }

export interface ParseSuccess {
  ok: true
  command: ParsedCommand
}

export interface ParseFailure {
  ok: false
  message: string
}

export type ParseResult = ParseSuccess | ParseFailure

export const commandDescriptions = {
  version: "Print the oc2 version",
  diagnostics: "Print environment and configuration diagnostics",
  config: "Read or update oc2 configuration",
  tools: "List configured tools",
  mcp: "Manage MCP servers",
  commands: "List available slash commands",
  sessions: "List sessions from local database",
  memory: "List repository memory retrieval logs",
  run: "Run a one-shot prompt",
  resume: "Resume a previous session",
  tui: "Open the interactive terminal UI",
  export: "Export a session transcript",
} satisfies Record<Exclude<CommandName, "help">, string>

/** Parses top-level CLI arguments into command objects without performing side effects. */
export function parseCommand(argv: string[]): ParseResult {
  const [command = "help", ...rest] = argv

  switch (command) {
    case "--help":
    case "-h":
    case "help":
      return { ok: true, command: { name: "help" } }
    case "version":
      return parseNoPositionals("version", rest, { name: "version", json: hasFlag(rest, "--json") })
    case "diagnostics":
      return parseNoPositionals("diagnostics", rest, { name: "diagnostics", json: hasFlag(rest, "--json") })
    case "config":
      return parseConfig(rest)
    case "tools":
      return parseTools(rest)
    case "mcp":
      return parseMcp(rest)
    case "commands":
      return parseNoPositionals("commands", rest, { name: "commands", json: hasFlag(rest, "--json") })
    case "sessions":
      return parseSessions(rest)
    case "memory":
      return parseMemory(rest)
    case "run":
      return parseRun(rest)
    case "resume":
      return parseResume(rest)
    case "tui":
      return parseTui(rest)
    case "export":
      return parseExport(rest)
    default:
      if (!command.startsWith("-")) {
        return { ok: false, message: `Unknown command: ${command}` }
      }
      return { ok: false, message: `Unknown option: ${command}` }
  }
}

function parseExport(argv: string[]): ParseResult {
  const parsed = parseFlagValues(argv, new Set(["--recursive"]), new Set(["--format"]))
  if (!parsed.ok) return parsed
  const [sessionId, ...extra] = parsed.positionals
  if (!sessionId || extra.length > 0) return { ok: false, message: "export requires <session-id>" }
  const format = parsed.values.get("--format")?.[0]
  if (format !== "markdown" && format !== "json")
    return { ok: false, message: "export requires --format markdown|json" }
  return { ok: true, command: { name: "export", sessionId, format, recursive: parsed.booleans.has("--recursive") } }
}

function parseMcp(argv: string[]): ParseResult {
  const [action, ...rest] = argv
  const json = hasFlag(rest, "--json")
  const positionals = withoutKnownFlags(rest)

  switch (action) {
    case "list":
      return parseNoPositionals("mcp list", rest, { name: "mcp", action: "list", json })
    case "enable":
    case "disable":
    case "test":
      if (positionals.length !== 1) return { ok: false, message: `mcp ${action} requires <id>` }
      return { ok: true, command: { name: "mcp", action, serverId: positionals[0] ?? "", json } }
    default:
      return { ok: false, message: "Expected mcp list, mcp enable, mcp disable, or mcp test" }
  }
}

function parseSessions(argv: string[]): ParseResult {
  const [action, ...rest] = argv
  if (action !== "list") return { ok: false, message: "Expected sessions list" }
  return parseNoPositionals("sessions list", rest, { name: "sessions", action: "list", json: hasFlag(rest, "--json") })
}

function parseMemory(argv: string[]): ParseResult {
  const [action, ...rest] = argv
  if (action !== "list") return { ok: false, message: "Expected memory list" }
  const parsed = parseFlagValues(rest, new Set(["--json"]), new Set(["--repository"]))
  if (!parsed.ok) return parsed
  if (parsed.positionals.length > 0) return { ok: false, message: "memory list does not accept positional arguments" }
  return {
    ok: true,
    command: {
      name: "memory",
      action: "list",
      repository: parsed.values.get("--repository")?.[0],
      json: parsed.booleans.has("--json"),
    },
  }
}

function parseTui(argv: string[]): ParseResult {
  const parsed = parseFlagValues(argv, new Set(), new Set(["--session", "--model", "--root"]))
  if (!parsed.ok) return parsed
  if (parsed.positionals.length > 0) return { ok: false, message: "tui does not accept positional arguments" }
  return {
    ok: true,
    command: {
      name: "tui",
      sessionId: parsed.values.get("--session")?.[0],
      model: parsed.values.get("--model")?.[0],
      roots: parsed.values.get("--root") ?? [],
    },
  }
}

/** Formats the root help text shared by help output and parse errors. */
export function formatRootHelp(): string {
  return [
    "Usage: oc2 <command> [options]",
    "",
    "Commands:",
    ...Object.entries(commandDescriptions).map(([name, description]) => `  ${name.padEnd(12)} ${description}`),
    "",
    "Use oc2 run --help for run command options.",
    "",
  ].join("\n")
}

function parseConfig(argv: string[]): ParseResult {
  const [action, ...rest] = argv
  const json = hasFlag(rest, "--json")
  const positionals = withoutKnownFlags(rest)

  switch (action) {
    case "path":
      return parseNoPositionals("config path", rest, { name: "config", action: "path", json })
    case "get":
      if (positionals.length > 1) return { ok: false, message: "config get accepts at most one key" }
      return { ok: true, command: { name: "config", action: "get", key: positionals[0], json } }
    case "set":
      if (positionals.length !== 2) return { ok: false, message: "config set requires <key> <value>" }
      return {
        ok: true,
        command: { name: "config", action: "set", key: positionals[0] ?? "", value: positionals[1] ?? "", json },
      }
    default:
      return { ok: false, message: "Expected config path, config get, or config set" }
  }
}

function parseTools(argv: string[]): ParseResult {
  const [action, ...rest] = argv
  if (action === "list")
    return parseNoPositionals("tools list", rest, { name: "tools", action: "list", json: hasFlag(rest, "--json") })
  if (action === "enable" || action === "disable") {
    const json = hasFlag(rest, "--json")
    const positionals = withoutKnownFlags(rest)
    if (positionals.length !== 1) return { ok: false, message: `tools ${action} requires <name>` }
    return { ok: true, command: { name: "tools", action, toolName: positionals[0] ?? "", json } }
  }
  return { ok: false, message: "Expected tools list, tools enable, or tools disable" }
}

function parseRun(argv: string[]): ParseResult {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) return { ok: true, command: { name: "run", help: true } }
  const parsed = parseFlagValues(
    argv,
    new Set(["--json", "--team"]),
    new Set(["--model", "--tool", "--no-tool", "--mcp", "--no-mcp", "--root", "--timeout", "--max-concurrency"]),
  )
  if (!parsed.ok) return parsed
  const timeoutMs = parsePositiveIntFlag(parsed, "--timeout")
  if (!timeoutMs.ok) return timeoutMs
  const maxConcurrency = parsePositiveIntFlag(parsed, "--max-concurrency")
  if (!maxConcurrency.ok) return maxConcurrency
  if (parsed.positionals.length === 0) return { ok: false, message: "run requires <prompt>" }
  return {
    ok: true,
    command: {
      name: "run",
      prompt: parsed.positionals.join(" "),
      json: parsed.booleans.has("--json"),
      model: parsed.values.get("--model")?.[0],
      tools: parsed.values.get("--tool") ?? [],
      disabledTools: parsed.values.get("--no-tool") ?? [],
      mcp: parsed.values.get("--mcp") ?? [],
      disabledMcp: parsed.values.get("--no-mcp") ?? [],
      roots: parsed.values.get("--root") ?? [],
      team: parsed.booleans.has("--team"),
      timeoutMs: timeoutMs.value,
      maxConcurrency: maxConcurrency.value,
    },
  }
}

function parseResume(argv: string[]): ParseResult {
  const parsed = parseFlagValues(argv, new Set(["--json", "--tui"]), new Set(["--run", "--model", "--root"]))
  if (!parsed.ok) return parsed
  const [sessionId, ...extra] = parsed.positionals
  if (!sessionId || extra.length > 0) return { ok: false, message: "resume requires <session-id>" }
  const run = parsed.values.get("--run")?.[0]
  const useTui = parsed.booleans.has("--tui")
  if (run && useTui) return { ok: false, message: "resume accepts either --run or --tui, not both" }
  if (useTui) {
    return {
      ok: true,
      command: {
        name: "resume",
        sessionId,
        tui: true,
        json: parsed.booleans.has("--json"),
        model: parsed.values.get("--model")?.[0],
        roots: parsed.values.get("--root") ?? [],
      },
    }
  }
  if (!run) return { ok: false, message: "resume requires --run <prompt> or --tui" }
  return {
    ok: true,
    command: {
      name: "resume",
      sessionId,
      run,
      json: parsed.booleans.has("--json"),
      model: parsed.values.get("--model")?.[0],
    },
  }
}

function parsePositiveIntFlag(parsed: ParsedFlags, flag: string): { ok: true; value?: number } | ParseFailure {
  const value = parsed.values.get(flag)?.[0]
  if (value === undefined) return { ok: true }
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) return { ok: false, message: `${flag} must be a positive integer` }
  return { ok: true, value: number }
}

function parseNoPositionals(commandName: string, argv: string[], command: ParsedCommand): ParseResult {
  const unknownFlag = argv.find((arg) => arg.startsWith("-") && arg !== "--json")
  if (unknownFlag) return { ok: false, message: `Unknown option for ${commandName}: ${unknownFlag}` }
  if (withoutKnownFlags(argv).length > 0)
    return { ok: false, message: `${commandName} does not accept positional arguments` }
  return { ok: true, command }
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag)
}

function withoutKnownFlags(argv: string[]): string[] {
  return argv.filter((arg) => arg !== "--json" && arg !== "--help" && arg !== "-h")
}

interface ParsedFlags {
  readonly ok: true
  readonly positionals: readonly string[]
  readonly booleans: ReadonlySet<string>
  readonly values: ReadonlyMap<string, readonly string[]>
}

function parseFlagValues(
  argv: string[],
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): ParsedFlags | ParseFailure {
  const positionals: string[] = []
  const booleans = new Set<string>()
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    if (booleanFlags.has(arg)) {
      booleans.add(arg)
      continue
    }
    if (valueFlags.has(arg)) {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) return { ok: false, message: `${arg} requires a value` }
      values.set(arg, [...(values.get(arg) ?? []), value])
      index += 1
      continue
    }
    if (arg.startsWith("-")) return { ok: false, message: `Unknown option: ${arg}` }
    positionals.push(arg)
  }
  return { ok: true, positionals, booleans, values }
}
