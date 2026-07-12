#!/usr/bin/env bun
import path from "node:path"
import { existsSync } from "node:fs"

import { Info as TuiConfig } from "@oc2-ai/tui/config"
import { TuiKeybind } from "@oc2-ai/tui/config/keybind"
import { Info as Oc2Config } from "../src/config/config"
import { ConfigParse } from "../src/config/parse"

const root = path.resolve(import.meta.dir, "../../..")
process.chdir(root)

async function commandHelp(args: string[]) {
  const command = Bun.spawn(["bun", "run", "--conditions=browser", "src/index.ts", ...args, "--help"], {
    cwd: path.join(root, "packages/opencode"),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ])
  if (exit !== 0) throw new Error(`failed to read oc2 ${args.join(" ")} --help output`)
  return `${stdout}\n${stderr}`
}

const markdownFiles = ["README.md", ...new Bun.Glob("docs/**/*.md").scanSync()].sort()
const prettier = Bun.spawn(["bunx", "prettier", "--check", ...markdownFiles], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await prettier.exited) !== 0) process.exit(1)

const helpText = await commandHelp([])
if (!helpText.includes("Commands:")) throw new Error("oc2 --help output did not contain commands")

const cliReference = await Bun.file("docs/cli.md").text()
const cliDocumentation = `${cliReference}\n${await Bun.file("docs/extensions.md").text()}`
const cliSource = await Bun.file("packages/opencode/src/index.ts").text()
const documentedCommands = new Set([...cliReference.matchAll(/^\| `oc2 ([a-z][\w-]*)/gm)].map((match) => match[1]))
const helpCommands = new Set([...helpText.matchAll(/^\s+oc2 ([a-z][\w-]*)/gm)].map((match) => match[1]))
const commandNames = [...cliSource.matchAll(/\{ names: \[([^\]]*)\], load:/g)].map((match) =>
  [...match[1].matchAll(/"([^"]+)"/g)].map((name) => name[1]),
)
const registeredCommands = new Set(["completion", ...commandNames.flatMap((names) => names.slice(0, 1))])
const registeredAliases = new Set(commandNames.flatMap((names) => names.slice(1)))
const undocumentedCommands = [...registeredCommands].filter((command) => !documentedCommands.has(command))
if (undocumentedCommands.length)
  throw new Error(`docs/cli.md: undocumented CLI commands: ${undocumentedCommands.join(", ")}`)
const staleCommands = [...documentedCommands].filter((command) => !registeredCommands.has(command))
if (staleCommands.length) throw new Error(`docs/cli.md: unrecognized CLI commands: ${staleCommands.join(", ")}`)
const aliasDrift = topLevelAliasDrift(cliReference)
if (aliasDrift.undocumented.length)
  throw new Error(`docs/cli.md: undocumented CLI aliases: ${aliasDrift.undocumented.join(", ")}`)
if (aliasDrift.unregistered.length)
  throw new Error(`docs/cli.md: unregistered CLI aliases: ${aliasDrift.unregistered.join(", ")}`)
if (topLevelAliasDrift(`${cliReference}\nAlias: \`oc2 invented-alias\``).unregistered.join(",") !== "invented-alias")
  throw new Error("top-level CLI alias drift negative probe failed")
const unregisteredHelpCommands = [...helpCommands].filter((command) => !registeredCommands.has(command))
if (unregisteredHelpCommands.length)
  throw new Error(`oc2 --help contained unregistered commands: ${unregisteredHelpCommands.join(", ")}`)

function topLevelAliasDrift(reference: string) {
  const documented = new Set(
    [...reference.matchAll(/\bAlias:\s*`oc2 ([a-z][\w-]*)`/gi)].map((match) => match[1]),
  )
  return {
    undocumented: [...registeredAliases].filter((alias) => !documented.has(alias)),
    unregistered: [...documented].filter((alias) => !registeredAliases.has(alias)),
  }
}

const cliContracts = [
  {
    args: [],
    options: [
      "--help",
      "--version",
      "--print-logs",
      "--log-level",
      "--pure",
      "--model",
      "--agent",
      "--continue",
      "--session",
      "--fork",
      "--prompt",
      "--port",
      "--hostname",
      "--mdns",
      "--mdns-domain",
      "--cors",
    ],
  },
  {
    args: ["run"],
    options: [
      "--format",
      "--file",
      "--model",
      "--agent",
      "--variant",
      "--title",
      "--dir",
      "--attach",
      "--continue",
      "--session",
      "--fork",
      "--command",
      "--interactive",
      "--dangerously-skip-permissions",
    ],
  },
  {
    args: ["attach"],
    options: ["--dir", "--continue", "--session", "--fork", "--password", "--username"],
  },
  { args: ["export"], options: ["--sanitize"] },
  { args: ["stats"], options: ["--days", "--tools", "--models", "--project"] },
  { args: ["upgrade"], options: ["--method"] },
  { args: ["uninstall"], options: ["--keep-config", "--keep-data", "--dry-run", "--force"] },
  { args: ["plugin"], options: ["--global", "--force"] },
  { args: ["mcp", "add"], options: ["--url", "--header", "--env"] },
] as const
for (const [contract, output] of await Promise.all(
  cliContracts.map(async (contract) => [contract, await commandHelp([...contract.args])] as const),
)) {
  const missingFromHelp = contract.options.filter((option) => !output.includes(option))
  if (missingFromHelp.length)
    throw new Error(
      `oc2 ${contract.args.join(" ")} --help is missing documented options: ${missingFromHelp.join(", ")}`,
    )
  const missingFromDocs = contract.options.filter((option) => !cliDocumentation.includes(option))
  if (missingFromDocs.length)
    throw new Error(`docs/cli.md is missing contracted options: ${missingFromDocs.join(", ")}`)
}

for (const [args, alias, documentation] of [
  [["mcp"], "ls", "`list` (`ls`)"],
  [["mcp", "auth"], "ls", "`auth list` (`auth ls`)"],
] as const) {
  const output = await commandHelp([...args])
  if (!output.includes(`aliases: ${alias}`) || !cliDocumentation.includes(documentation))
    throw new Error(`docs/cli.md or oc2 ${args.join(" ")} --help is missing alias ${alias}`)
}

const tuiCliSource = await Bun.file("packages/opencode/src/cli/cmd/tui.ts").text()
if (!/return piped \+ "\\n" \+ value/.test(tuiCliSource) || !cliReference.includes("Piped stdin is prepended"))
  throw new Error("default TUI stdin ordering drifted from docs/cli.md")
const runCliSource = await Bun.file("packages/opencode/src/cli/cmd/run.ts").text()
if (
  !/return value \+ "\\n" \+ piped/.test(runCliSource) ||
  !cliReference.includes("argument text is followed by the piped content")
)
  throw new Error("oc2 run stdin ordering drifted from docs/cli.md")

const keybindingReference = await Bun.file("docs/reference/keybindings.md").text()
const keybindRows = [...keybindingReference.matchAll(/^\|\s+`([^`]+)`\s+\|\s+`([^`]*)`\s+\|\s+(.+?)\s+\|$/gm)].map(
  (match) => [match[1], { default: match[2], description: match[3] }] as const,
)
const duplicateKeybinds = keybindRows
  .map(([name]) => name)
  .filter((name, index, names) => names.indexOf(name) !== index)
if (duplicateKeybinds.length)
  throw new Error(`docs/reference/keybindings.md: duplicate keybindings: ${[...new Set(duplicateKeybinds)].join(", ")}`)
const documentedKeybinds = new Map(keybindRows)
const keybindDrift = Object.entries(TuiKeybind.Definitions).flatMap(([name, item]) => {
  const documented = documentedKeybinds.get(name)
  const value = typeof item.default === "string" ? item.default : JSON.stringify(item.default)
  if (!documented) return [`missing ${name}`]
  if (documented.default !== value) return [`${name} default is ${documented.default}; expected ${value}`]
  if (documented.description !== item.description)
    return [`${name} description is ${documented.description}; expected ${item.description}`]
  return []
})
const keybindNames = new Set(Object.keys(TuiKeybind.Definitions))
keybindDrift.push(
  ...[...documentedKeybinds.keys()].filter((name) => !keybindNames.has(name)).map((name) => `unknown ${name}`),
)
if (keybindDrift.length) throw new Error(`docs/reference/keybindings.md: keybinding drift: ${keybindDrift.join("; ")}`)

const exampleFiles = ["oc2.example.json", ...new Bun.Glob("docs/examples/**/*.{json,jsonc}").scanSync()].sort()
if (!exampleFiles.includes("docs/examples/oc2.minimal.jsonc")) throw new Error("missing minimal OC2 example")
if (!exampleFiles.includes("docs/examples/oc2.full.jsonc")) throw new Error("missing full OC2 example")
if (!exampleFiles.includes("docs/examples/tui.jsonc")) throw new Error("missing TUI example")
if (!exampleFiles.includes("docs/examples/oc2.mcp-local.jsonc")) throw new Error("missing local MCP example")
if (!exampleFiles.includes("docs/examples/oc2.mcp-remote.jsonc")) throw new Error("missing remote MCP example")
if (secretLikeLocation(["sk-example"])?.join(".") !== "0") throw new Error("secret array validation probe failed")
if (secretLikeLocation({ apiKey: "{env:API_KEY}" })) throw new Error("environment substitution validation probe failed")
if (secretLikeLocation(["{env:API_KEY} sk-example"])?.join(".") !== "0")
  throw new Error("mixed secret validation probe failed")
if (TuiKeybind.unknownKeys({ not_a_keybind: "none" }).join(",") !== "not_a_keybind")
  throw new Error("TUI keybind validation probe failed")

for (const file of exampleFiles) {
  const data = ConfigParse.jsonc(await Bun.file(file).text(), file)
  rejectSecretLikeValues(data, file)
  const name = path.basename(file)
  if (name.startsWith("oc2.")) ConfigParse.schema(Oc2Config, data, file)
  if (name.startsWith("tui.")) {
    ConfigParse.schema(TuiConfig, data, file)
    if (data && typeof data === "object" && "keybinds" in data && data.keybinds && typeof data.keybinds === "object") {
      const unknown = TuiKeybind.unknownKeys(data.keybinds)
      if (unknown.length) throw new Error(`${file}: unrecognized TUI keybinds: ${unknown.join(", ")}`)
    }
  }
}

const markdown = new Map(markdownFiles.map((file) => [path.resolve(file), Bun.file(file).text()]))
const contents = new Map(await Promise.all([...markdown].map(async ([file, text]) => [file, await text] as const)))
const anchors = new Map([...contents].map(([file, text]) => [file, markdownAnchors(text)]))
const failures: string[] = []

for (const [file, text] of contents) {
  for (const link of markdownLinks(text)) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue
    const [rawTarget, rawFragment] = link.split("#", 2)
    const target = path.resolve(path.dirname(file), decodeURIComponent(rawTarget || path.basename(file)))
    const display = path.relative(root, file)
    if (!existsSync(target)) {
      failures.push(`${display}: missing link target ${link}`)
      continue
    }
    if (!rawFragment || path.extname(target).toLowerCase() !== ".md") continue
    const fragment = decodeURIComponent(rawFragment)
    const targetAnchors = anchors.get(target) ?? markdownAnchors(await Bun.file(target).text())
    anchors.set(target, targetAnchors)
    if (!targetAnchors.has(fragment))
      failures.push(`${display}: missing anchor #${fragment} in ${path.relative(root, target)}`)
  }
}

if (failures.length)
  throw new Error(`documentation links failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`)
console.log(`Checked ${markdownFiles.length} Markdown files and ${exampleFiles.length} configuration examples.`)

function rejectSecretLikeValues(value: unknown, file: string, keys: string[] = []) {
  const location = secretLikeLocation(value, keys)
  if (location !== undefined)
    throw new Error(`${file}: secret-like value at ${location.join(".")}; use an {env:NAME} substitution`)
}

function secretLikeLocation(value: unknown, keys: string[] = []): string[] | undefined {
  if (typeof value === "string") {
    const literal = value.replace(/\{env:[A-Z][A-Z\d_]*\}/g, "")
    const key = keys.at(-1) ?? ""
    const sensitiveKey = /(?:api.?key|authorization|client.?secret|password|token)$/i.test(key)
    const allowedWrapper = /^(?:\s|Bearer\s*)*$/i.test(literal)
    const secretLike =
      /(?:sk-(?:ant-)?|gh[pousr]_|AKIA)[A-Za-z\d._-]*|<(?:api.?key|secret|token|password)>|(?:your|replace.?me).*(?:api.?key|secret|token|password)/i.test(
        literal,
      )
    return secretLike || (sensitiveKey && literal.length > 0 && !allowedWrapper) ? keys : undefined
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const location = secretLikeLocation(value[index], [...keys, String(index)])
      if (location) return location
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined

  for (const [key, item] of Object.entries(value)) {
    const location = secretLikeLocation(item, [...keys, key])
    if (location) return location
  }
  return undefined
}

function markdownLinks(text: string) {
  const links: string[] = []
  for (const line of markdownLines(text)) {
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g))
      links.push(match[1])
    const reference = line.match(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/)
    if (reference) links.push(reference[1])
    for (const match of line.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) links.push(match[1])
  }
  return links
}

function markdownAnchors(text: string) {
  const anchors = new Set<string>()
  const counts = new Map<string, number>()
  const lines = markdownLines(text)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const heading =
      line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1] ??
      (lines[index + 1]?.match(/^ {0,3}(?:=+|-+)\s*$/) ? line.trim() : undefined)
    if (!heading) continue
    const base = heading
      .replace(/<[^>]+>/g, "")
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-")
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

function markdownLines(text: string) {
  const lines: string[] = []
  let fence: string | undefined
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (marker && !fence) {
      fence = marker[0]
      continue
    }
    if (marker?.[0] === fence) {
      fence = undefined
      continue
    }
    if (!fence) lines.push(line)
  }
  return lines
}
