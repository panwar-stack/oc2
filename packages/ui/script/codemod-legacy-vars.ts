import path from "node:path"

const files = [
  "packages/app/src/components/titlebar.tsx",
  "packages/app/src/pages/session/message-timeline.tsx",
] as const

const variables = new Map([
  ["--background-base", "--v2-background-bg-base"],
  ["--background-weak", "--v2-background-bg-layer-01"],
  ["--surface-raised-base", "--v2-background-bg-layer-02"],
  ["--surface-raised-strong", "--v2-background-bg-layer-03"],
  ["--surface-raised-stronger", "--v2-background-bg-layer-04"],
  ["--surface-brand-base", "--v2-background-bg-accent"],
  ["--text-base", "--v2-text-text-base"],
  ["--text-weak", "--v2-text-text-muted"],
  ["--text-weaker", "--v2-text-text-faint"],
  ["--text-interactive-base", "--v2-text-text-accent"],
  ["--text-on-brand", "--v2-text-text-contrast"],
  ["--text-invert-base", "--v2-text-text-inverse"],
  ["--border-base", "--v2-border-border-base"],
  ["--border-weaker-base", "--v2-border-border-muted"],
  ["--border-strong-base", "--v2-border-border-strong"],
  ["--border-focus", "--v2-border-border-focus"],
])

const suffixes = {
  syntax: new Set([
    "comment",
    "keyword",
    "function",
    "variable",
    "string",
    "number",
    "type",
    "operator",
    "punctuation",
  ]),
  markdown: new Set([
    "text",
    "heading",
    "link",
    "link-text",
    "code",
    "code-block",
    "block-quote",
    "emph",
    "strong",
    "horizontal-rule",
    "list-item",
    "list-enumeration",
    "image",
    "image-text",
  ]),
}

export function rewriteLegacyVars(input: string) {
  let output = input
  for (const [legacy, current] of variables) {
    output = output.replace(new RegExp(`${legacy}(?![a-zA-Z0-9-])`, "g"), current)
  }

  output = output.replace(
    /--(text|surface|border)-(critical|warning|success|info)-[a-zA-Z0-9-]+/g,
    (_, channel: "text" | "surface" | "border", state: "critical" | "warning" | "success" | "info") =>
      `--v2-state-${channel === "text" ? "fg" : channel === "surface" ? "bg" : "border"}-${state === "critical" ? "danger" : state}`,
  )
  output = output.replace(
    /--(syntax|markdown)-([a-zA-Z0-9-]+)/g,
    (reference, domain: keyof typeof suffixes, suffix: string) =>
      suffixes[domain].has(suffix) ? `--v2-${domain}-${suffix}` : reference,
  )
  return output
}

export async function runCodemod(options?: {
  root?: string
  dryRun?: boolean
  diff?: boolean
  print?: (line: string) => void
}) {
  const root = options?.root ?? path.resolve(import.meta.dir, "../../..")
  const print = options?.print ?? console.log
  const changed: string[] = []
  const reports: string[] = []

  for (const relative of files) {
    const filename = path.resolve(root, relative)
    const file = Bun.file(filename)
    if (!(await file.exists())) throw new Error(`Missing allowlisted codemod file: ${relative}`)

    const before = await file.text()
    const after = rewriteLegacyVars(before)
    const hardcoded = after.replace(/\/\/.*$/gm, "").match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []
    if (hardcoded.length > 0) reports.push(`${relative}: ${hardcoded.length} hardcoded color value(s) require review`)
    if (before === after) continue

    changed.push(relative)
    if (options?.diff) {
      const previous = before.split("\n")
      const next = after.split("\n")
      print(`--- ${relative}`)
      print(`+++ ${relative}`)
      for (let index = 0; index < previous.length; index++) {
        if (previous[index] === next[index]) continue
        print(`@@ -${index + 1} +${index + 1} @@`)
        print(`-${previous[index]}`)
        print(`+${next[index]}`)
      }
    }
    if (!options?.dryRun && !options?.diff) await Bun.write(filename, after)
  }

  for (const report of reports) print(`warning: ${report}`)
  print(`${options?.dryRun || options?.diff ? "Would update" : "Updated"} ${changed.length} file(s)`)
  return { changed, reports }
}

if (import.meta.main) {
  const supported = new Set(["--dry-run", "--diff"])
  const invalid = process.argv.slice(2).filter((arg) => !supported.has(arg))
  if (invalid.length > 0) throw new Error(`Unknown option: ${invalid.join(", ")}`)
  await runCodemod({
    dryRun: process.argv.includes("--dry-run"),
    diff: process.argv.includes("--diff"),
  })
}
