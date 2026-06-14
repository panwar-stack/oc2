import { lstat, realpath, readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import { isInsidePath, normalizeWorkspaceRoots, resolveWorkspacePath } from "../roots"
import { ToolExecutionError, type ToolDefinition } from "../tool"
import { numberProperty, objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  include: z.string().optional(),
  maxMatches: z.number().int().positive().max(1_000).optional(),
})

/** Creates the built-in regex search tool with recursive workspace traversal and bounded matches. */
export const createGrepTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "grep",
  description: "Search text files with a regular expression inside workspace roots.",
  inputSchema,
  modelInputSchema: objectSchema(
    {
      pattern: stringProperty("Regular expression"),
      path: stringProperty("File or directory to search"),
      include: stringProperty("Substring files must include"),
      maxMatches: numberProperty("Maximum matches"),
    },
    ["pattern"],
  ),
  permission: { action: "read", resource: (input) => input.path ?? input.pattern },
  async execute(input, context) {
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch (error) {
      throw new ToolExecutionError({
        code: "invalid_regex",
        message: error instanceof Error ? error.message : String(error),
      })
    }

    const base = await resolveWorkspacePath(input.path ?? ".", context.workspaceRoots, {
      cwd: context.cwd,
      mustExist: true,
    })
    const roots = normalizeWorkspaceRoots(context.workspaceRoots, context.cwd)
    const realRoots = await Promise.all(roots.map((root) => realpath(root.path).catch(() => root.path)))
    const files = await collectFiles(base.path, input.include, context.signal, realRoots)
    const matches: Array<{ path: string; line: number; text: string }> = []
    const maxMatches = input.maxMatches ?? 100

    for (const filePath of files) {
      if (context.signal.aborted) throw new ToolExecutionError({ code: "cancelled", message: "Tool was cancelled" })
      const file = Bun.file(filePath)
      if (file.size > 1024 * 1024) continue
      const text = await file.text().catch(() => "")
      const lines = text.split("\n")
      for (const [index, line] of lines.entries()) {
        if (regex.test(line)) matches.push({ path: filePath, line: index + 1, text: line.slice(0, 500) })
        // Reset global/sticky regex state so each line is evaluated independently.
        regex.lastIndex = 0
        if (matches.length >= maxMatches) return { matches, truncated: true }
      }
    }
    return { matches, truncated: false }
  },
})

/** Recursively collects readable files while skipping common large/generated directories. */
const collectFiles = async (
  path: string,
  include: string | undefined,
  signal: AbortSignal,
  roots: readonly string[],
): Promise<string[]> => {
  const stat = await lstat(path)
  if (stat.isFile() || stat.isSymbolicLink()) {
    const real = await realpath(path).catch(() => path)
    if (!roots.some((root) => isInsidePath(root, real))) return []
    return include && !path.includes(include) ? [] : [path]
  }
  const entries = await readdir(path, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (signal.aborted) break
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(child, include, signal, roots)))
    else files.push(...(await collectFiles(child, include, signal, roots)))
  }
  return files
}
