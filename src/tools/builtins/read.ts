import { lstat, readdir } from "node:fs/promises"
import { z } from "zod"

import { resolveWorkspacePath } from "../roots"
import type { ToolDefinition } from "../tool"
import { numberProperty, objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  filePath: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
})

export const createReadTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "read",
  description: "Read a file or list a directory inside the workspace roots.",
  inputSchema,
  modelInputSchema: objectSchema(
    {
      filePath: stringProperty("File or directory path to read"),
      offset: numberProperty("1-based line offset for text files"),
      limit: numberProperty("Maximum number of lines to return"),
    },
    ["filePath"],
  ),
  permission: { action: "read", resource: (input) => input.filePath },
  async execute(input, context) {
    const target = await resolveWorkspacePath(input.filePath, context.workspaceRoots, { cwd: context.cwd, mustExist: true })
    const stat = await lstat(target.path)
    if (stat.isFile()) {
      const file = Bun.file(target.path)
      const text = await file.text()
      const lines = text.split("\n")
      const start = Math.max((input.offset ?? 1) - 1, 0)
      const selected = lines.slice(start, start + (input.limit ?? 2_000))
      return { path: target.path, type: "file", content: selected.map((line, index) => `${start + index + 1}: ${line}`).join("\n") }
    }

    const entries = await readdir(target.path, { withFileTypes: true })
    return { path: target.path, type: "directory", entries: entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).toSorted() }
  },
})
