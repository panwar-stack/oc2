#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import ts from "typescript"

const root = path.resolve(import.meta.dir, "..")
const allowlistPath = path.join(root, "script/legacy-brand-allowlist.jsonc")
const legacyTerms = [
  "api.opencode.ai",
  "app.opencode.ai",
  "docs.opencode.ai",
  "opencode.ai",
  "@opencode-ai/",
  "OPENCODE_",
  "x-opencode-",
  "opencode.json",
  ".opencode",
  "OpenCode",
  "opencode",
]
const legacyPattern = new RegExp(legacyTerms.map(escapeRegExp).join("|"), "g")
const includedExtensions = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
])
const includedNames = new Set(["Dockerfile", "install"])
const excludedPaths = new Set(["script/check-brand.ts", "script/legacy-brand-allowlist.jsonc"])
const excludedPathParts = new Set([
  ".sst",
  ".turbo",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "gen",
  "generated",
  "node_modules",
  "out",
  "target",
  "ts-dist",
])
const excludedNames = new Set(["bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
const reasons = new Set(["compatibility", "migration", "external-repo", "third-party", "test-fixture"])
const owners = new Set(["core", "desktop", "app", "docs", "release", "vscode"])

type LegacyBrandAllowlistEntry = {
  path: string
  pattern: string
  count: number
  reason: "compatibility" | "migration" | "external-repo" | "third-party" | "test-fixture"
  owner: "core" | "desktop" | "app" | "docs" | "release" | "vscode"
  note?: string
}

type CompiledAllowlistEntry = LegacyBrandAllowlistEntry & {
  pathPattern: RegExp
  linePattern: RegExp
}

type Match = {
  file: string
  line: number
  text: string
  term: string
}

const allowlist = await loadAllowlist()
const matchedAllowlistCounts = new Map<number, number>()
const violations: Match[] = []
let scannedFiles = 0
let matchedOccurrences = 0

for (const file of await trackedFiles()) {
  if (!shouldScan(file)) continue
  scannedFiles++
  const fileAllowlist = allowlist
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.pathPattern.test(file))

  const text = await Bun.file(path.join(root, file)).text()
  if (text.includes("\u0000")) continue

  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const occurrences = legacyOccurrencesIn(line)
    if (occurrences.length === 0) continue
    const allowedRanges = fileAllowlist.flatMap(({ entry, index }) =>
      Array.from(matchingRanges(entry.linePattern, line), (range) => ({ ...range, index })),
    )

    for (const occurrence of occurrences) {
      matchedOccurrences++
      const allowedRange = allowedRanges.find((range) => range.start <= occurrence.start && occurrence.end <= range.end)
      const allowedTerm = fileAllowlist.find(({ entry }) => {
        entry.linePattern.lastIndex = 0
        return entry.linePattern.test(occurrence.term)
      })
      const allowlistIndex = allowedRange?.index ?? allowedTerm?.index
      if (allowlistIndex === undefined) {
        violations.push({ file, line: index + 1, text: line, term: occurrence.term })
        continue
      }

      matchedAllowlistCounts.set(allowlistIndex, (matchedAllowlistCounts.get(allowlistIndex) ?? 0) + 1)
    }
  }
}

for (const violation of violations) {
  console.error(`::error file=${violation.file},line=${violation.line}::unallowlisted legacy brand term: ${violation.term}`)
  console.error(`  ${violation.text.trim()}`)
}

const countErrors = allowlist.flatMap((entry, index) => {
  const actual = matchedAllowlistCounts.get(index) ?? 0
  if (entry.count === actual) return []
  return [{ entry, actual }]
})
for (const { entry, actual } of countErrors) {
  console.error(
    `::error file=script/legacy-brand-allowlist.jsonc::legacy brand allowlist count mismatch for ${entry.path} / ${entry.pattern}: expected ${entry.count}, found ${actual}`,
  )
}

console.log(
  `Brand check scanned ${scannedFiles} tracked files and found ${matchedOccurrences} legacy-brand occurrence(s) covered by ${matchedAllowlistCounts.size} allowlist entr${matchedAllowlistCounts.size === 1 ? "y" : "ies"}.`,
)

if (violations.length > 0 || countErrors.length > 0) process.exitCode = 1

async function loadAllowlist() {
  const parsed = ts.parseConfigFileTextToJson(allowlistPath, await Bun.file(allowlistPath).text())
  if (parsed.error) {
    const message = ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")
    throw new Error(`Invalid legacy brand allowlist: ${message}`)
  }

  const entries = (parsed.config.entries ?? []) as LegacyBrandAllowlistEntry[]
  return entries.map((entry, index): CompiledAllowlistEntry => {
    if (!entry.path) throw new Error(`Legacy brand allowlist entry ${index + 1} is missing path`)
    if (!entry.pattern) throw new Error(`Legacy brand allowlist entry ${index + 1} is missing pattern`)
    if (!Number.isInteger(entry.count) || entry.count < 0)
      throw new Error(`Legacy brand allowlist entry ${index + 1} has invalid count`)
    if (!reasons.has(entry.reason)) throw new Error(`Legacy brand allowlist entry ${index + 1} has invalid reason`)
    if (!owners.has(entry.owner)) throw new Error(`Legacy brand allowlist entry ${index + 1} has invalid owner`)

    return {
      ...entry,
      pathPattern: globToRegExp(entry.path),
      linePattern: new RegExp(entry.pattern, "g"),
    }
  })
}

async function trackedFiles() {
  const output = await $`git ls-files`.quiet().text()
  return output.split("\n").filter(Boolean).sort()
}

function shouldScan(file: string) {
  if (excludedPaths.has(file)) return false
  const basename = path.basename(file)
  if (excludedNames.has(basename)) return false
  const parts = file.split("/")
  if (parts.some((part) => excludedPathParts.has(part))) return false
  return includedNames.has(basename) || includedExtensions.has(path.extname(file))
}

function legacyOccurrencesIn(line: string) {
  legacyPattern.lastIndex = 0
  return Array.from(line.matchAll(legacyPattern), (match) => ({
    term: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function* matchingRanges(pattern: RegExp, line: string) {
  pattern.lastIndex = 0
  for (const match of line.matchAll(pattern)) {
    yield {
      start: match.index,
      end: match.index + match[0].length,
    }
  }
}

function globToRegExp(glob: string) {
  const pattern = glob
    .split("**")
    .map((part) => escapeRegExp(part).replaceAll("\\*", "[^/]*"))
    .join(".*")
  return new RegExp(`^${pattern}$`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
