import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Team } from "@/team/team"
import { Truncate } from "@/tool/truncate"
import { canonicalize, canonicalPathKey, mutationLockKeys, OwnedPathError } from "@/team/file-ownership"
import type { Context } from "@/tool/tool"
import { disposeAllInstances, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    FSUtil.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
  ),
)

function context(sessionID: string): Context {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const caseFold = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p)

const createSession = Effect.fn("FileOwnershipTest.createSession")(function* (title: string) {
  const sessions = yield* Session.Service
  return yield* sessions.create({ title })
})

describe("team.file-ownership", () => {
  it.live("canonicalizes an existing file to its realpath with a root-relative display path", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const target = path.join(directory, "existing.txt")
          yield* Effect.promise(() => fs.writeFile(target, "hello"))
          const session = yield* createSession("canon-existing")
          const sessions = yield* Session.Service
          const result = yield* canonicalize(sessions, context(session.id), target)
          const realDirectory = yield* Effect.promise(() => fs.realpath(directory))
          expect(result.rootKey).toBe(caseFold(realDirectory.replaceAll("\\", "/")))
          expect(result.pathKey).toBe(caseFold(`${realDirectory.replaceAll("\\", "/")}/existing.txt`))
          expect(result.displayPath).toBe("existing.txt")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("canonicalizes a missing target via the nearest existing ancestor", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "nested"), { recursive: true }))
          const target = path.join(directory, "nested", "future.txt")
          const session = yield* createSession("canon-missing")
          const sessions = yield* Session.Service
          const result = yield* canonicalize(sessions, context(session.id), target)
          const realDirectory = yield* Effect.promise(() => fs.realpath(directory))
          expect(result.pathKey).toBe(caseFold(`${realDirectory.replaceAll("\\", "/")}/nested/future.txt`))
          expect(result.displayPath).toBe("nested/future.txt")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("uses one canonical mutation key for direct and symlink-alias targets", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const targetDirectory = path.join(directory, "target")
          const target = path.join(targetDirectory, "shared.txt")
          const aliasDirectory = path.join(directory, "alias")
          const alias = path.join(aliasDirectory, "shared.txt")
          yield* Effect.promise(() => fs.mkdir(targetDirectory))
          yield* Effect.promise(() => fs.writeFile(target, "hello"))
          yield* Effect.promise(() =>
            fs.symlink(targetDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir"),
          )
          const futil = yield* FSUtil.Service

          const directKeys = yield* mutationLockKeys(futil, target)
          const aliasKeys = yield* mutationLockKeys(futil, alias)

          expect(directKeys.some((key) => aliasKeys.includes(key))).toBe(true)
          expect(aliasKeys.length).toBe(2)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("uses the reserved unprefixed pathKey outside the caller root and through a cross-root symlink", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const external = yield* tmpdirScoped()
          const target = path.join(external, "reserved.txt")
          yield* Effect.promise(() => fs.writeFile(target, "hello"))
          const aliasDirectory = path.join(directory, "external-alias")
          yield* Effect.promise(() =>
            fs.symlink(external, aliasDirectory, process.platform === "win32" ? "junction" : "dir"),
          )

          const owner = yield* createSession("canon-owner-root")
          const caller = yield* createSession("canon-caller-root")
          const sessions = yield* Session.Service
          const futil = yield* FSUtil.Service
          yield* sessions.addRoot({ sessionID: owner.id, directory: external })
          const reserved = yield* canonicalize(sessions, context(owner.id), target)
          const callerReservation = yield* canonicalize(sessions, context(caller.id), target).pipe(Effect.flip)
          const directKey = yield* canonicalPathKey(futil, target)
          const aliasKey = yield* canonicalPathKey(futil, path.join(aliasDirectory, "reserved.txt"))

          expect(callerReservation).toBeInstanceOf(OwnedPathError)
          expect(callerReservation.message).toContain("escapes")
          expect(directKey).toBe(reserved.pathKey)
          expect(aliasKey).toBe(reserved.pathKey)
          expect(directKey.startsWith("mutation:")).toBe(false)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("keeps a symlink key stable when its target disappears during canonicalization", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const target = path.join(directory, "race-target.txt")
          const alias = path.join(directory, "race-alias.txt")
          yield* Effect.promise(() => fs.writeFile(target, "hello"))
          yield* Effect.promise(() => fs.symlink(target, alias))
          const session = yield* createSession("canon-symlink-race")
          const sessions = yield* Session.Service
          const futil = yield* FSUtil.Service
          const stable = yield* canonicalize(sessions, context(session.id), alias)
          let removed = false
          const removeTarget = Effect.fnUntraced(function* () {
            if (removed) return
            removed = true
            yield* Effect.promise(() => fs.rm(target, { force: true }))
          })
          const racedFs: FSUtil.Interface = {
            ...futil,
            exists: (input) =>
              futil
                .exists(input)
                .pipe(Effect.tap((exists) => (input === alias && exists ? removeTarget() : Effect.void))),
            readLink: (input) =>
              futil.readLink(input).pipe(Effect.tap(() => (input === alias ? removeTarget() : Effect.void))),
          }

          const raced = yield* canonicalize(sessions, context(session.id), alias).pipe(
            Effect.provideService(FSUtil.Service, racedFs),
          )

          expect(removed).toBe(true)
          expect((yield* Effect.promise(() => fs.stat(target)).pipe(Effect.exit))._tag).toBe("Failure")
          expect(raced).toEqual(stable)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects a symlink escape outside the root", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const outside = path.join(path.dirname(directory), `outside-${Date.now()}.txt`)
          yield* Effect.promise(() => fs.writeFile(outside, "outside"))
          const link = path.join(directory, "escape-link")
          yield* Effect.promise(() => fs.symlink(outside, link))
          const session = yield* createSession("canon-escape")
          const sessions = yield* Session.Service
          const failure = yield* canonicalize(sessions, context(session.id), link).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(OwnedPathError)
          expect(failure.message).toContain("escapes")
          yield* Effect.promise(() => fs.rm(outside, { force: true }))
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects .git path segments", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(directory, ".git"), { recursive: true }))
          const target = path.join(directory, ".git", "config")
          const session = yield* createSession("canon-git")
          const sessions = yield* Session.Service
          const failure = yield* canonicalize(sessions, context(session.id), target).pipe(Effect.flip)
          expect(failure).toBeInstanceOf(OwnedPathError)
          expect(failure.message).toContain(".git")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("rejects glob metacharacters and directory claims", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "adir"), { recursive: true }))
          const session = yield* createSession("canon-reject")
          const sessions = yield* Session.Service
          const globFailure = yield* canonicalize(sessions, context(session.id), path.join(directory, "*.ts")).pipe(
            Effect.flip,
          )
          expect(globFailure).toBeInstanceOf(OwnedPathError)
          expect(globFailure.message).toContain("glob")
          const dirFailure = yield* canonicalize(sessions, context(session.id), path.join(directory, "adir")).pipe(
            Effect.flip,
          )
          expect(dirFailure).toBeInstanceOf(OwnedPathError)
          expect(dirFailure.message).toContain("directories")
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("case-folds the pathKey on darwin and win32", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const target = path.join(directory, "CaseFile.txt")
          yield* Effect.promise(() => fs.writeFile(target, "x"))
          const session = yield* createSession("canon-case")
          const sessions = yield* Session.Service
          const result = yield* canonicalize(sessions, context(session.id), target)
          const realDirectory = yield* Effect.promise(() => fs.realpath(directory))
          const expected = caseFold(`${realDirectory.replaceAll("\\", "/")}/CaseFile.txt`)
          expect(result.pathKey).toBe(expected)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("normalizes backslash separators to forward slashes", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const target = path.join(directory, "sep", "file.txt")
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "sep"), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(target, "x"))
          const session = yield* createSession("canon-sep")
          const sessions = yield* Session.Service
          const result = yield* canonicalize(sessions, context(session.id), target)
          expect(result.pathKey.includes("\\")).toBe(false)
          expect(result.displayPath.includes("\\")).toBe(false)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})
