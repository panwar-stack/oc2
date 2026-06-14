import { z } from "zod"

import { resolveWorkspacePath } from "../roots"
import { ToolExecutionError, type ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  pattern: z.string().min(1),
  language: z.string().optional(),
  path: z.string().min(1).optional(),
  include: z.string().optional(),
  exclude: z.string().optional(),
})

export const createOpenGrepTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "opengrep",
  description: "Run OpenGrep/Semgrep structural search when a local binary is available.",
  inputSchema,
  modelInputSchema: objectSchema(
    { pattern: stringProperty("Structural pattern"), language: stringProperty("Language"), path: stringProperty("Directory or file to search"), include: stringProperty("Include filter"), exclude: stringProperty("Exclude filter") },
    ["pattern"],
  ),
  permission: { action: "opengrep", resource: (input) => input.path ?? input.pattern },
  async execute(input, context) {
    const target = await resolveWorkspacePath(input.path ?? ".", context.workspaceRoots, { cwd: context.cwd, mustExist: true })
    const binary = await findOpenGrepBinary()
    if (!binary) {
      return { available: false, matches: [], message: "OpenGrep is not installed; use grep as a fallback.", path: target.path }
    }
    const args = ["--json", "-e", input.pattern, target.path]
    if (input.language) args.splice(1, 0, "--lang", input.language)
    if (input.include) args.push("--include", input.include)
    if (input.exclude) args.push("--exclude", input.exclude)
    const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" })
    const onAbort = () => proc.kill()
    context.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      if (context.signal.aborted) throw new ToolExecutionError({ code: "cancelled", message: "Tool was cancelled" })
      if (exitCode > 1) throw new ToolExecutionError({ code: "opengrep_failed", message: stderr || `OpenGrep exited ${exitCode}` })
      return { available: true, path: target.path, raw: stdout ? JSON.parse(stdout) : { results: [] } }
    } finally {
      context.signal.removeEventListener("abort", onAbort)
    }
  },
})

const findOpenGrepBinary = async (): Promise<string | undefined> => {
  if (process.env.OC2_OPENGREP_DISABLE === "1") return undefined
  if (process.env.OC2_OPENGREP_BINARY) return process.env.OC2_OPENGREP_BINARY
  for (const binary of ["opengrep", "semgrep"]) {
    const proc = Bun.spawn(["bash", "-lc", `command -v ${binary}`], { stdout: "pipe", stderr: "ignore" })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode === 0 && stdout.trim()) return stdout.trim()
  }
  return undefined
}
