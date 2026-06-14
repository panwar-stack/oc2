import { z } from "zod"

import { resolveWorkspacePath } from "../roots"
import { ToolExecutionError, type ToolDefinition } from "../tool"
import { booleanProperty, objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  filePath: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
})

export const createEditTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "edit",
  description: "Replace text in a file inside a writable workspace root.",
  inputSchema,
  modelInputSchema: objectSchema(
    {
      filePath: stringProperty("File path to edit"),
      oldString: stringProperty("Exact text to replace"),
      newString: stringProperty("Replacement text"),
      replaceAll: booleanProperty("Replace all matches instead of exactly one"),
    },
    ["filePath", "oldString", "newString"],
  ),
  permission: { action: "edit", resource: (input) => input.filePath },
  async execute(input, context) {
    const target = await resolveWorkspacePath(input.filePath, context.workspaceRoots, { cwd: context.cwd, writable: true, mustExist: true })
    const original = await Bun.file(target.path).text()
    const matches = original.split(input.oldString).length - 1
    if (matches === 0) throw new ToolExecutionError({ code: "edit_no_match", message: "oldString was not found" })
    if (!input.replaceAll && matches > 1) throw new ToolExecutionError({ code: "edit_ambiguous", message: "oldString matched more than once" })
    const updated = input.replaceAll ? original.replaceAll(input.oldString, input.newString) : original.replace(input.oldString, input.newString)
    await Bun.write(target.path, updated)
    return { path: target.path, replacements: input.replaceAll ? matches : 1 }
  },
})
