import { applyEdits, modify, parse } from "jsonc-parser"

import { loadConfig, type LoadConfigOptions } from "../config/load"
import { getConfigPaths } from "../config/paths"
import { collectEnvironmentInfo } from "../diagnostics/environment"
import { runDependencyChecks } from "../diagnostics/dependency-checks"
import { createDiagnosticReport } from "../diagnostics/diagnostics"
import type { ModelProvider } from "../model/provider"
import { createSessionRunService } from "../session/run"
import { VERSION } from "../version"
import { formatRootHelp, parseCommand, type ParsedCommand } from "./commands"
import {
  formatConfigPathText,
  formatConfigValue,
  formatDiagnosticsText,
  formatJson,
  formatRunJson,
  formatRunHelp,
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
      await writeStdout(options.streams?.stdout, command.json ? formatJson(formatVersionJson(VERSION)) : formatVersionText(VERSION))
      return { exitCode: 0 }
    case "diagnostics":
      return diagnostics(command.json, options)
    case "config":
      return config(command, options)
    case "tools":
      return tools(command.json, options)
    case "run":
      if (command.help) {
        await writeStdout(options.streams?.stdout, formatRunHelp())
        return { exitCode: 0 }
      }
      return runPrompt(command, undefined, options)
    case "resume":
      return runPrompt(command, command.sessionId, options)
  }
}

async function diagnostics(json: boolean, options: CliOptions): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const dependencyDiagnostics = await runDependencyChecks(loaded.config)
  const report = createDiagnosticReport(collectEnvironmentInfo(options), [...loaded.diagnostics, ...dependencyDiagnostics])
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
  const writeFile = options.writeFile ?? ((filePath: string, contents: string) => Bun.write(filePath, contents).then(() => undefined))
  const existing = (await fileExists(path)) ? await readFile(path) : "{}\n"
  const updated = setJsoncPath(existing, command.key, parseConfigSetValue(command.value))
  await writeFile(path, updated)
  await writeStdout(options.streams?.stdout, command.json ? formatJson({ path, key: command.key }) : `Updated ${command.key} in ${path}\n`)
  return { exitCode: 0 }
}

async function tools(json: boolean, options: CliOptions): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const configuredTools = Object.entries(loaded.config.tools)
    .map(([name, tool]) => ({ name, enabled: tool.enabled }))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  await writeStdout(options.streams?.stdout, json ? formatJson({ tools: configuredTools }) : formatToolsListText(configuredTools))
  return { exitCode: 0 }
}

type RunExecutionCommand = Extract<ParsedCommand, { name: "run"; prompt: string }> | Extract<ParsedCommand, { name: "resume" }>

async function runPrompt(command: RunExecutionCommand, sessionId: string | undefined, options: CliOptions): Promise<CliResult> {
  const loaded = await loadConfig(options)
  const paths = getConfigPaths(options)
  const service = createSessionRunService({
    config: loaded.config,
    cwd: paths.cwd,
    dataDir: paths.dataDir,
    providers: options.modelProviders,
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
    })
    await writeStdout(options.streams?.stdout, command.json ? formatJson(formatRunJson(result)) : `${result.text}\n`)
    return { exitCode: result.status === "completed" ? 0 : 1 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = { sessionId: sessionId ?? "", finalAssistantText: "", toolCalls: [], errors: [{ message }], usage: undefined, exitStatus: "failed" }
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
