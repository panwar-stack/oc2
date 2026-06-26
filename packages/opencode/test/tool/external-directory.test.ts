import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { Permission } from "../../src/permission"
import { SessionCompoundToolPolicy } from "../../src/session/compound/tool-policy"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Session.defaultLayer, testInstanceStoreLayer))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

type ScratchRole = { type: "branch"; index: number; tempDir: string } | { type: "judge"; tempDir: string }

function scratchRules(root: string, role: ScratchRole, parent: PermissionV1.Ruleset = []): PermissionV1.Ruleset {
  return SessionCompoundToolPolicy.resolveChildPermission(parent, "all", {
    role,
    root,
  })
}

function evaluatingCtx(ruleset: PermissionV1.Ruleset): Tool.Context {
  return {
    ...baseCtx,
    ask: (request) => {
      const denied = request.patterns.find(
        (pattern) => Permission.evaluate(request.permission, pattern, ruleset).action !== "allow",
      )
      if (denied) return Effect.die(new PermissionV1.DeniedError({ ruleset }))
      return Effect.void
    },
  }
}

describe("tool.assertExternalDirectory", () => {
  it.live("allows only the local fusion scratch external directory", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const tempDir = yield* tmpdirScoped()
      const ruleset = scratchRules(primary, { type: "judge", tempDir })

      yield* provideInstance(primary)(
        assertExternalDirectoryEffect(evaluatingCtx(ruleset), path.join(tempDir, "scratch.txt")),
      )

      const outside = yield* provideInstance(primary)(
        assertExternalDirectoryEffect(evaluatingCtx(ruleset), path.join(path.dirname(tempDir), "outside", "scratch.txt")).pipe(
          Effect.exit,
        ),
      )
      expect(outside._tag).toBe("Failure")
    }),
  )

  it.live("does not disable edit tools when broad deny has a temp-specific allow", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const tempDir = yield* tmpdirScoped()

      expect(
        Permission.disabled(["write", "edit", "apply_patch", "team_create"], scratchRules(primary, { type: "judge", tempDir })),
      ).toEqual(new Set([]))

      expect(
        Permission.disabled(
          ["write", "edit", "apply_patch", "local_fusion"],
          SessionCompoundToolPolicy.resolveChildPermission([], "parent_without_teams", {
            role: { type: "branch", index: 0, tempDir },
            root: primary,
          }),
        ),
      ).toEqual(new Set(["local_fusion"]))
    }),
  )

  it.live("keeps parent external directory deny above branch and judge scratch allows", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const branchDir = yield* tmpdirScoped()
      const judgeDir = yield* tmpdirScoped()
      const parentDeny: PermissionV1.Ruleset = [{ permission: "external_directory", pattern: "*", action: "deny" }]
      const branchRules = scratchRules(primary, { type: "branch", index: 0, tempDir: branchDir }, parentDeny)
      const judgeRules = scratchRules(primary, { type: "judge", tempDir: judgeDir }, parentDeny)

      expect(Permission.evaluate("external_directory", path.join(branchDir, "*"), branchRules).action).toBe("deny")
      expect(Permission.evaluate("external_directory", path.join(judgeDir, "*"), judgeRules).action).toBe("deny")
      expect(
        (yield* provideInstance(primary)(
          assertExternalDirectoryEffect(evaluatingCtx(branchRules), path.join(branchDir, "scratch.txt")).pipe(Effect.exit),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* provideInstance(primary)(
          assertExternalDirectoryEffect(evaluatingCtx(judgeRules), path.join(judgeDir, "scratch.txt")).pipe(Effect.exit),
        ))._tag,
      ).toBe("Failure")
    }),
  )

  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target)

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("no-ops for paths inside a registered secondary root", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const { requests, ctx } = makeCtx()

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "tool roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      yield* provideInstance(primary)(
        assertExternalDirectoryEffect({ ...ctx, sessionID: info.id }, path.join(secondary, "file.txt")),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
    }),
  )

  it.live("preserves registered-root behavior that sandbox workdir checks rely on", () =>
    Effect.gen(function* () {
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const { requests, ctx } = makeCtx()

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const info = yield* session.create({ title: "sandbox roots" })
          yield* session.addRoot({ sessionID: info.id, directory: secondary })
          return info
        }),
      )

      yield* provideInstance(primary)(
        assertExternalDirectoryEffect({ ...ctx, sessionID: info.id }, path.join(secondary, "nested"), {
          kind: "directory",
        }),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
    }),
  )

  it.live("asks for unregistered siblings in the primary worktree", () =>
    Effect.gen(function* () {
      const repo = yield* tmpdirScoped({ git: true })
      const primary = path.join(repo, "primary")
      const sibling = path.join(repo, "sibling")
      yield* Effect.promise(() => fs.mkdir(primary, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(sibling, { recursive: true }))
      const { requests, ctx } = makeCtx()

      const info = yield* provideInstance(primary)(
        Effect.gen(function* () {
          const session = yield* Session.Service
          return yield* session.create({ title: "tool roots" })
        }),
      )

      yield* provideInstance(primary)(
        assertExternalDirectoryEffect({ ...ctx, sessionID: info.id }, path.join(sibling, "file.txt")),
      )

      expect(requests.find((request) => request.permission === "external_directory")).toBeDefined()
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
