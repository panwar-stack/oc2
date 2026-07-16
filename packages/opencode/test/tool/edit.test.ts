import { afterEach, describe, expect } from "bun:test"
import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { SessionCompoundToolPolicy } from "../../src/session/compound/tool-policy"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Watcher } from "@oc2-ai/core/filesystem/watcher"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Format.defaultLayer,
  EventV2Bridge.defaultLayer,
  Session.defaultLayer,
  testInstanceStoreLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

type ScratchRole = { type: "branch"; index: number; tempDir: string } | { type: "judge"; tempDir: string }

function scratchRules(root: string, role: ScratchRole, parent: PermissionV1.Ruleset = []): PermissionV1.Ruleset {
  return SessionCompoundToolPolicy.resolveChildPermission(parent, "parent_without_teams", {
    role,
    root,
  })
}

function permissionCtx(ruleset: PermissionV1.Ruleset): Tool.Context {
  return {
    ...ctx,
    ask: (request) => {
      const denied = request.patterns.find(
        (pattern) =>
          (Array.isArray(request.metadata["filesystemCaseUnknown"]) &&
          request.metadata["filesystemCaseUnknown"].includes(pattern)
            ? Permission.evaluateFilesystemUnknown(request.permission, pattern, ruleset)
            : Array.isArray(request.metadata["filesystemCaseInsensitive"]) &&
                request.metadata["filesystemCaseInsensitive"].includes(pattern)
              ? Permission.evaluateFilesystem(request.permission, pattern, ruleset)
              : Permission.evaluate(request.permission, pattern, ruleset)
          ).action !== "allow",
      )
      if (denied) return Effect.die(new PermissionV1.DeniedError({ ruleset }))
      return Effect.void
    },
  }
}

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  it.live("allows local fusion scratch edits and denies workspace edits", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const tempDir = yield* tmpdirScoped()
      const ruleset = scratchRules(primary, { type: "judge", tempDir })
      const workspaceFile = path.join(primary, "workspace.txt")
      const scratchFile = path.join(tempDir, "scratch.txt")
      yield* put(workspaceFile, "old workspace")
      yield* put(scratchFile, "old scratch")

      const denied = yield* provideInstance(primary)(
        run({ filePath: workspaceFile, oldString: "old", newString: "new" }, permissionCtx(ruleset)).pipe(Effect.exit),
      )
      expect(denied._tag).toBe("Failure")
      expect(yield* load(workspaceFile)).toBe("old workspace")

      yield* provideInstance(primary)(
        run({ filePath: scratchFile, oldString: "old", newString: "new" }, permissionCtx(ruleset)),
      )
      expect(yield* load(scratchFile)).toBe("new scratch")
    }),
  )

  it.live("keeps parent edit deny above judge scratch edit allow", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const tempDir = yield* tmpdirScoped()
      const ruleset = scratchRules(primary, { type: "judge", tempDir }, [
        { permission: "edit", pattern: "*", action: "deny" },
      ])
      const scratchFile = path.join(tempDir, "scratch.txt")
      yield* put(scratchFile, "old scratch")

      const denied = yield* provideInstance(primary)(
        run({ filePath: scratchFile, oldString: "old", newString: "new" }, permissionCtx(ruleset)).pipe(Effect.exit),
      )

      expect(denied._tag).toBe("Failure")
      expect(yield* load(scratchFile)).toBe("old scratch")
    }),
  )

  it.live("denies edits to sibling scratch directories", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const branchDir = yield* tmpdirScoped()
      const siblingDir = yield* tmpdirScoped()
      const judgeDir = yield* tmpdirScoped()
      const ruleset = scratchRules(primary, { type: "branch", index: 0, tempDir: branchDir })
      const siblingFile = path.join(siblingDir, "sibling.txt")
      const judgeFile = path.join(judgeDir, "judge.txt")
      yield* put(siblingFile, "old sibling")
      yield* put(judgeFile, "old judge")

      expect(
        (yield* provideInstance(primary)(
          run({ filePath: siblingFile, oldString: "old", newString: "new" }, permissionCtx(ruleset)).pipe(Effect.exit),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* provideInstance(primary)(
          run({ filePath: judgeFile, oldString: "old", newString: "new" }, permissionCtx(ruleset)).pipe(Effect.exit),
        ))._tag,
      ).toBe("Failure")
      expect(yield* load(siblingFile)).toBe("old sibling")
      expect(yield* load(judgeFile)).toBe("old judge")
    }),
  )

  it.live("denies branch and judge edits to secondary session roots", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const branchDir = yield* tmpdirScoped()
      const judgeDir = yield* tmpdirScoped()
      const branchRules = scratchRules(primary, { type: "branch", index: 0, tempDir: branchDir })
      const judgeRules = scratchRules(primary, { type: "judge", tempDir: judgeDir })
      const branchFile = path.join(secondary, "branch.txt")
      const judgeFile = path.join(secondary, "judge.txt")
      yield* put(branchFile, "old branch")
      yield* put(judgeFile, "old judge")
      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      expect(
        (yield* provideInstance(primary)(
          run(
            { filePath: branchFile, oldString: "old", newString: "new" },
            { ...permissionCtx(branchRules), sessionID: info.id },
          ).pipe(Effect.exit),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* provideInstance(primary)(
          run(
            { filePath: judgeFile, oldString: "old", newString: "new" },
            { ...permissionCtx(judgeRules), sessionID: info.id },
          ).pipe(Effect.exit),
        ))._tag,
      ).toBe("Failure")
      expect(yield* load(branchFile)).toBe("old branch")
      expect(yield* load(judgeFile)).toBe("old judge")
    }),
  )

  it.live("edits absolute paths inside a registered secondary root", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const filepath = path.join(secondary, "edit.txt")
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      yield* put(filepath, "old value")

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      yield* provideInstance(primary)(
        run(
          { filePath: filepath, oldString: "old", newString: "new" },
          {
            ...ctx,
            sessionID: info.id,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request)
              }),
          },
        ),
      )

      expect(yield* load(filepath)).toBe("new value")
      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
      expect(requests.find((request) => request.permission === "edit")?.patterns).toEqual(["edit.txt"])
    }),
  )

  it.live("automation-safe edits treat registered secondary roots as external", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const filepath = path.join(secondary, "edit.txt")
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      yield* put(filepath, "old value")

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "automation roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      const exit = yield* provideInstance(primary)(
        run(
          { filePath: filepath, oldString: "old", newString: "new" },
          {
            ...ctx,
            sessionID: info.id,
            extra: { automationSafe: true },
            ask: (request) => {
              requests.push(request)
              if (request.permission === "external_directory") return Effect.die(new Error("denied"))
              return Effect.void
            },
          },
        ).pipe(Effect.exit),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* load(filepath)).toBe("old value")
      expect(requests.find((request) => request.permission === "external_directory")).toBeDefined()
      expect(requests.find((request) => request.permission === "edit")).toBeUndefined()
    }),
  )

  it.live("denies edits through an internal symlink to an external directory", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const primary = yield* tmpdirScoped({ git: true })
      const outside = yield* tmpdirScoped()
      const filepath = path.join(outside, "secret.txt")
      yield* put(filepath, "old secret")
      yield* Effect.promise(() => fs.symlink(outside, path.join(primary, "linked"), "dir"))
      const requests: Parameters<Tool.Context["ask"]>[0][] = []

      const exit = yield* provideInstance(primary)(
        run(
          { filePath: path.join(primary, "linked", "secret.txt"), oldString: "old", newString: "new" },
          {
            ...ctx,
            ask: (request) => {
              requests.push(request)
              if (request.permission === "external_directory") return Effect.die(new Error("denied"))
              return Effect.void
            },
          },
        ).pipe(Effect.exit),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* load(filepath)).toBe("old secret")
      expect(requests.find((request) => request.permission === "external_directory")?.patterns).toEqual([
        path.join(yield* Effect.promise(() => fs.realpath(outside)), "*").replaceAll("\\", "/"),
      ])
      expect(requests.find((request) => request.permission === "edit")).toBeUndefined()
    }),
  )

  if (process.platform === "darwin") {
    it.live("uses canonical casing for edit authorization", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const filepath = path.join(primary, "MixedCase", "File.txt")
        yield* put(filepath, "old value")
        const requests: Parameters<Tool.Context["ask"]>[0][] = []

        yield* provideInstance(primary)(
          run(
            { filePath: path.join(primary, "mixedcase", "file.txt"), oldString: "old", newString: "new" },
            {
              ...ctx,
              ask: (request) =>
                Effect.sync(() => {
                  requests.push(request)
                }),
            },
          ),
        )

        expect(yield* load(filepath)).toBe("new value")
        expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
        expect(requests.find((request) => request.permission === "edit")?.patterns).toEqual([
          path.join("mixedcase", "file.txt"),
        ])
      }),
    )

    it.live("denies missing mixed-case protected directories", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const target = path.join(primary, "packages", "app", ".OC2", "plugin.ts")
        const ruleset: PermissionV1.Ruleset = [
          { permission: "edit", pattern: "*", action: "allow" },
          { permission: "edit", pattern: "**/.oc2/**", action: "deny" },
        ]

        const exit = yield* provideInstance(primary)(
          run({ filePath: target, oldString: "", newString: "malicious" }, permissionCtx(ruleset)).pipe(Effect.exit),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* Effect.promise(() => fs.stat(target)).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )

    it.live("matches uppercase protected filenames case-insensitively", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const target = path.join(primary, "AGENTS.md")
        yield* put(target, "protected")
        const ruleset: PermissionV1.Ruleset = [
          { permission: "edit", pattern: "*", action: "allow" },
          { permission: "edit", pattern: "AGENTS.md", action: "deny" },
        ]

        const exit = yield* provideInstance(primary)(
          run({ filePath: path.join(primary, "agents.md"), oldString: "protected", newString: "changed" }, permissionCtx(ruleset)).pipe(
            Effect.exit,
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* load(target)).toBe("protected")
      }),
    )
  }

  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("rejects empty oldString on existing files and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const original = `${bom}using System;\n`
        yield* put(filepath, original)

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "using Up;\n" })).message).toContain(
          "oldString cannot be empty",
        )

        const content = yield* loadRaw(filepath)
        expect(content).toBe(original)
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    it.instance("rejects loose block-anchor matches and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = [
          "function configure() {",
          "  keepImportantState()",
          "  removeAllUserData()",
          "  archiveBackups()",
          "  auditLog()",
          "}",
        ].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("rejects block-anchor matches with unrelated middle content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        const original = ["function configure() {", "  removeAllUserData()", "}"].join("\n")
        yield* put(filepath, original)

        expect(
          (yield* fail({
            filePath: filepath,
            oldString: ["function configure() {", "  const enabled = true", "}"].join("\n"),
            newString: ["function configure() {", "  const enabled = false", "}"].join("\n"),
          })).message,
        ).toContain("Could not find oldString")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })
})
