import { Glob } from "bun"
import { realpath } from "node:fs/promises"
import { z } from "zod"

import { isInsidePath, normalizeWorkspaceRoots, resolveWorkspacePath } from "../roots"
import type { ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
})

export const createGlobTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "glob",
  description: "Find files by glob pattern inside workspace roots.",
  inputSchema,
  modelInputSchema: objectSchema({ pattern: stringProperty("Glob pattern"), path: stringProperty("Directory to search") }, ["pattern"]),
  permission: { action: "read", resource: (input) => input.path ?? input.pattern },
  async execute(input, context) {
    const base = await resolveWorkspacePath(input.path ?? ".", context.workspaceRoots, { cwd: context.cwd, mustExist: true })
    const glob = new Glob(input.pattern)
    const matches: string[] = []
    const roots = normalizeWorkspaceRoots(context.workspaceRoots, context.cwd)
    const realRoots = await Promise.all(roots.map((root) => realpath(root.path).catch(() => root.path)))
    for await (const match of glob.scan({ cwd: base.path, absolute: true, onlyFiles: false })) {
      const realMatch = await realpath(match).catch(() => match)
      if (!roots.some((root) => isInsidePath(root.path, match)) && !realRoots.some((root) => isInsidePath(root, realMatch))) continue
      matches.push(match)
      if (matches.length >= 1_000) break
    }
    return { path: base.path, matches: matches.toSorted(), truncated: matches.length >= 1_000 }
  },
})
