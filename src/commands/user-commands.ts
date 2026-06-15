import { basename, dirname, join } from "node:path"

import type { Oc2Config } from "../config/schema"
import type { ConfigPaths } from "../config/paths"
import { createBuiltinCommands } from "./builtins"
import { createCommandRegistry } from "./registry"
import type { CommandRegistry, SlashCommand } from "./types"

export type CommandFileReader = (path: string) => Promise<string>

export interface DefaultCommandRegistryInput {
  readonly config: Pick<Oc2Config, "commands">
  readonly paths: Pick<ConfigPaths, "projectConfigPaths" | "userConfigPath" | "explicitConfigPath">
  readonly readFile?: CommandFileReader
}

export async function createDefaultCommandRegistry(input: DefaultCommandRegistryInput): Promise<CommandRegistry> {
  const registry = createCommandRegistry(createBuiltinCommands())
  const commandDirs = [
    ...input.paths.projectConfigPaths.map((path) => dirname(path)),
    ...(input.paths.explicitConfigPath ? [dirname(input.paths.explicitConfigPath)] : []),
    dirname(input.paths.userConfigPath),
  ]

  for (const command of await loadUserCommands(commandDirs, input.readFile)) registry.register(command)
  for (const [name, command] of Object.entries(input.config.commands ?? {})) {
    registry.register({
      name,
      description: command.description ?? name,
      aliases: command.aliases,
      source: "user",
      template: command.template ?? "",
      subtask: command.subtask,
      agent: command.agent,
      model: command.model,
    })
  }
  return registry
}

export async function loadUserCommands(
  paths: readonly string[],
  readFile: CommandFileReader = (path) => Bun.file(path).text(),
): Promise<readonly SlashCommand[]> {
  const commands: SlashCommand[] = []
  for (const root of paths) {
    for (const filePath of await listCommandFiles(root)) {
      const command = parseUserCommand(filePath, await readFile(filePath))
      if (command) commands.push(command)
    }
  }
  return commands
}

function parseUserCommand(filePath: string, source: string): SlashCommand | undefined {
  const name = basename(filePath, ".md")
  if (!name) return undefined
  const parsed = parseFrontmatter(source)
  return {
    name,
    description: asString(parsed.frontmatter.description) ?? name,
    aliases: asStringArray(parsed.frontmatter.aliases),
    source: "user",
    template: parsed.body,
    subtask: asBoolean(parsed.frontmatter.subtask),
    agent: asString(parsed.frontmatter.agent),
    model: asString(parsed.frontmatter.model),
  }
}

function parseFrontmatter(source: string): { readonly frontmatter: Record<string, unknown>; readonly body: string } {
  if (!source.startsWith("---\n")) return { frontmatter: {}, body: source }
  const end = source.indexOf("\n---", 4)
  if (end === -1) return { frontmatter: {}, body: source }
  return { frontmatter: parseFrontmatterBlock(source.slice(4, end)), body: source.slice(end + 4).replace(/^\r?\n/, "") }
}

function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const line of block.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    output[line.slice(0, separator).trim()] = parseFrontmatterValue(line.slice(separator + 1).trim())
  }
  return output
}

function parseFrontmatterValue(value: string): unknown {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => parseFrontmatterValue(item.trim()))
      .filter((item): item is string => typeof item === "string" && item.length > 0)
  }
  return value
}

async function listCommandFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  for (const dir of ["commands", "command"]) {
    const glob = new Bun.Glob("*.md")
    try {
      for await (const file of glob.scan({ cwd: join(root, dir), absolute: true, onlyFiles: true })) files.push(file)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }
  return files.toSorted()
}

const asString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)
const asStringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
