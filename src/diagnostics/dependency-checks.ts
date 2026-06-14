import type { Oc2Config } from "../config/schema"
import type { Diagnostic } from "./diagnostics"
import { createDiagnostic } from "./diagnostics"

export interface DependencyCheckOptions {
  commandExists?: (command: string) => boolean | Promise<boolean>
}

export async function runDependencyChecks(
  config: Oc2Config,
  options: DependencyCheckOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = []
  const commandExists = options.commandExists ?? defaultCommandExists

  for (const [serverId, server] of Object.entries(config.mcp)) {
    if (!server.enabled) continue
    if (server.transport === "stdio" && server.command && !(await commandExists(server.command))) {
      diagnostics.push(
        createDiagnostic("warning", "diagnostics.mcp.command_missing", `MCP command not found for ${serverId}`, {
          path: `mcp.${serverId}.command`,
          details: { command: server.command },
        }),
      )
    }
  }

  return diagnostics
}

async function defaultCommandExists(command: string): Promise<boolean> {
  if (command.includes("/")) return Bun.file(command).exists()
  const path = process.env.PATH ?? ""
  for (const directory of path.split(":")) {
    if (directory && (await Bun.file(`${directory}/${command}`).exists())) return true
  }
  return false
}
