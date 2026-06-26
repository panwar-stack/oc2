import { describe, expect } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import path from "path"
import * as fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { Permission } from "../../src/permission"
import { SessionCompoundToolPolicy } from "../../src/session/compound/tool-policy"

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    Session.defaultLayer,
    testInstanceStoreLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: {
    diff: string
    filepath: string
    files: Array<{
      filePath: string
      relativePath: string
      type: "add" | "update" | "delete" | "move"
      patch: string
      additions: number
      deletions: number
      movePath?: string
    }>
  }
}

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Effect.Effect<void>
}

const execute = Effect.fn("ApplyPatchToolTest.execute")(function* (params: { patchText: string }, ctx: ToolCtx) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const makeCtx = () => {
  const calls: AskInput[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }),
  }

  return { ctx, calls }
}

const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))
const makeDir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

type ScratchRole = { type: "branch"; index: number; tempDir: string } | { type: "judge"; tempDir: string }

const scratchRules = (root: string, role: ScratchRole) =>
  SessionCompoundToolPolicy.resolveChildPermission([], "all", { role, root })

const permissionCtx = (ruleset: PermissionV1.Ruleset): ToolCtx => ({
  ...baseCtx,
  ask: (request) => {
    const denied = request.patterns.find(
      (pattern) => Permission.evaluate(request.permission, pattern, ruleset).action !== "allow",
    )
    if (denied) return Effect.die(new PermissionV1.DeniedError({ ruleset }))
    return Effect.void
  },
})

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

const expectReadFailure = (filepath: string) => expectFailure(readText(filepath))

describe("tool.apply_patch freeform", () => {
  it.live("applies absolute patch paths inside a registered secondary root", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const filepath = path.join(secondary, "added.txt")
      const requests: Array<{ permission: string; patterns: readonly string[] }> = []
      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )
      const tool = yield* (yield* ApplyPatchTool).init()

      yield* provideInstance(primary)(
        tool.execute(
          {
            patchText: ["*** Begin Patch", `*** Add File: ${filepath}`, "+hello", "*** End Patch"].join("\n"),
          },
          {
            ...baseCtx,
            sessionID: info.id,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request)
              }),
          },
        ),
      )

      expect(yield* readText(filepath)).toBe("hello\n")
      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
      expect(requests.find((request) => request.permission === "apply_patch")?.patterns).toEqual(["added.txt"])
    }),
  )

  it.live("requires patchText", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "" }, ctx), "patchText is required")
    }),
  )

  it.live("rejects invalid patch format", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "invalid patch" }, ctx), "apply_patch verification failed")
    }),
  )

  it.live("rejects empty patch", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "*** Begin Patch\n*** End Patch" }, ctx), "patch rejected: empty patch")
    }),
  )

  it.instance(
    "applies add/update/delete in one patch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const modifyPath = path.join(test.directory, "modify.txt")
        const deletePath = path.join(test.directory, "delete.txt")
        yield* writeText(modifyPath, "line1\nline2\n")
        yield* writeText(deletePath, "obsolete\n")

        const patchText =
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

        const result = yield* execute({ patchText }, ctx)

        expect(result.title).toContain("Success. Updated the following files")
        expect(result.output).toContain("Success. Updated the following files")
        // Strict formatting assertions for slashes
        expect(result.output).toMatch(/A nested\/new\.txt/)
        expect(result.output).toMatch(/D delete\.txt/)
        expect(result.output).toMatch(/M modify\.txt/)
        if (process.platform === "win32") {
          expect(result.output).not.toContain("\\")
        }
        expect(result.metadata.diff).toContain("Index:")
        expect(calls.map((call) => call.permission)).toEqual(["apply_patch"])

        // Verify permission metadata includes files array for UI rendering
        const permissionCall = calls.find((call) => call.permission === "apply_patch")
        expect(permissionCall).toBeDefined()
        if (!permissionCall) throw new Error("missing apply_patch permission call")
        expect(permissionCall.metadata.files).toHaveLength(3)
        expect(permissionCall.metadata.files.map((f) => f.type).sort()).toEqual(["add", "delete", "update"])

        const addFile = permissionCall.metadata.files.find((f) => f.type === "add")
        expect(addFile?.relativePath).toBe("nested/new.txt")
        expect(addFile?.patch).toContain("+created")

        const updateFile = permissionCall.metadata.files.find((f) => f.type === "update")
        expect(updateFile?.patch).toContain("-line2")
        expect(updateFile?.patch).toContain("+changed")

        expect(yield* readText(path.join(test.directory, "nested", "new.txt"))).toBe("created\n")
        expect(yield* readText(modifyPath)).toBe("line1\nchanged\n")
        yield* expectReadFailure(deletePath)
      }),
    { git: true },
  )

  it.instance(
    "permission metadata includes move file info",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const original = path.join(test.directory, "old", "name.txt")
        yield* makeDir(path.dirname(original))
        yield* writeText(original, "old content\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(calls.map((call) => call.permission)).toEqual(["apply_patch"])
        const permissionCall = calls.find((call) => call.permission === "apply_patch")
        expect(permissionCall).toBeDefined()
        if (!permissionCall) throw new Error("missing apply_patch permission call")
        expect(permissionCall.metadata.files).toHaveLength(1)

        const moveFile = permissionCall.metadata.files[0]
        expect(moveFile.type).toBe("move")
        expect(moveFile.relativePath).toBe("renamed/dir/name.txt")
        expect(moveFile.movePath).toBe(path.join(test.directory, "renamed/dir/name.txt"))
        expect(moveFile.patch).toContain("-old content")
        expect(moveFile.patch).toContain("+new content")
      }),
    { git: true },
  )

  it.instance("applies multiple hunks to one file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi.txt")
      yield* writeText(target, "line1\nline2\nline3\nline4\n")

      const patchText =
        "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("line1\nchanged2\nline3\nchanged4\n")
    }),
  )

  it.instance("does not invent a first-line diff for BOM files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const bom = String.fromCharCode(0xfeff)
      const target = path.join(test.directory, "example.cs")
      yield* writeText(target, `${bom}using System;\n\nclass Test {}\n`)

      const patchText =
        "*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(calls.map((call) => call.permission)).toEqual(["apply_patch"])
      const shown = calls.find((call) => call.permission === "apply_patch")?.metadata.files[0]?.patch ?? ""
      expect(shown).not.toContain(bom)
      expect(shown).not.toContain("-using System;")
      expect(shown).not.toContain("+using System;")

      const content = yield* readText(target)
      expect(content.charCodeAt(0)).toBe(0xfeff)
      expect(content.slice(1)).toBe("using System;\n\nclass Test {}\nclass Next {}\n")
    }),
  )

  it.live("denies branch and judge scratch apply_patch when invoked directly", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const branchDir = yield* tmpdirScoped()
      const judgeDir = yield* tmpdirScoped()

      const branchRules = scratchRules(primary, { type: "branch", index: 0, tempDir: branchDir })
      const judgeRules = scratchRules(primary, { type: "judge", tempDir: judgeDir })
      expect(Permission.evaluate("apply_patch", "*", branchRules).action).toBe("deny")
      expect(Permission.evaluate("apply_patch", "*", judgeRules).action).toBe("deny")

      const branchFile = path.join(branchDir, "branch.txt")
      const judgeFile = path.join(judgeDir, "judge.txt")
      yield* writeText(branchFile, "old branch\n")
      yield* writeText(judgeFile, "old judge\n")

      yield* provideInstance(primary)(
        expectFailure(
          execute(
            {
              patchText: [
                "*** Begin Patch",
                `*** Update File: ${branchFile}`,
                "@@",
                "-old branch",
                "+new branch",
                "*** End Patch",
              ].join("\n"),
            },
            permissionCtx(branchRules),
          ),
        ),
      )
      yield* provideInstance(primary)(
        expectFailure(
          execute(
            {
              patchText: [
                "*** Begin Patch",
                `*** Update File: ${judgeFile}`,
                "@@",
                "-old judge",
                "+new judge",
                "*** End Patch",
              ].join("\n"),
            },
            permissionCtx(judgeRules),
          ),
        ),
      )

      expect(yield* readText(branchFile)).toBe("old branch\n")
      expect(yield* readText(judgeFile)).toBe("old judge\n")
    }),
  )

  it.live("denies mixed branch scratch and workspace patches atomically", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const tempDir = yield* tmpdirScoped()
      const ruleset = scratchRules(primary, { type: "branch", index: 0, tempDir })
      const workspaceFile = path.join(primary, "workspace.txt")
      const scratchFile = path.join(tempDir, "scratch.txt")
      yield* writeText(workspaceFile, "old workspace\n")
      yield* writeText(scratchFile, "old scratch\n")

      yield* provideInstance(primary)(
        expectFailure(
          execute(
            {
              patchText: [
                "*** Begin Patch",
                `*** Update File: ${scratchFile}`,
                "@@",
                "-old scratch",
                "+new scratch",
                "*** Update File: workspace.txt",
                "@@",
                "-old workspace",
                "+new workspace",
                "*** End Patch",
              ].join("\n"),
            },
            permissionCtx(ruleset),
          ),
        ),
      )

      expect(yield* readText(workspaceFile)).toBe("old workspace\n")
      expect(yield* readText(scratchFile)).toBe("old scratch\n")
    }),
  )

  it.instance("allows apply_patch through existing edit permission rules", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "edit-allowed.txt")
      yield* writeText(target, "old\n")

      yield* execute(
        {
          patchText: "*** Begin Patch\n*** Update File: edit-allowed.txt\n@@\n-old\n+new\n*** End Patch",
        },
        permissionCtx([{ permission: "edit", pattern: "*", action: "allow" }]),
      )

      expect(Permission.evaluate("apply_patch", "edit-allowed.txt", [
        { permission: "edit", pattern: "*", action: "allow" },
      ]).action).toBe("allow")
      expect(yield* readText(target)).toBe("new\n")
    }),
  )

  it.instance("keeps edit deny authoritative over apply_patch allow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "edit-denied.txt")
      const ruleset: PermissionV1.Ruleset = [
        { permission: "apply_patch", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "deny" },
      ]
      yield* writeText(target, "old\n")

      expect(Permission.evaluate("apply_patch", "edit-denied.txt", ruleset).action).toBe("deny")
      yield* expectFailure(
        execute(
          {
            patchText: "*** Begin Patch\n*** Update File: edit-denied.txt\n@@\n-old\n+new\n*** End Patch",
          },
          permissionCtx(ruleset),
        ),
      )

      expect(yield* readText(target)).toBe("old\n")
    }),
  )

  it.instance("keeps edit deny authoritative over apply_patch allow for move destinations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const source = path.join(test.directory, "source.txt")
      const destination = path.join(test.directory, "blocked.txt")
      const ruleset: PermissionV1.Ruleset = [
        { permission: "apply_patch", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "blocked.txt", action: "deny" },
      ]
      yield* writeText(source, "old\n")

      expect(Permission.evaluate("apply_patch", "source.txt", ruleset).action).toBe("allow")
      expect(Permission.evaluate("apply_patch", "blocked.txt", ruleset).action).toBe("deny")
      yield* expectFailure(
        execute(
          {
            patchText:
              "*** Begin Patch\n*** Update File: source.txt\n*** Move to: blocked.txt\n@@\n-old\n+new\n*** End Patch",
          },
          permissionCtx(ruleset),
        ),
      )

      expect(yield* readText(source)).toBe("old\n")
      yield* expectReadFailure(destination)
    }),
  )

  it.instance("honors persisted apply_patch allow when edit is not denied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "apply-patch-allowed.txt")
      const ruleset: PermissionV1.Ruleset = [{ permission: "apply_patch", pattern: "*", action: "allow" }]
      yield* writeText(target, "old\n")

      expect(Permission.evaluate("apply_patch", "apply-patch-allowed.txt", ruleset).action).toBe("allow")
      yield* execute(
        {
          patchText: "*** Begin Patch\n*** Update File: apply-patch-allowed.txt\n@@\n-old\n+new\n*** End Patch",
        },
        permissionCtx(ruleset),
      )

      expect(yield* readText(target)).toBe("new\n")
    }),
  )

  it.instance("inserts lines with insert-only hunk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "insert_only.txt")
      yield* writeText(target, "alpha\nomega\n")

      const patchText = "*** Begin Patch\n*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("alpha\nbeta\nomega\n")
    }),
  )

  it.instance("appends trailing newline on update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "no_newline.txt")
      yield* writeText(target, "no newline at end")

      const patchText =
        "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const contents = yield* readText(target)
      expect(contents.endsWith("\n")).toBe(true)
      expect(contents).toBe("first line\nsecond line\n")
    }),
  )

  it.instance("moves file to a new directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* writeText(original, "old content\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const moved = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* expectReadFailure(original)
      expect(yield* readText(moved)).toBe("new content\n")
    }),
  )

  it.instance("moves file overwriting existing destination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      const destination = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* makeDir(path.dirname(destination))
      yield* writeText(original, "from\n")
      yield* writeText(destination, "existing\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch"

      yield* execute({ patchText }, ctx)

      yield* expectReadFailure(original)
      expect(yield* readText(destination)).toBe("new\n")
    }),
  )

  it.instance("adds file overwriting existing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "old content\n")

      const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("new content\n")
    }),
  )

  it.instance("rejects update when target file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

      yield* expectFailure(
        execute({ patchText }, ctx),
        "apply_patch verification failed: Failed to read file to update",
      )
    }),
  )

  it.instance("rejects delete when file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects delete when target is a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const dirPath = path.join(test.directory, "dir")
      yield* makeDir(dirPath)

      const patchText = "*** Begin Patch\n*** Delete File: dir\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects invalid hunk header", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
    }),
  )

  it.instance("rejects update with missing context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "line1\nline2\n")

      const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
      expect(yield* readText(target)).toBe("line1\nline2\n")
    }),
  )

  it.instance("verification failure leaves no side effects", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText =
        "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      yield* expectReadFailure(path.join(test.directory, "created.txt"))
    }),
  )

  it.instance("supports end of file anchor", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "tail.txt")
      yield* writeText(target, "alpha\nlast\n")

      const patchText = "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("alpha\nend\n")
    }),
  )

  it.instance("rejects missing second chunk context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "two_chunks.txt")
      yield* writeText(target, "a\nb\nc\nd\n")

      const patchText = "*** Begin Patch\n*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      expect(yield* readText(target)).toBe("a\nb\nc\nd\n")
    }),
  )

  it.instance("disambiguates change context with @@ header", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi_ctx.txt")
      yield* writeText(target, "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n")

      const patchText = "*** Begin Patch\n*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
    }),
  )

  it.instance("EOF anchor matches from end of file first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "eof_anchor.txt")
      // File has duplicate "marker" lines - one in middle, one at end
      yield* writeText(target, "start\nmarker\nmiddle\nmarker\nend\n")

      // With EOF anchor, should match the LAST "marker" line, not the first
      const patchText =
        "*** Begin Patch\n*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      // First marker unchanged, second marker changed
      expect(yield* readText(target)).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `cat <<'EOF'
*** Begin Patch
*** Add File: heredoc_test.txt
+heredoc content
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_test.txt"))).toBe("heredoc content\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch without cat", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `<<EOF
*** Begin Patch
*** Add File: heredoc_no_cat.txt
+no cat prefix
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_no_cat.txt"))).toBe("no cat prefix\n")
    }),
  )

  it.instance("matches with trailing whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "trailing_ws.txt")
      // File has trailing spaces on some lines
      yield* writeText(target, "line1  \nline2\nline3   \n")

      // Patch doesn't have trailing spaces - should still match via rstrip pass
      const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("line1  \nchanged\nline3   \n")
    }),
  )

  it.instance("matches with leading whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "leading_ws.txt")
      // File has leading spaces
      yield* writeText(target, "  line1\nline2\n  line3\n")

      // Patch without leading spaces - should match via trim pass
      const patchText = "*** Begin Patch\n*** Update File: leading_ws.txt\n@@\n-line2\n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("  line1\nchanged\n  line3\n")
    }),
  )

  it.instance("matches with Unicode punctuation differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "unicode.txt")
      // File has fancy Unicode quotes (U+201C, U+201D) and em-dash (U+2014)
      const leftQuote = "\u201C"
      const rightQuote = "\u201D"
      const emDash = "\u2014"
      yield* writeText(target, `He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`)

      // Patch uses ASCII equivalents - should match via normalized pass
      // The replacement uses ASCII quotes from the patch (not preserving Unicode)
      const patchText =
        '*** Begin Patch\n*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"\n*** End Patch'

      yield* execute({ patchText }, ctx)
      // Result has ASCII quotes because that's what the patch specifies
      expect(yield* readText(target)).toBe(`He said "hi"\nsome${emDash}dash\nend\n`)
    }),
  )
})
