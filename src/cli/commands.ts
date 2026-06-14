export type CommandName = "version" | "diagnostics" | "config" | "tools" | "run" | "resume" | "tui" | "help"

export type ParsedCommand =
  | { name: "version"; json: boolean }
  | { name: "diagnostics"; json: boolean }
  | { name: "config"; action: "path"; json: boolean }
  | { name: "config"; action: "get"; key?: string; json: boolean }
  | { name: "config"; action: "set"; key: string; value: string; json: boolean }
  | { name: "tools"; action: "list"; json: boolean }
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
    }
  | { name: "resume"; sessionId: string; run: string; json: boolean; model?: string }
  | { name: "tui"; sessionId?: string; model?: string }
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
  run: "Run a one-shot prompt",
  resume: "Resume a previous session",
  tui: "Open the interactive terminal UI",
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
    case "run":
      return parseRun(rest)
    case "resume":
      return parseResume(rest)
    case "tui":
      return parseTui(rest)
    default:
      if (!command.startsWith("-")) {
        return { ok: false, message: `Unknown command: ${command}` }
      }
      return { ok: false, message: `Unknown option: ${command}` }
  }
}

function parseTui(argv: string[]): ParseResult {
  const parsed = parseFlagValues(argv, new Set(), new Set(["--session", "--model"]))
  if (!parsed.ok) return parsed
  if (parsed.positionals.length > 0) return { ok: false, message: "tui does not accept positional arguments" }
  return {
    ok: true,
    command: { name: "tui", sessionId: parsed.values.get("--session")?.[0], model: parsed.values.get("--model")?.[0] },
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
  if (action !== "list") return { ok: false, message: "Expected tools list" }
  return parseNoPositionals("tools list", rest, { name: "tools", action: "list", json: hasFlag(rest, "--json") })
}

function parseRun(argv: string[]): ParseResult {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) return { ok: true, command: { name: "run", help: true } }
  const parsed = parseFlagValues(
    argv,
    new Set(["--json"]),
    new Set(["--model", "--tool", "--no-tool", "--mcp", "--no-mcp"]),
  )
  if (!parsed.ok) return parsed
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
    },
  }
}

function parseResume(argv: string[]): ParseResult {
  const parsed = parseFlagValues(argv, new Set(["--json"]), new Set(["--run", "--model"]))
  if (!parsed.ok) return parsed
  const [sessionId, ...extra] = parsed.positionals
  if (!sessionId || extra.length > 0) return { ok: false, message: "resume requires <session-id>" }
  const run = parsed.values.get("--run")?.[0]
  if (!run) return { ok: false, message: "resume requires --run <prompt> for non-interactive execution" }
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
