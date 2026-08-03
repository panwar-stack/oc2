import { afterEach, describe, expect } from "bun:test"
import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { SessionCompoundToolPolicy } from "../../src/session/compound/tool-policy"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { Team } from "@/team/team"
import { canonicalize } from "@/team/file-ownership"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-write-session"),
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

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    EventV2Bridge.defaultLayer,
    Session.defaultLayer,
    testInstanceStoreLayer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Database.defaultLayer,
    Team.defaultLayer,
  ),
)

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

type ScratchRole = { type: "branch"; index: number; tempDir: string } | { type: "judge"; tempDir: string }

function scratchRules(root: string, role: ScratchRole, parent: PermissionV1.Ruleset = []): PermissionV1.Ruleset {
  return SessionCompoundToolPolicy.resolveChildPermission(parent, "all", {
    role,
    root,
  })
}

function permissionCtx(ruleset: PermissionV1.Ruleset): Tool.Context {
  return {
    ...ctx,
    ask: (request) => {
      const denied = request.patterns.find(
        (pattern) => Permission.evaluate(request.permission, pattern, ruleset).action !== "allow",
      )
      if (denied) return Effect.die(new PermissionV1.DeniedError({ ruleset }))
      return Effect.void
    },
  }
}

describe("tool.write", () => {
  describe("new file creation", () => {
    it.live("allows local fusion scratch writes and denies workspace writes", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const tempDir = yield* tmpdirScoped()
        const ruleset = scratchRules(primary, { type: "branch", index: 0, tempDir })
        const workspaceFile = path.join(primary, "workspace.txt")
        const scratchFile = path.join(tempDir, "scratch.txt")

        const denied = yield* provideInstance(primary)(
          run({ filePath: workspaceFile, content: "workspace" }, permissionCtx(ruleset)).pipe(Effect.exit),
        )
        expect(denied._tag).toBe("Failure")
        expect((yield* Effect.promise(() => fs.stat(workspaceFile)).pipe(Effect.exit))._tag).toBe("Failure")

        yield* provideInstance(primary)(run({ filePath: scratchFile, content: "scratch" }, permissionCtx(ruleset)))
        expect(yield* Effect.promise(() => fs.readFile(scratchFile, "utf-8"))).toBe("scratch")
      }),
    )

    it.live("keeps parent edit deny above branch scratch write allow", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const tempDir = yield* tmpdirScoped()
        const ruleset = scratchRules(primary, { type: "branch", index: 0, tempDir }, [
          { permission: "edit", pattern: "*", action: "deny" },
        ])
        const scratchFile = path.join(tempDir, "scratch.txt")

        const denied = yield* provideInstance(primary)(
          run({ filePath: scratchFile, content: "scratch" }, permissionCtx(ruleset)).pipe(Effect.exit),
        )

        expect(denied._tag).toBe("Failure")
        expect((yield* Effect.promise(() => fs.stat(scratchFile)).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )

    it.live("denies writes to sibling scratch directories", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const branchDir = yield* tmpdirScoped()
        const siblingDir = yield* tmpdirScoped()
        const judgeDir = yield* tmpdirScoped()
        const ruleset = scratchRules(primary, { type: "branch", index: 0, tempDir: branchDir })
        const siblingFile = path.join(siblingDir, "sibling.txt")
        const judgeFile = path.join(judgeDir, "judge.txt")

        expect(
          (yield* provideInstance(primary)(
            run({ filePath: siblingFile, content: "sibling" }, permissionCtx(ruleset)).pipe(Effect.exit),
          ))._tag,
        ).toBe("Failure")
        expect(
          (yield* provideInstance(primary)(
            run({ filePath: judgeFile, content: "judge" }, permissionCtx(ruleset)).pipe(Effect.exit),
          ))._tag,
        ).toBe("Failure")
        expect((yield* Effect.promise(() => fs.stat(siblingFile)).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* Effect.promise(() => fs.stat(judgeFile)).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )

    it.live("denies branch and judge writes to secondary session roots", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const secondary = yield* tmpdirScoped({ git: true })
        const branchDir = yield* tmpdirScoped()
        const judgeDir = yield* tmpdirScoped()
        const branchRules = scratchRules(primary, { type: "branch", index: 0, tempDir: branchDir })
        const judgeRules = scratchRules(primary, { type: "judge", tempDir: judgeDir })
        const branchFile = path.join(secondary, "branch.txt")
        const judgeFile = path.join(secondary, "judge.txt")
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
              { filePath: branchFile, content: "branch" },
              { ...permissionCtx(branchRules), sessionID: info.id },
            ).pipe(Effect.exit),
          ))._tag,
        ).toBe("Failure")
        expect(
          (yield* provideInstance(primary)(
            run({ filePath: judgeFile, content: "judge" }, { ...permissionCtx(judgeRules), sessionID: info.id }).pipe(
              Effect.exit,
            ),
          ))._tag,
        ).toBe("Failure")
        expect((yield* Effect.promise(() => fs.stat(branchFile)).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* Effect.promise(() => fs.stat(judgeFile)).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    )

    it.live("writes absolute paths inside a registered secondary root", () =>
      Effect.gen(function* () {
        const primary = yield* tmpdirScoped({ git: true })
        const secondary = yield* tmpdirScoped({ git: true })
        const filepath = path.join(secondary, "created.txt")
        const requests: Parameters<Tool.Context["ask"]>[0][] = []

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
            { filePath: filepath, content: "secondary content" },
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

        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("secondary content")
        expect(requests.find((request) => request.permission === "external_directory")).toBeUndefined()
        expect(requests.find((request) => request.permission === "edit")?.patterns).toEqual(["created.txt"])
      }),
    )

    it.instance("writes content to new file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, content: "Hello, World!" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(false)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("Hello, World!")
      }),
    )

    it.instance("creates parent directories if needed", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "deep", "file.txt")
        yield* run({ filePath: filepath, content: "nested content" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("nested content")
      }),
    )

    it.instance("handles relative paths by resolving to instance directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* run({ filePath: "relative.txt", content: "relative content" })

        const content = yield* Effect.promise(() => fs.readFile(path.join(test.directory, "relative.txt"), "utf-8"))
        expect(content).toBe("relative content")
      }),
    )
  })

  describe("existing file overwrite", () => {
    it.instance("overwrites existing file content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old content", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new content" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(true)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("new content")
      }),
    )

    it.instance("preserves BOM when overwriting existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

        yield* run({ filePath: filepath, content: "using Up;\n" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance(
      "restores BOM after formatter strips it",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.cs")
          const bom = String.fromCharCode(0xfeff)
          yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

          yield* run({ filePath: filepath, content: "using Up;\n" })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content.charCodeAt(0)).toBe(0xfeff)
          expect(content.slice(1)).toBe("using Up;\n")
        }),
      {
        config: {
          formatter: {
            stripbom: {
              extensions: [".cs"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; let text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); fs.writeFileSync(file, text, 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    it.instance("returns diff in metadata for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new" })

        expect(result.metadata).toHaveProperty("filepath", filepath)
        expect(result.metadata).toHaveProperty("exists", true)
      }),
    )
  })

  describe("file permissions", () => {
    it.instance("sets file permissions when writing sensitive data", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "sensitive.json")
        yield* run({ filePath: filepath, content: JSON.stringify({ secret: "data" }) })

        if (process.platform !== "win32") {
          const stats = yield* Effect.promise(() => fs.stat(filepath))
          expect(stats.mode & 0o777).toBe(0o644)
        }
      }),
    )
  })

  describe("content types", () => {
    it.instance("writes JSON content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "data.json")
        const data = { key: "value", nested: { array: [1, 2, 3] } }
        yield* run({ filePath: filepath, content: JSON.stringify(data, null, 2) })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(JSON.parse(content)).toEqual(data)
      }),
    )

    it.instance("writes binary-safe content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "binary.bin")
        const content = "Hello\x00World\x01\x02\x03"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )

    it.instance("writes empty content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "empty.txt")
        yield* run({ filePath: filepath, content: "" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("")

        const stats = yield* Effect.promise(() => fs.stat(filepath))
        expect(stats.size).toBe(0)
      }),
    )

    it.instance("writes multi-line content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multiline.txt")
        const lines = ["Line 1", "Line 2", "Line 3", ""].join("\n")
        yield* run({ filePath: filepath, content: lines })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe(lines)
      }),
    )

    it.instance("handles different line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf.txt")
        const content = "Line 1\r\nLine 2\r\nLine 3"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )
  })

  describe("error handling", () => {
    it.instance("throws error when OS denies write access", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const readonlyPath = path.join(test.directory, "readonly.txt")
        yield* Effect.promise(() => fs.writeFile(readonlyPath, "test", "utf-8"))
        yield* Effect.promise(() => fs.chmod(readonlyPath, 0o444))
        const exit = yield* run({ filePath: readonlyPath, content: "new content" }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("title generation", () => {
    it.instance("returns relative path as title", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "src", "components", "Button.tsx")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filepath), { recursive: true }))

        const result = yield* run({ filePath: filepath, content: "export const Button = () => {}" })
        expect(result.title).toEndWith("src/components/Button.tsx")
      }),
    )
  })

  describe("reservation lease", () => {
    it.instance("allows the owning teammate to write a reserved path", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const futil = yield* FSUtil.Service
        const lead = yield* sessions.create({ title: "Lease Lead" })
        const ownerSession = yield* sessions.create({ parentID: lead.id, title: "Lease Owner" })
        const info = yield* team.create({ name: "lease-write-owner", goal: "Lease", leadSessionID: lead.id })
        const owner = yield* team.addMember({
          teamID: info.id,
          sessionID: ownerSession.id,
          name: "owner",
          agentType: "general",
          rolePrompt: "Own",
        })
        yield* team.updateMemberStatus(owner.id, "active")
        const filepath = path.join(test.directory, "reserved.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old"))
        const owned = yield* canonicalize(sessions, leaseContext(ownerSession.id), filepath).pipe(
          Effect.provideService(FSUtil.Service, futil),
        )
        yield* team.createTask({ teamID: info.id, description: "Reserve", owned: [owned] })
        const task = (yield* team.getTasks(info.id))[0]
        if (!task) throw new Error("task missing")
        yield* team.claimTask(info.id, task.id, ownerSession.id)

        const result = yield* run(
          { filePath: filepath, content: "new" },
          { ...ctx, sessionID: SessionID.make(ownerSession.id) },
        )

        expect(result.output).toContain("Wrote file successfully")
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("new")
      }),
    )

    it.instance("denies a non-owner write to a reserved path before any permission ask", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const futil = yield* FSUtil.Service
        const lead = yield* sessions.create({ title: "Lease Lead" })
        const ownerSession = yield* sessions.create({ parentID: lead.id, title: "Lease Owner" })
        const otherSession = yield* sessions.create({ parentID: lead.id, title: "Lease Other" })
        const info = yield* team.create({ name: "lease-write-deny", goal: "Lease", leadSessionID: lead.id })
        const owner = yield* team.addMember({
          teamID: info.id,
          sessionID: ownerSession.id,
          name: "owner",
          agentType: "general",
          rolePrompt: "Own",
        })
        const other = yield* team.addMember({
          teamID: info.id,
          sessionID: otherSession.id,
          name: "other",
          agentType: "general",
          rolePrompt: "Other",
        })
        yield* team.updateMemberStatus(owner.id, "active")
        yield* team.updateMemberStatus(other.id, "active")
        const filepath = path.join(test.directory, "reserved.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old"))
        const owned = yield* canonicalize(sessions, leaseContext(ownerSession.id), filepath).pipe(
          Effect.provideService(FSUtil.Service, futil),
        )
        yield* team.createTask({ teamID: info.id, description: "Reserve", owned: [owned] })
        const task = (yield* team.getTasks(info.id))[0]
        if (!task) throw new Error("task missing")
        yield* team.claimTask(info.id, task.id, ownerSession.id)

        const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const result = yield* run(
          { filePath: filepath, content: "sneaky" },
          {
            ...ctx,
            sessionID: SessionID.make(otherSession.id),
            ask: (request) =>
              Effect.sync(() => {
                asks.push(request)
              }),
          },
        )

        expect(result.title).toBe("Write Failed")
        expect(result.output).toContain("reserved")
        expect(asks).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("old")
      }),
    )

    it.instance("denies a non-owner write through a healed dangling symlink alias", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const futil = yield* FSUtil.Service
        const lead = yield* sessions.create({ title: "Symlink Lease Lead" })
        const ownerSession = yield* sessions.create({ parentID: lead.id, title: "Symlink Lease Owner" })
        const otherSession = yield* sessions.create({ parentID: lead.id, title: "Symlink Lease Other" })
        const info = yield* team.create({ name: "lease-write-symlink", goal: "Lease", leadSessionID: lead.id })
        const owner = yield* team.addMember({
          teamID: info.id,
          sessionID: ownerSession.id,
          name: "owner",
          agentType: "general",
          rolePrompt: "Own",
        })
        const other = yield* team.addMember({
          teamID: info.id,
          sessionID: otherSession.id,
          name: "other",
          agentType: "general",
          rolePrompt: "Other",
        })
        yield* team.updateMemberStatus(owner.id, "active")
        yield* team.updateMemberStatus(other.id, "active")

        const target = path.join(test.directory, "reserved-target.txt")
        const alias = path.join(test.directory, "reserved-alias.txt")
        yield* Effect.promise(() => fs.symlink(target, alias))
        const owned = yield* canonicalize(sessions, leaseContext(ownerSession.id), alias).pipe(
          Effect.provideService(FSUtil.Service, futil),
        )
        yield* team.createTask({ teamID: info.id, description: "Reserve dangling alias", owned: [owned] })
        const task = (yield* team.getTasks(info.id))[0]
        if (!task) throw new Error("task missing")
        yield* team.claimTask(info.id, task.id, ownerSession.id)

        yield* Effect.promise(() => fs.writeFile(target, "old"))
        const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const result = yield* run(
          { filePath: alias, content: "sneaky" },
          {
            ...ctx,
            sessionID: SessionID.make(otherSession.id),
            ask: (request) =>
              Effect.sync(() => {
                asks.push(request)
              }),
          },
        )

        expect(result.title).toBe("Write Failed")
        expect(result.output).toContain("reserved")
        expect(asks).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf-8"))).toBe("old")
      }),
    )

    it.instance("denies a non-owner write to a reserved file external to the caller root", () =>
      Effect.gen(function* () {
        const reserved = yield* reserveExternalTarget("write-direct")
        const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []

        const result = yield* run(
          { filePath: reserved.target, content: "sneaky" },
          {
            ...ctx,
            sessionID: SessionID.make(reserved.otherSessionID),
            ask: (request) =>
              Effect.sync(() => {
                asks.push(request)
              }),
          },
        )

        expect(result.title).toBe("Write Failed")
        expect(result.output).toContain("reserved")
        expect(asks).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(reserved.target, "utf-8"))).toBe("old")
      }),
    )

    it.instance("denies a non-owner write through a cross-root symlink", () =>
      Effect.gen(function* () {
        const reserved = yield* reserveExternalTarget("write-symlink")
        const asks: Array<Parameters<Tool.Context["ask"]>[0]> = []

        const result = yield* run(
          { filePath: reserved.alias, content: "sneaky" },
          {
            ...ctx,
            sessionID: SessionID.make(reserved.otherSessionID),
            ask: (request) =>
              Effect.sync(() => {
                asks.push(request)
              }),
          },
        )

        expect(result.title).toBe("Write Failed")
        expect(result.output).toContain("reserved")
        expect(asks).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(reserved.target, "utf-8"))).toBe("old")
      }),
    )
  })
})

const reserveExternalTarget = Effect.fnUntraced(function* (name: string) {
  const test = yield* TestInstance
  const external = yield* tmpdirScoped()
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const futil = yield* FSUtil.Service
  const lead = yield* sessions.create({ title: `${name} Lead` })
  const ownerSession = yield* sessions.create({ parentID: lead.id, title: `${name} Owner` })
  const otherSession = yield* sessions.create({ parentID: lead.id, title: `${name} Other` })
  yield* sessions.addRoot({ sessionID: ownerSession.id, directory: external })
  const info = yield* team.create({ name, goal: "Lease", leadSessionID: lead.id })
  const owner = yield* team.addMember({
    teamID: info.id,
    sessionID: ownerSession.id,
    name: "owner",
    agentType: "general",
    rolePrompt: "Own",
  })
  const other = yield* team.addMember({
    teamID: info.id,
    sessionID: otherSession.id,
    name: "other",
    agentType: "general",
    rolePrompt: "Other",
  })
  yield* team.updateMemberStatus(owner.id, "active")
  yield* team.updateMemberStatus(other.id, "active")

  const target = path.join(external, "reserved.txt")
  yield* Effect.promise(() => fs.writeFile(target, "old"))
  const aliasDirectory = path.join(test.directory, `${name}-alias`)
  yield* Effect.promise(() => fs.symlink(external, aliasDirectory, process.platform === "win32" ? "junction" : "dir"))
  const owned = yield* canonicalize(sessions, leaseContext(ownerSession.id), target).pipe(
    Effect.provideService(FSUtil.Service, futil),
  )
  yield* team.createTask({ teamID: info.id, description: "Reserve external target", owned: [owned] })
  const task = (yield* team.getTasks(info.id))[0]
  if (!task) return yield* Effect.die(new Error("task missing"))
  yield* team.claimTask(info.id, task.id, ownerSession.id)

  return { target, alias: path.join(aliasDirectory, "reserved.txt"), otherSessionID: otherSession.id }
})

function leaseContext(sessionID: string): Tool.Context {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.make("msg_lease"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}
