import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@oc2-ai/core/filesystem/watcher"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryWithSession } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import * as LSPClient from "@/lsp/client"
import { FSUtil } from "@oc2-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@oc2-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { ToolPath } from "./path"
import { Session } from "@/session/session"
import { Database } from "@oc2-ai/core/database/database"
import { canonicalPathKey, mutationLockKeys, withMutationLease } from "@/team/file-ownership"

type PatchMetadata = {
  diff: string
  files: Array<{
    filePath: string
    relativePath: string
    type: "add" | "update" | "delete" | "move"
    patch: string
    additions: number
    deletions: number
    movePath?: string
  }>
  diagnostics: Record<string, LSPClient.Diagnostic[]>
}

type PreparedHunk = {
  hunk: Patch.Hunk
  resolved: ToolPath.Resolved
  pathKey: string
  lockKeys: string[]
  move?: ToolPath.Resolved
  movePathKey?: string
  moveLockKeys: string[]
}

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const session = yield* Session.Service
    const { db } = yield* Database.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      // Resolve the complete lock set before taking any lock. All operations then acquire those
      // locks once, in sorted order, which prevents deadlocks between overlapping multi-file patches.
      const preparedHunks: PreparedHunk[] = []
      for (const hunk of hunks) {
        const resolved = yield* ToolPath.resolveWithSession(session, ctx, hunk.path)
        const pathKey = yield* canonicalPathKey(afs, resolved.path)
        const lockKeys = yield* mutationLockKeys(afs, resolved.path)
        const move =
          hunk.type === "update" && hunk.move_path
            ? yield* ToolPath.resolveWithSession(session, ctx, hunk.move_path)
            : undefined
        const movePathKey = move ? yield* canonicalPathKey(afs, move.path) : undefined
        const moveLockKeys = move ? yield* mutationLockKeys(afs, move.path) : []
        preparedHunks.push({
          hunk,
          resolved,
          pathKey,
          lockKeys,
          move,
          movePathKey,
          moveLockKeys,
        })
      }
      const allLockKeys = Array.from(
        new Set(preparedHunks.flatMap((prepared) => [...prepared.lockKeys, ...prepared.moveLockKeys])),
      )
      // Keep authorization separate from mutation locks. Every resolved target contributes the
      // same unprefixed canonical filesystem key that reservation creation stores, even when the
      // caller reaches it from another root.
      const allPathKeys = Array.from(
        new Set(
          preparedHunks.flatMap((prepared) =>
            [prepared.pathKey, prepared.movePathKey].filter((key): key is string => key !== undefined),
          ),
        ),
      )

      const { fileChanges, totalDiff, files } = yield* withMutationLease(
        db,
        String(ctx.sessionID),
        allPathKeys,
        allLockKeys,
        Effect.gen(function* () {
          // External-directory checks can ask permission, so keep them inside the same lease as
          // verification and mutation. This also ensures a denied reservation asks nothing.
          for (const prepared of preparedHunks) {
            yield* assertExternalDirectoryWithSession(session, ctx, prepared.resolved.path)
            yield* assertExternalDirectoryWithSession(session, ctx, prepared.move?.path)
          }

          const fileChanges: Array<{
            filePath: string
            relativePath: string
            oldContent: string
            newContent: string
            type: "add" | "update" | "delete" | "move"
            root: ToolPath.Root
            movePath?: string
            moveRelativePath?: string
            moveRoot?: ToolPath.Root
            diff: string
            additions: number
            deletions: number
            bom: boolean
          }> = []
          let totalDiff = ""

          // Read, verify, and derive while the lease is held. A concurrent structured writer cannot
          // change a source between this read and the final write.
          for (const prepared of preparedHunks) {
            const { hunk, resolved, move } = prepared
            const filePath = resolved.path
            switch (hunk.type) {
              case "add": {
                const oldContent = ""
                const newContent =
                  hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
                const next = Bom.split(newContent)
                const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))
                let additions = 0
                let deletions = 0
                for (const change of diffLines(oldContent, next.text)) {
                  if (change.added) additions += change.count || 0
                  if (change.removed) deletions += change.count || 0
                }
                fileChanges.push({
                  filePath,
                  relativePath: resolved.relative,
                  oldContent,
                  newContent: next.text,
                  type: "add",
                  root: resolved.root,
                  diff,
                  additions,
                  deletions,
                  bom: next.bom,
                })
                totalDiff += diff + "\n"
                break
              }

              case "update": {
                const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!stats || stats.type === "Directory") {
                  return yield* Effect.fail(
                    new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
                  )
                }
                const source = yield* Bom.readFile(afs, filePath)
                const oldContent = source.text
                let newContent = oldContent
                let bom = source.bom
                try {
                  const fileUpdate = Patch.deriveNewContentsFromChunks(
                    filePath,
                    hunk.chunks,
                    Bom.join(source.text, source.bom),
                  )
                  newContent = fileUpdate.content
                  bom = fileUpdate.bom
                } catch (error) {
                  return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
                }
                const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))
                let additions = 0
                let deletions = 0
                for (const change of diffLines(oldContent, newContent)) {
                  if (change.added) additions += change.count || 0
                  if (change.removed) deletions += change.count || 0
                }
                fileChanges.push({
                  filePath,
                  relativePath: resolved.relative,
                  oldContent,
                  newContent,
                  type: move ? "move" : "update",
                  root: resolved.root,
                  movePath: move?.path,
                  moveRelativePath: move?.relative,
                  moveRoot: move?.root,
                  diff,
                  additions,
                  deletions,
                  bom,
                })
                totalDiff += diff + "\n"
                break
              }

              case "delete": {
                const source = yield* Bom.readFile(afs, filePath).pipe(
                  Effect.catch((error) =>
                    Effect.fail(
                      new Error(
                        `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                      ),
                    ),
                  ),
                )
                const contentToDelete = source.text
                const diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))
                fileChanges.push({
                  filePath,
                  relativePath: resolved.relative,
                  oldContent: contentToDelete,
                  newContent: "",
                  type: "delete",
                  root: resolved.root,
                  diff,
                  additions: 0,
                  deletions: contentToDelete.split("\n").length,
                  bom: source.bom,
                })
                totalDiff += diff + "\n"
                break
              }
            }
          }

          const files = fileChanges.map((change) => ({
            filePath: change.filePath,
            relativePath: change.moveRelativePath ?? change.relativePath,
            type: change.type,
            patch: change.diff,
            additions: change.additions,
            deletions: change.deletions,
            movePath: change.movePath,
          }))
          const relativePaths = Array.from(
            new Set(
              fileChanges.flatMap((change) =>
                [change.relativePath, change.moveRelativePath].filter((path) => path !== undefined),
              ),
            ),
          )
          yield* ctx.ask({
            permission: "apply_patch",
            patterns: relativePaths,
            always: ["*"],
            metadata: {
              filepath: relativePaths.join(", "),
              diff: totalDiff,
              files,
            },
          })

          // Apply the changes
          const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

          for (const change of fileChanges) {
            const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
            switch (change.type) {
              case "add":
                // Create parent directories (recursive: true is safe on existing/root dirs)

                yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
                updates.push({ file: change.filePath, event: "add" })
                break

              case "update":
                yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
                updates.push({ file: change.filePath, event: "change" })
                break

              case "move":
                if (change.movePath) {
                  // Create parent directories (recursive: true is safe on existing/root dirs)

                  yield* afs.writeWithDirs(change.movePath, Bom.join(change.newContent, change.bom))
                  yield* afs.remove(change.filePath)
                  updates.push({ file: change.filePath, event: "unlink" })
                  updates.push({ file: change.movePath, event: "add" })
                }
                break

              case "delete":
                yield* afs.remove(change.filePath)
                updates.push({ file: change.filePath, event: "unlink" })
                break
            }

            if (edited) {
              if (yield* format.file(edited)) {
                yield* Bom.syncFile(afs, edited, change.bom)
              }
              yield* events.publish(FileSystem.Event.Edited, { file: edited })
            }
          }

          // Publish file change events
          for (const update of updates) {
            yield* events.publish(Watcher.Event.Updated, update)
          }

          return { fileChanges, totalDiff, files }
        }),
      )

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document", change.moveRoot ?? change.root)
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${change.relativePath}`
        }
        if (change.type === "delete") {
          return `D ${change.relativePath}`
        }
        return `M ${change.moveRelativePath ?? change.relativePath}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = change.moveRelativePath ?? change.relativePath
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        } satisfies PatchMetadata,
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(
          // A path reserved by another task is a stable denial, not a defect: report it without
          // asking permission or writing anything.
          Effect.catchTag("Team.OwnedWriteDenied", (error) =>
            Effect.succeed({
              title: "Patch Failed",
              output: error.message,
              metadata: { diff: "", files: [], diagnostics: {} } satisfies PatchMetadata,
            }),
          ),
          Effect.orDie,
        ),
    }
  }),
)
