import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"

import { resolveWorkspacePath } from "../roots"
import type { ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
})

/** Creates the built-in write tool that creates parent directories inside writable workspace roots. */
export const createWriteTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "write",
  description: "Write a file inside a writable workspace root.",
  inputSchema,
  modelInputSchema: objectSchema({ filePath: stringProperty("File path to write"), content: stringProperty("Complete file content") }, ["filePath", "content"]),
  permission: { action: "write", resource: (input) => input.filePath },
  async execute(input, context) {
    const target = await resolveWorkspacePath(input.filePath, context.workspaceRoots, { cwd: context.cwd, writable: true })
    await mkdir(dirname(target.path), { recursive: true })
    await Bun.write(target.path, input.content)
    return { path: target.path, bytes: new TextEncoder().encode(input.content).byteLength }
  },
})
