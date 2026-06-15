import { applyEdits, modify, parse } from "jsonc-parser"
import { join, resolve } from "node:path"

import { createDefaultCommandRegistry } from "../commands/user-commands"
import { loadConfig, type LoadConfigOptions } from "../config/load"
import { getConfigPaths } from "../config/paths"
import { collectEnvironmentInfo } from "../diagnostics/environment"
import { runDependencyChecks } from "../diagnostics/dependency-checks"
import { createDiagnosticReport } from "../diagnostics/diagnostics"
import { createMcpService } from "../mcp/mcp-service"
import type { ModelProvider } from "../model/provider"
import { openOc2Database } from "../persistence/db"
import { RepositoryMemoryRepository } from "../persistence/repositories/memory"
import { createSessionRunService } from "../session/run"
import { createSessionService } from "../session/session-service"
import {
  exportTranscriptCollectionJson,
  exportTranscriptCollectionMarkdown,
  exportTranscriptJson,
  exportTranscriptMarkdown,
} from "../session/transcript"
import { createBuiltInToolRegistry } from "../tools/builtins/index"
import { launchTui, type TuiLaunchOptions } from "../tui/app"
import { VERSION } from "../version"
import { formatRootHelp, parseCommand, type ParsedCommand } from "./commands"
import {
  formatConfigPathText,
  formatConfigValue,
  formatDiagnosticsText,
  formatJson,
  formatMcpListText,
  formatMcpStatusText,
  formatRunJson,
  formatRunHelp,
  formatMemoryListText,
  formatSessionsListJson,
  formatSessionsListText,
  formatSlashCommandsText,
  formatToolsListText,
  formatVersionJson,
  formatVersionText,
} from "./output"

export interface CliStreams {
  stdout?: (text: string) => void | Promise<void>
  stderr?: (text: string) => void | Promise<void>
}

export interface CliOptions extends LoadConfigOptions {
  argv?: string[]
  streams?: CliStreams
  writeFile?: (path: string, contents: string) => Promise<void>
  modelProviders?: readonly ModelProvider[]
  tuiLauncher?: (options: TuiLaunchOptions) => Promise<void>
}

export interface CliResult {
  exitCode: number
}

/** Runs the oc2 CLI using injectable IO hooks for tests and embedding. */
export async function runCli(options: CliOptions = {}): Promise<CliResult> {
  const argv = options.argv ?? Bun.argv.slice(2)
  const streams = options.streams ?? {}
  const parsed = parseCommand(argv)

  if (!parsed.ok) {
    await writeStderr(streams.stderr, `${parsed.message}\n\n${formatRootHelp()}`)
    return { exitCode: 1 }
  }

  return executeCommand(parsed.command, options)
}

async function executeCommand(command: ParsedCommand, options: CliOptions): Promise<CliResult> {
  switch (command.name) {
    case "help":
      await writeStdout(options.streams?.stdout, formatRootHelp())
      return { exitCode: 0 }
    case "version":
      await writeStdout(
        options.streams?.stdout,
        command.json ? formatJson(formatVersionJson(VERSION)) : formatVersionText(VERSION),
      )
      return { exitCode: 0 }
    case "diagnostics":
      return diagnostics(command.json, options)
    case "config":
      return config(command, options)
    case "tools":
      return tools(command, options)
    case "mcp":
      return mcp(command, options)
    case "commands":
      return commands(command.json, options)
    case "sessions":
      return listSessions(command.json, options)
    case "memory":
      return memory(command, options)
    case "run":
      if (command.help) {
        await writeStdout(options.streams?.stdout, formatRunHelp())
        return { exitCode: 0 }
      }
      return runPrompt(command, undefined, options)
    case "resume":
      if (command.tui)
        return tui({ name: "tui", sessionId: command.sessionId, model: command.model, roots: command.roots }, options)
      return runPrompt(command, command.sessionId, options)
    case "tui":
      return tui(command, options)
    case "export":
      return exportSession(command, options)
  }
}

async function commands(json: boolean, options: CliOptions): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const paths = getConfigPaths(options)
  const registry = await createDefaultCommandRegistry({ config: loaded.config, paths, readFile: options.readFile })
  const listed = registry.list().map(({ name, description, aliases, source, subtask, agent, model }) => ({
    name,
    description,
    aliases: aliases ?? [],
    source,
    subtask: subtask ?? false,
    agent,
    model,
  }))
  await writeStdout(options.streams?.stdout, json ? formatJson({ commands: listed }) : formatSlashCommandsText(listed))
  return { exitCode: 0 }
}

async function exportSession(
  command: Extract<ParsedCommand, { name: "export" }>,
  options: CliOptions,
): Promise<CliResult> {
  const paths = getConfigPaths(options)
  const databasePath = join(paths.dataDir, "oc2.sqlite")
  const fileExists = options.fileExists ?? ((filePath: string) => Bun.file(filePath).exists())
  if (!(await fileExists(databasePath))) {
    await writeStderr(options.streams?.stderr, `Session not found: ${command.sessionId}\n`)
    return { exitCode: 1 }
  }
  const database = openOc2Database({ path: databasePath, readonly: true, migrate: false })
  try {
    const sessions = createSessionService({ database })
    const transcripts = sessions.collectTranscripts(command.sessionId, { recursive: command.recursive })
    if (transcripts.length === 0) {
      await writeStderr(options.streams?.stderr, `Session not found: ${command.sessionId}\n`)
      return { exitCode: 1 }
    }
    const root = transcripts[0]
    if (!root) return { exitCode: 1 }

    const output = command.recursive
      ? command.format === "json"
        ? exportTranscriptCollectionJson({ sessions: transcripts })
        : exportTranscriptCollectionMarkdown({ sessions: transcripts })
      : command.format === "json"
        ? exportTranscriptJson(root)
        : exportTranscriptMarkdown(root)
    await writeStdout(options.streams?.stdout, output)
    return { exitCode: 0 }
  } finally {
    database.close()
  }
}

async function mcp(command: Extract<ParsedCommand, { name: "mcp" }>, options: CliOptions): Promise<CliResult> {
  if (command.action === "list") {
    const loaded = await loadConfig(options)
    const paths = getConfigPaths(options)
    const registry = createBuiltInToolRegistry()
    const service = createMcpService({ config: loaded.config, registry, dataDir: paths.dataDir })
    await writeStdout(
      options.streams?.stdout,
      command.json ? formatJson({ servers: service.list() }) : formatMcpListText(service.list()),
    )
    return { exitCode: 0 }
  }

  if (command.action === "test") {
    const loaded = await loadConfig(options)
    const paths = getConfigPaths(options)
    const registry = createBuiltInToolRegistry()
    const service = createMcpService({ config: loaded.config, registry, dataDir: paths.dataDir })
    try {
      const status = await service.test(command.serverId)
      await writeStdout(
        options.streams?.stdout,
        command.json ? formatJson({ server: status }) : formatMcpStatusText(status),
      )
      return { exitCode: status.status === "connected" || status.status === "auth_required" ? 0 : 1 }
    } finally {
      await service.close()
    }
  }

  const loaded = await loadConfig(options)
  if (!loaded.config.mcp[command.serverId]) {
    await writeStderr(options.streams?.stderr, `MCP server not found: ${command.serverId}\n`)
    return { exitCode: 1 }
  }
  const paths = getConfigPaths(options)
  const path = paths.projectConfigPaths[0] ?? `${paths.cwd}/oc2.jsonc`
  const readFile = options.readFile ?? ((filePath: string) => Bun.file(filePath).text())
  const fileExists = options.fileExists ?? ((filePath: string) => Bun.file(filePath).exists())
  const writeFile =
    options.writeFile ?? ((filePath: string, contents: string) => Bun.write(filePath, contents).then(() => undefined))
  const existing = (await fileExists(path)) ? await readFile(path) : "{}\n"
  const updated = setJsoncPath(existing, `mcp.${command.serverId}.enabled`, command.action === "enable")
  await writeFile(path, updated)
  await writeStdout(
    options.streams?.stdout,
    command.json
      ? formatJson({ path, serverId: command.serverId, enabled: command.action === "enable" })
      : `${command.action === "enable" ? "Enabled" : "Disabled"} MCP server ${command.serverId} in ${path}\n`,
  )
  return { exitCode: 0 }
}

async function listSessions(json: boolean, options: CliOptions): Promise<CliResult> {
  const paths = getConfigPaths(options)
  const databasePath = join(paths.dataDir, "oc2.sqlite")
  const fileExists = options.fileExists ?? ((filePath: string) => Bun.file(filePath).exists())
  if (!(await fileExists(databasePath))) {
    await writeStdout(options.streams?.stdout, json ? formatJson({ sessions: [] }) : formatSessionsListText([]))
    return { exitCode: 0 }
  }
  const database = openOc2Database({ path: databasePath, readonly: true, migrate: false })
  try {
    const listed = createSessionService({ database }).listSessions()
    await writeStdout(
      options.streams?.stdout,
      json ? formatJson(formatSessionsListJson(listed)) : formatSessionsListText(listed),
    )
    return { exitCode: 0 }
  } finally {
    database.close()
  }
}

async function memory(command: Extract<ParsedCommand, { name: "memory" }>, options: CliOptions): Promise<CliResult> {
  const paths = getConfigPaths(options)
  const repository = resolve(paths.cwd, command.repository ?? paths.cwd)
  const databasePath = join(paths.dataDir, "oc2.sqlite")
  const fileExists = options.fileExists ?? ((filePath: string) => Bun.file(filePath).exists())
  if (!(await fileExists(databasePath))) {
    await writeStdout(
      options.streams?.stdout,
      command.json ? formatJson({ repository, logs: [] }) : formatMemoryListText([]),
    )
    return { exitCode: 0 }
  }
  const database = openOc2Database({ path: databasePath, readonly: true, migrate: false })
  try {
    const logs = new RepositoryMemoryRepository(database.sqlite).listRetrievalLogs(repository)
    await writeStdout(
      options.streams?.stdout,
      command.json ? formatJson({ repository, logs }) : formatMemoryListText(logs),
    )
    return { exitCode: 0 }
  } finally {
    database.close()
  }
}

async function tui(command: Extract<ParsedCommand, { name: "tui" }>, options: CliOptions): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const paths = getConfigPaths(options)
  const launcher = options.tuiLauncher ?? launchTui
  await launcher({
    config: loaded.config,
    cwd: paths.cwd,
    dataDir: paths.dataDir,
    sessionId: command.sessionId,
    model: command.model,
    roots: command.roots,
    providers: options.modelProviders,
    commands: await createDefaultCommandRegistry({ config: loaded.config, paths, readFile: options.readFile }),
  })
  return { exitCode: 0 }
}

async function diagnostics(json: boolean, options: CliOptions): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const dependencyDiagnostics = await runDependencyChecks(loaded.config)
  const report = createDiagnosticReport(collectEnvironmentInfo(options), [
    ...loaded.diagnostics,
    ...dependencyDiagnostics,
  ])
  await writeStdout(options.streams?.stdout, json ? formatJson(report) : formatDiagnosticsText(report))
  return { exitCode: report.diagnostics.some((diagnostic) => diagnostic.level === "error") ? 1 : 0 }
}

async function config(command: Extract<ParsedCommand, { name: "config" }>, options: CliOptions): Promise<CliResult> {
  if (command.action === "path") {
    const paths = getConfigPaths(options)
    const rows = [
      { name: "user", value: paths.userConfigPath },
      { name: "project", value: paths.projectConfigPaths.join(", ") },
      { name: "explicit", value: paths.explicitConfigPath ?? "" },
      { name: "data", value: paths.dataDir },
    ]
    await writeStdout(options.streams?.stdout, command.json ? formatJson(paths) : formatConfigPathText(rows))
    return { exitCode: 0 }
  }

  if (command.action === "get") {
    const loaded = await loadConfig(options)
    const value = command.key ? getPath(loaded.config, command.key) : loaded.config
    await writeStdout(options.streams?.stdout, formatConfigValue(value, command.json))
    return { exitCode: value === undefined ? 1 : 0 }
  }

  const paths = getConfigPaths(options)
  const path = paths.projectConfigPaths[0] ?? `${paths.cwd}/oc2.jsonc`
  const readFile = options.readFile ?? ((filePath: string) => Bun.file(filePath).text())
  const fileExists = options.fileExists ?? ((filePath: string) => Bun.file(filePath).exists())
  const writeFile =
    options.writeFile ?? ((filePath: string, contents: string) => Bun.write(filePath, contents).then(() => undefined))
  const existing = (await fileExists(path)) ? await readFile(path) : "{}\n"
  const updated = setJsoncPath(existing, command.key, parseConfigSetValue(command.value))
  await writeFile(path, updated)
  await writeStdout(
    options.streams?.stdout,
    command.json ? formatJson({ path, key: command.key }) : `Updated ${command.key} in ${path}\n`,
  )
  return { exitCode: 0 }
}

async function tools(command: Extract<ParsedCommand, { name: "tools" }>, options: CliOptions): Promise<CliResult> {
  if (command.action === "enable" || command.action === "disable") return setToolEnabled(command, options)
  const loaded = await loadConfig(options)
  const configuredTools = Object.entries(loaded.config.tools)
    .map(([name, tool]) => ({ name, enabled: tool.enabled }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  await writeStdout(
    options.streams?.stdout,
    command.json ? formatJson({ tools: configuredTools }) : formatToolsListText(configuredTools),
  )
  return { exitCode: 0 }
}

async function setToolEnabled(
  command: Extract<ParsedCommand, { name: "tools"; action: "enable" | "disable" }>,
  options: CliOptions,
): Promise<CliResult> {
  const paths = getConfigPaths(options)
  const path = paths.projectConfigPaths[0] ?? `${paths.cwd}/oc2.jsonc`
  const readFile = options.readFile ?? ((filePath: string) => Bun.file(filePath).text())
  const fileExists = options.fileExists ?? ((filePath: string) => Bun.file(filePath).exists())
  const writeFile =
    options.writeFile ?? ((filePath: string, contents: string) => Bun.write(filePath, contents).then(() => undefined))
  const existing = (await fileExists(path)) ? await readFile(path) : "{}\n"
  const enabled = command.action === "enable"
  await writeFile(path, setJsoncPath(existing, `tools.${command.toolName}.enabled`, enabled))
  await writeStdout(
    options.streams?.stdout,
    command.json
      ? formatJson({ path, toolName: command.toolName, enabled })
      : `${enabled ? "Enabled" : "Disabled"} tool ${command.toolName} in ${path}\n`,
  )
  return { exitCode: 0 }
}

type RunExecutionCommand =
  | Extract<ParsedCommand, { name: "run"; prompt: string }>
  | Extract<ParsedCommand, { name: "resume"; run: string }>

async function runPrompt(
  command: RunExecutionCommand,
  sessionId: string | undefined,
  options: CliOptions,
): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const paths = getConfigPaths(options)
  const effectiveConfig =
    command.name === "run" && (command.timeoutMs || command.maxConcurrency)
      ? {
          ...loaded.config,
          runtime: {
            ...loaded.config.runtime,
            defaultTimeoutMs: command.timeoutMs ?? loaded.config.runtime.defaultTimeoutMs,
            maxConcurrentTools: command.maxConcurrency ?? loaded.config.runtime.maxConcurrentTools,
            maxConcurrentSubAgents: command.maxConcurrency ?? loaded.config.runtime.maxConcurrentSubAgents,
            maxConcurrentTeamMembers: command.maxConcurrency ?? loaded.config.runtime.maxConcurrentTeamMembers,
          },
        }
      : loaded.config
  const service = createSessionRunService({
    config: effectiveConfig,
    cwd: paths.cwd,
    dataDir: paths.dataDir,
    providers: options.modelProviders,
    commands: await createDefaultCommandRegistry({ config: effectiveConfig, paths, readFile: options.readFile }),
  })
  try {
    const result = await service.run({
      prompt: command.name === "resume" ? command.run : command.prompt,
      sessionId,
      model: command.model,
      enabledTools: command.name === "run" ? command.tools : undefined,
      disabledTools: command.name === "run" ? command.disabledTools : undefined,
      enabledMcp: command.name === "run" ? command.mcp : undefined,
      disabledMcp: command.name === "run" ? command.disabledMcp : undefined,
      roots: command.name === "run" ? command.roots : undefined,
      team: command.name === "run" ? command.team : undefined,
      timeoutMs: command.name === "run" ? command.timeoutMs : undefined,
      maxConcurrency: command.name === "run" ? command.maxConcurrency : undefined,
    })
    await writeStdout(options.streams?.stdout, command.json ? formatJson(formatRunJson(result)) : `${result.text}\n`)
    return { exitCode: result.status === "completed" ? 0 : 1 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = {
      sessionId: sessionId ?? "",
      finalAssistantText: "",
      toolCalls: [],
      errors: [{ message }],
      usage: undefined,
      exitStatus: "failed",
    }
    if (command.json) {
      await writeStdout(options.streams?.stdout, formatJson(failed))
    } else {
      await writeStderr(options.streams?.stderr, `${message}\n`)
    }
    return { exitCode: 1 }
  } finally {
    service.database?.close()
  }
}

function getPath(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split(".")) {
    if (!part || current === null || typeof current !== "object" || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setJsoncPath(source: string, path: string, value: unknown): string {
  const parsed = parse(source)
  // jsonc-parser can apply edits only against object roots for dotted config paths.
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? source : "{}\n"
  const edits = modify(base, path.split("."), value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  const updated = applyEdits(base, edits)
  return updated.endsWith("\n") ? updated : `${updated}\n`
}

function parseConfigSetValue(value: string): unknown {
  const parsed = parse(value)
  return parsed === undefined && value !== "undefined" ? value : parsed
}

async function writeStdout(writer: ((text: string) => void | Promise<void>) | undefined, text: string): Promise<void> {
  if (writer) {
    await writer(text)
    return
  }
  await Bun.write(Bun.stdout, text)
}

async function writeStderr(writer: ((text: string) => void | Promise<void>) | undefined, text: string): Promise<void> {
  if (writer) {
    await writer(text)
    return
  }
  await Bun.write(Bun.stderr, text)
}
