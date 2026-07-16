#!/usr/bin/env bun
import { appendFile } from "node:fs/promises"

import { $ } from "bun"

const fullRunEvents = new Set(["merge_group", "push", "schedule", "workflow_dispatch"])
const fullRunFiles = new Set([
  ".github/workflows/test.yml",
  ".github/workflows/typecheck.yml",
  "bun.lock",
  "bun.lockb",
  "package.json",
  "turbo.json",
  "tsconfig.json",
])
const fullRunPrefixes = [".github/actions/", "containers/", "patches/", "script/"]
const generatedPrefixes = [
  "packages/opencode/src/",
  "packages/sdk/",
  "packages/server/",
  "packages/ui/script/",
  "packages/ui/src/styles/tailwind/",
  "packages/ui/src/theme/",
  "script/check-generated.ts",
]
const sharedPackages = new Set([
  "@oc2-ai/core",
  "@oc2-ai/effect-drizzle-sqlite",
  "@oc2-ai/effect-sqlite-node",
  "@oc2-ai/llm",
  "@oc2-ai/plugin",
  "@oc2-ai/script",
  "@oc2-ai/sdk",
  "@oc2-ai/server",
  "@oc2-ai/ui",
])
const e2ePackages = new Set(["@oc2-ai/app", "@oc2-ai/ui"])
const httpApiPackages = new Set(["oc2", "@oc2-ai/core", "@oc2-ai/sdk", "@oc2-ai/server"])

const args = process.argv.slice(2)
const event = option("event") ?? process.env.GITHUB_EVENT_NAME ?? "pull_request"
const requestedFiles = option("files")
const files =
  requestedFiles
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? (fullRunEvents.has(event) ? [] : await changedFiles())
const packages = await workspacePackages()

const fullRun =
  fullRunEvents.has(event) ||
  files.some((file) => fullRunFiles.has(file) || fullRunPrefixes.some((prefix) => file.startsWith(prefix)))
const codeFiles = files.filter((file) => !isDocsOnly(file))
const changedPackages = unique(
  codeFiles.map((file) => packageForFile(file, packages)).filter((pkg): pkg is WorkspacePackage => !!pkg),
)
const touchesSharedPackage = changedPackages.some((pkg) => sharedPackages.has(pkg.name))
const codeChanged = codeFiles.length > 0
const full = fullRun || touchesSharedPackage
const filterPackages = full ? [] : changedPackages.map((pkg) => pkg.name)
const turboFilter = filterPackages.map((name) => `--filter=${name}`).join(" ")
const checkGenerated =
  full || files.some((file) => generatedPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)))
const runTypecheck = full || filterPackages.length > 0 || (codeChanged && files.length > 0)
const runUnit = full || filterPackages.length > 0
const runHttpApi = full || changedPackages.some((pkg) => httpApiPackages.has(pkg.name))
const runE2e = full || changedPackages.some((pkg) => e2ePackages.has(pkg.name))

await setOutputs({
  check_generated: String(checkGenerated),
  changed_files: String(files.length),
  full: String(full),
  reason: full ? "full" : filterPackages.length > 0 ? "filtered" : codeChanged ? "changed" : "docs-only",
  run_e2e: String(runE2e),
  run_httpapi: String(runHttpApi),
  run_typecheck: String(runTypecheck),
  run_unit: String(runUnit),
  turbo_filter: turboFilter,
})

function option(name: string) {
  const prefix = `--${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

async function changedFiles() {
  const baseRef = process.env.GITHUB_BASE_REF
  if (!baseRef || !/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.startsWith("/") || baseRef.includes(".."))
    throw new Error("missing or invalid CI base ref")
  const ranges = [`origin/${baseRef}...HEAD`, `${baseRef}...HEAD`]
  for (const range of ranges) {
    const result = await $`git diff --name-only ${range}`.quiet().nothrow()
    if (result.exitCode === 0) return result.stdout.toString().trim().split("\n").filter(Boolean)
  }
  throw new Error("unable to resolve CI base ref")
}

async function workspacePackages() {
  const paths = [...new Bun.Glob("packages/*/package.json").scanSync(), "packages/sdk/js/package.json"]
  const packages = await Promise.all(
    unique(paths).map(async (path) => {
      const json = (await Bun.file(path).json()) as { name?: string }
      const root = path.slice(0, -"/package.json".length)
      return json.name ? { name: json.name, root } : undefined
    }),
  )
  return packages.filter((pkg): pkg is WorkspacePackage => !!pkg).sort((a, b) => b.root.length - a.root.length)
}

function packageForFile(file: string, packages: WorkspacePackage[]) {
  if (file === "packages/sdk/openapi.json" || file.startsWith("packages/sdk/"))
    return packages.find((pkg) => pkg.name === "@oc2-ai/sdk")
  return packages.find((pkg) => file === pkg.root || file.startsWith(`${pkg.root}/`))
}

function isDocsOnly(file: string) {
  return file.endsWith(".md") || file.startsWith("docs/")
}

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

async function setOutputs(outputs: Record<string, string>) {
  const lines =
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) await appendFile(outputPath, lines)
  console.log(lines.trim())
}

interface WorkspacePackage {
  name: string
  root: string
}
