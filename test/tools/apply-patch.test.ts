import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createBuiltInToolRegistry } from "../../src/tools/builtins/index"
import { createToolExecutor } from "../../src/tools/execution"
import { createTempWorkspace } from "./helpers"

test("apply_patch adds, updates, and deletes files inside writable roots", async () => {
  const workspace = await createTempWorkspace()
  try {
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
    await writeFile(join(workspace.path, "old.txt"), "before\n")
    await writeFile(join(workspace.path, "delete.txt"), "remove\n")
    const patch = [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+hello",
      "*** Update File: old.txt",
      "-before",
      "+after",
      "*** Delete File: delete.txt",
      "*** End Patch",
    ].join("\n")

    await expect(executor.execute({ id: "patch", name: "apply_patch", arguments: { patch } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: true })
    await expect(readFile(join(workspace.path, "added.txt"), "utf8")).resolves.toBe("hello")
    await expect(readFile(join(workspace.path, "old.txt"), "utf8")).resolves.toContain("after")
    await expect(Bun.file(join(workspace.path, "delete.txt")).exists()).resolves.toBe(false)
  } finally {
    await workspace.cleanup()
  }
})

test("apply_patch rejects empty, move, and path escape patches as structured errors", async () => {
  const workspace = await createTempWorkspace()
  try {
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
    const empty = "*** Begin Patch\n*** End Patch"
    const move = "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch"
    const escape = "*** Begin Patch\n*** Add File: ../outside.txt\n+x\n*** End Patch"

    await expect(executor.execute({ id: "empty", name: "apply_patch", arguments: { patch: empty } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: false, error: { code: "invalid_patch" } })
    await expect(executor.execute({ id: "move", name: "apply_patch", arguments: { patch: move } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: false, error: { code: "unsupported_patch" } })
    await expect(executor.execute({ id: "escape", name: "apply_patch", arguments: { patch: escape } }, { workspaceRoots: [workspace.root] })).resolves.toMatchObject({ ok: false, error: { code: "path_outside_workspace" } })
  } finally {
    await workspace.cleanup()
  }
})
