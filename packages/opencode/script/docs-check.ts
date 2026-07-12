#!/usr/bin/env bun
import path from "node:path"
import { existsSync } from "node:fs"

import { Info as TuiConfig } from "@oc2-ai/tui/config"
import { Info as Oc2Config } from "../src/config/config"
import { ConfigParse } from "../src/config/parse"

const root = path.resolve(import.meta.dir, "../../..")
process.chdir(root)

const markdownFiles = ["README.md", ...new Bun.Glob("docs/**/*.md").scanSync()].sort()
const prettier = Bun.spawn(["bunx", "prettier", "--check", ...markdownFiles], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await prettier.exited) !== 0) process.exit(1)

const help = Bun.spawn(["bun", "run", "--conditions=browser", "src/index.ts", "--help"], {
  cwd: path.join(root, "packages/opencode"),
  stdout: "pipe",
  stderr: "pipe",
})
const [helpStdout, helpStderr, helpExit] = await Promise.all([
  new Response(help.stdout).text(),
  new Response(help.stderr).text(),
  help.exited,
])
if (helpExit !== 0 || !`${helpStdout}\n${helpStderr}`.includes("Commands:")) {
  throw new Error("failed to read oc2 --help output from stdout or stderr")
}

const exampleFiles = ["oc2.example.json", ...new Bun.Glob("docs/examples/**/*.{json,jsonc}").scanSync()].sort()
if (!exampleFiles.includes("docs/examples/oc2.minimal.jsonc")) throw new Error("missing minimal OC2 example")
if (!exampleFiles.includes("docs/examples/oc2.full.jsonc")) throw new Error("missing full OC2 example")
if (!exampleFiles.includes("docs/examples/tui.jsonc")) throw new Error("missing TUI example")
if (!exampleFiles.includes("docs/examples/oc2.mcp-local.jsonc")) throw new Error("missing local MCP example")
if (!exampleFiles.includes("docs/examples/oc2.mcp-remote.jsonc")) throw new Error("missing remote MCP example")

for (const file of exampleFiles) {
  const data = ConfigParse.jsonc(await Bun.file(file).text(), file)
  rejectSecretLikeValues(data, file)
  const name = path.basename(file)
  if (name.startsWith("oc2.")) ConfigParse.schema(Oc2Config, data, file)
  if (name.startsWith("tui.")) ConfigParse.schema(TuiConfig, data, file)
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
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretLikeValues(item, file, [...keys, String(index)]))
    return
  }
  if (!value || typeof value !== "object") return

  for (const [key, item] of Object.entries(value)) {
    const location = [...keys, key]
    if (typeof item === "string") {
      const usesEnvironment = /\{env:[A-Z][A-Z\d_]*\}/.test(item)
      const sensitiveKey = /(?:api.?key|authorization|client.?secret|password|token)$/i.test(key)
      const secretLike =
        /(?:sk-(?:ant-)?|gh[pousr]_|AKIA)[A-Za-z\d._-]*|<(?:api.?key|secret|token|password)>|(?:your|replace.?me).*(?:api.?key|secret|token|password)/i.test(
          item,
        )
      if (!usesEnvironment && (secretLike || (sensitiveKey && item.length > 0))) {
        throw new Error(`${file}: secret-like value at ${location.join(".")}; use an {env:NAME} substitution`)
      }
    }
    rejectSecretLikeValues(item, file, location)
  }
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
