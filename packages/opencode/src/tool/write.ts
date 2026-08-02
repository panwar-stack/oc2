import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@oc2-ai/core/filesystem"
import { Watcher } from "@oc2-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { trimDiff } from "./edit"
import { assertExternalDirectoryWithSession } from "./external-directory"
import * as Bom from "@/util/bom"
import { ToolPath } from "./path"
import { Session } from "@/session/session"
import { Database } from "@oc2-ai/core/database/database"
import { canonicalize, withWriteLease } from "@/team/file-ownership"
import * as LSPClient from "@/lsp/client"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

type WriteMetadata = {
  diagnostics: Record<string, LSPClient.Diagnostic[]>
  filepath: string
  exists: boolean
}

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const session = yield* Session.Service
    const { db } = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const resolved = yield* ToolPath.resolveWithSession(session, ctx, params.filePath)
          const filepath = resolved.path
          yield* assertExternalDirectoryWithSession(session, ctx, filepath)

          // Canonicalize the target (read-only realpath I/O), then acquire the write lease: the
          // sorted path lock is held through the ownership check, the permission ask, and the full
          // mutation. A reservation owned by another session denies the write before any ask or I/O.
          // Paths that cannot canonicalize (scratch outside the workspace, directories, .git) can
          // never be reserved, so the lease is skipped for them and the existing permission flow
          // applies unchanged.
          const owned = yield* canonicalize(session, ctx, params.filePath)
            .pipe(Effect.provideService(FSUtil.Service, fs))
            .pipe(Effect.catchTag("Team.OwnedPathError", () => Effect.succeed(undefined)))
          const { exists } = yield* withWriteLease(
            db,
            String(ctx.sessionID),
            owned ? [owned.pathKey] : [],
            Effect.gen(function* () {
              const exists = yield* fs.existsSafe(filepath)
              const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
              const next = Bom.split(params.content)
              const desiredBom = source.bom || next.bom
              const contentOld = source.text
              const contentNew = next.text

              const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
              yield* ctx.ask({
                permission: "edit",
                patterns: [resolved.relative],
                always: ["*"],
                metadata: {
                  filepath,
                  diff,
                },
              })

              yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filepath)) {
                yield* Bom.syncFile(fs, filepath, desiredBom)
              }
              yield* events.publish(FileSystem.Event.Edited, { file: filepath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              })
              return { exists }
            }),
          )

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document", resolved.root)
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: resolved.relative,
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            } satisfies WriteMetadata,
            output,
          }
        }).pipe(
          // A path reserved by another task is a stable denial, not a defect: report it without
          // asking permission or touching the file.
          Effect.catchTag("Team.OwnedWriteDenied", (error) =>
            Effect.succeed({
              title: "Write Failed",
              output: error.message,
              metadata: { diagnostics: {}, filepath: error.displayPath, exists: false } satisfies WriteMetadata,
            }),
          ),
          Effect.orDie,
        ),
    }
  }),
)
