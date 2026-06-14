import type { Diagnostic, DiagnosticReport } from "../diagnostics/diagnostics"

export interface JsonVersionOutput {
  name: "oc2"
  version: string
}

export interface TextTableRow {
  name: string
  value: string
}

/** Formats values as stable, newline-terminated JSON for CLI output. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value ?? null, null, 2)}\n`
}

export function formatVersionText(version: string): string {
  return `oc2 ${version}\n`
}

export function formatVersionJson(version: string): JsonVersionOutput {
  return { name: "oc2", version }
}

/** Formats diagnostics for humans while preserving the structured report in JSON mode. */
export function formatDiagnosticsText(report: DiagnosticReport): string {
  const counts = countDiagnostics(report.diagnostics)
  const lines = [
    `Diagnostics generated at ${report.generatedAt}`,
    `Environment: ${String(report.environment.platform ?? "unknown")}/${String(report.environment.arch ?? "unknown")}`,
    `Diagnostics: ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
  ]

  for (const diagnostic of report.diagnostics) {
    lines.push(formatDiagnosticLine(diagnostic))
  }

  return `${lines.join("\n")}\n`
}

export function formatConfigPathText(paths: TextTableRow[]): string {
  return `${paths.map((row) => `${row.name}: ${row.value}`).join("\n")}\n`
}

export function formatConfigValue(value: unknown, json: boolean): string {
  if (json) return formatJson(value)
  if (typeof value === "string") return `${value}\n`
  if (value === undefined) return "undefined\n"
  return `${JSON.stringify(value, null, 2)}\n`
}

export function formatToolsListText(tools: { name: string; enabled: boolean }[]): string {
  if (tools.length === 0) return "No tools configured.\n"
  return `${tools.map((tool) => `${tool.name}\t${tool.enabled ? "enabled" : "disabled"}`).join("\n")}\n`
}

export function formatRunHelp(): string {
  return [
    "Usage: oc2 run <prompt> [--json] [--model <provider/model>] [--tool <name>] [--no-tool <name>] [--mcp <id>] [--no-mcp <id>]",
    "",
    "Run a one-shot prompt. Model execution is implemented in PR 8.",
    "",
    "Options:",
    "  --json                 Emit JSON output",
    "  --model <provider/model>",
    "  --tool <name>          Enable a tool for this run",
    "  --no-tool <name>       Disable a tool for this run",
    "  --mcp <id>             Enable an MCP server for this run",
    "  --no-mcp <id>          Disable an MCP server for this run",
    "  --help                 Show this help",
    "",
  ].join("\n")
}

function countDiagnostics(diagnostics: Diagnostic[]) {
  return diagnostics.reduce(
    (counts, diagnostic) => ({ ...counts, [diagnostic.level]: counts[diagnostic.level] + 1 }),
    { error: 0, warning: 0, info: 0 },
  )
}

function formatDiagnosticLine(diagnostic: Diagnostic): string {
  const path = diagnostic.path ? ` (${diagnostic.path})` : ""
  return `[${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}${path}`
}
