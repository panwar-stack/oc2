import { expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createBuiltInToolRegistry } from "../../src/tools/builtins/index"
import { createToolExecutor } from "../../src/tools/execution"
import { createTempWorkspace } from "./helpers"

test("read, glob, grep, write, edit, bash, webfetch, todowrite, and question work within roots", async () => {
  const workspace = await createTempWorkspace()
  try {
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
    const context = {
      workspaceRoots: [workspace.root],
      fetch: async () => new Response("hello web", { headers: { "content-type": "text/plain" } }),
      resolveQuestion: async () => ["Yes"],
      updateTodos: async (input: unknown) => input,
    }

    await expect(
      executor.execute(
        { id: "write", name: "write", arguments: { filePath: "src/a.txt", content: "alpha\nbeta" } },
        context,
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      executor.execute({ id: "read", name: "read", arguments: { filePath: "src/a.txt" } }, context),
    ).resolves.toMatchObject({ ok: true, outputText: expect.stringContaining("alpha") })
    await expect(
      executor.execute(
        { id: "edit", name: "edit", arguments: { filePath: "src/a.txt", oldString: "beta", newString: "gamma" } },
        context,
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect(readFile(join(workspace.path, "src/a.txt"), "utf8")).resolves.toContain("gamma")
    await expect(
      executor.execute({ id: "glob", name: "glob", arguments: { pattern: "**/*.txt" } }, context),
    ).resolves.toMatchObject({ ok: true, outputText: expect.stringContaining("a.txt") })
    await expect(
      executor.execute({ id: "grep", name: "grep", arguments: { pattern: "gamma", path: "." } }, context),
    ).resolves.toMatchObject({ ok: true, outputText: expect.stringContaining("gamma") })
    await expect(
      executor.execute({ id: "bash", name: "bash", arguments: { command: "pwd", cwd: "." } }, context),
    ).resolves.toMatchObject({ ok: true, outputText: expect.stringContaining(workspace.path) })
    await expect(
      executor.execute({ id: "web", name: "webfetch", arguments: { url: "https://example.com" } }, context),
    ).resolves.toMatchObject({ ok: true, outputText: expect.stringContaining("hello web") })
    await expect(
      executor.execute(
        {
          id: "todo",
          name: "todowrite",
          arguments: { todos: [{ content: "ship", status: "in_progress", priority: "high" }] },
        },
        context,
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      executor.execute({ id: "question", name: "question", arguments: { question: "Continue?" } }, context),
    ).resolves.toMatchObject({ ok: true, outputText: expect.stringContaining("Yes") })
  } finally {
    await workspace.cleanup()
  }
})

test("mutating built-ins reject readonly roots and external paths", async () => {
  const workspace = await createTempWorkspace()
  try {
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
    const readonlyRoot = { ...workspace.root, readonly: true }

    await expect(
      executor.execute(
        { id: "readonly", name: "write", arguments: { filePath: "a.txt", content: "x" } },
        { workspaceRoots: [readonlyRoot] },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "readonly_root" } })
    await expect(
      executor.execute(
        {
          id: "external",
          name: "write",
          arguments: { filePath: join(workspace.path, "../outside.txt"), content: "x" },
        },
        { workspaceRoots: [workspace.root] },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "path_outside_workspace" } })
  } finally {
    await workspace.cleanup()
  }
})

test("filesystem tools reject symlink escapes and glob parent traversal", async () => {
  const workspace = await createTempWorkspace()
  const outside = await createTempWorkspace()
  try {
    await writeFile(join(outside.path, "secret.txt"), "secret\n")
    await symlink(outside.path, join(workspace.path, "linked-outside"), "dir")
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })

    await expect(
      executor.execute(
        { id: "symlink-read", name: "read", arguments: { filePath: "linked-outside/secret.txt" } },
        { workspaceRoots: [workspace.root] },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "path_outside_workspace" } })
    const glob = await executor.execute(
      { id: "glob-escape", name: "glob", arguments: { pattern: "../*" } },
      { workspaceRoots: [workspace.root] },
    )
    const grep = await executor.execute(
      { id: "grep-symlink", name: "grep", arguments: { pattern: "secret", path: "." } },
      { workspaceRoots: [workspace.root] },
    )

    expect(glob.ok).toBe(true)
    if (glob.ok) expect(glob.outputText).not.toContain(outside.path)
    expect(grep.ok).toBe(true)
    if (grep.ok) expect(grep.outputText).not.toContain("secret")
  } finally {
    await outside.cleanup()
    await workspace.cleanup()
  }
})

test("glob accepts canonical root aliases for legitimate matches", async () => {
  const workspace = await createTempWorkspace()
  try {
    await writeFile(join(workspace.path, "alias.txt"), "alias\n")
    const canonical = await import("node:fs/promises").then((fs) => fs.realpath(workspace.path))
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
    const result = await executor.execute(
      { id: "glob-alias", name: "glob", arguments: { pattern: "*.txt" } },
      { workspaceRoots: [{ ...workspace.root, path: canonical }], cwd: workspace.path },
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outputText).toContain("alias.txt")
  } finally {
    await workspace.cleanup()
  }
})

test("bash command timeout returns a structured tool error", async () => {
  const workspace = await createTempWorkspace()
  try {
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })

    await expect(
      executor.execute(
        { id: "bash-timeout", name: "bash", arguments: { command: "sleep 1", timeoutMs: 1 } },
        { workspaceRoots: [workspace.root] },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "timed_out" } })
  } finally {
    await workspace.cleanup()
  }
})

test("opengrep is root-restricted and fallback-aware when binary is unavailable", async () => {
  const workspace = await createTempWorkspace()
  const previous = process.env.OC2_OPENGREP_DISABLE
  process.env.OC2_OPENGREP_DISABLE = "1"
  try {
    await mkdir(join(workspace.path, "src"), { recursive: true })
    await writeFile(join(workspace.path, "src/a.ts"), "const value = 1\n")
    const executor = createToolExecutor({ registry: createBuiltInToolRegistry() })
    const result = await executor.execute(
      { id: "opengrep", name: "opengrep", arguments: { pattern: "const $X = 1", path: "src" } },
      { workspaceRoots: [workspace.root] },
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outputText).toContain("available")
  } finally {
    if (previous === undefined) delete process.env.OC2_OPENGREP_DISABLE
    else process.env.OC2_OPENGREP_DISABLE = previous
    await workspace.cleanup()
  }
})
