import { rm, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"

import { resolveWorkspacePath } from "../roots"
import { ToolExecutionError, type ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({ patch: z.string().min(1) })

type PatchOperation =
  | { readonly type: "add"; readonly path: string; readonly lines: readonly string[] }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "update"; readonly path: string; readonly lines: readonly string[] }

export const createApplyPatchTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "apply_patch",
  description: "Apply a simple file-oriented patch inside writable workspace roots.",
  inputSchema,
  modelInputSchema: objectSchema({ patch: stringProperty("Patch text with Begin/End Patch envelope") }, ["patch"]),
  permission: { action: "edit", resource: () => "patch" },
  async execute(input, context) {
    const operations = parsePatch(input.patch)
    const resolved = []
    for (const operation of operations) {
      resolved.push({ operation, target: await resolveWorkspacePath(operation.path, context.workspaceRoots, { cwd: context.cwd, writable: true }) })
    }

    const results: Array<{ path: string; action: string }> = []
    for (const { operation, target } of resolved) {
      if (operation.type === "add") {
        await mkdir(dirname(target.path), { recursive: true })
        await Bun.write(target.path, operation.lines.join("\n"))
      } else if (operation.type === "delete") {
        await rm(target.path)
      } else {
        const original = await Bun.file(target.path).text()
        await Bun.write(target.path, applyUpdate(original, operation.lines))
      }
      results.push({ path: target.path, action: operation.type })
    }
    return { applied: results.length, results }
  },
})

const parsePatch = (patch: string): PatchOperation[] => {
  const lines = patch.replaceAll("\r\n", "\n").split("\n")
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new ToolExecutionError({ code: "invalid_patch", message: "Patch must start with *** Begin Patch and end with *** End Patch" })
  }
  const operations: PatchOperation[] = []
  let index = 1
  while (index < lines.length - 1) {
    const line = lines[index] ?? ""
    const add = line.match(/^\*\*\* Add File: (.+)$/)
    const update = line.match(/^\*\*\* Update File: (.+)$/)
    const remove = line.match(/^\*\*\* Delete File: (.+)$/)
    if (line.startsWith("*** Move to:")) throw new ToolExecutionError({ code: "unsupported_patch", message: "Move patches are not supported" })
    if (!add && !update && !remove) throw new ToolExecutionError({ code: "invalid_patch", message: `Unexpected patch line: ${line}` })
    index += 1
    const body: string[] = []
    while (index < lines.length - 1 && !lines[index]?.startsWith("*** ")) {
      body.push(lines[index] ?? "")
      index += 1
    }
    if (add) operations.push({ type: "add", path: add[1] ?? "", lines: body.map((entry) => entry.startsWith("+") ? entry.slice(1) : entry) })
    if (update) operations.push({ type: "update", path: update[1] ?? "", lines: body })
    if (remove) operations.push({ type: "delete", path: remove[1] ?? "" })
  }
  if (operations.length === 0) throw new ToolExecutionError({ code: "invalid_patch", message: "Patch did not contain any file operations" })
  return operations
}

const applyUpdate = (original: string, lines: readonly string[]): string => {
  let updated = original
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (line.startsWith("@@") || line.startsWith(" ")) continue
    if (line.startsWith("-") && lines[index + 1]?.startsWith("+")) {
      const oldText = line.slice(1)
      const newText = (lines[index + 1] ?? "").slice(1)
      if (!updated.includes(oldText)) throw new ToolExecutionError({ code: "patch_no_match", message: `Patch line was not found: ${oldText}` })
      updated = updated.replace(oldText, newText)
      index += 1
    } else if (line.startsWith("-")) {
      const oldText = line.slice(1)
      if (!updated.includes(oldText)) throw new ToolExecutionError({ code: "patch_no_match", message: `Patch line was not found: ${oldText}` })
      updated = updated.replace(oldText, "")
    } else if (line.startsWith("+")) {
      updated += `${updated.endsWith("\n") ? "" : "\n"}${line.slice(1)}`
    }
  }
  return updated
}
