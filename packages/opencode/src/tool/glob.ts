import { Effect, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Search } from "@opencode-ai/core/filesystem/search"
import { assertExternalDirectoryWithSession } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { ToolPath } from "./path"
import { Session } from "@/session/session"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const reference = yield* Reference.Service
    const searchSvc = yield* Search.Service
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          const resolved = yield* ToolPath.resolveWithSession(session, ctx, params.path)
          const search = resolved.path
          yield* reference.ensure(search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryWithSession(session, ctx, search, {
            bypass: yield* reference.contains(search),
            kind: "directory",
          })

          const limit = 100
          const files = yield* searchSvc.glob({
            cwd: search,
            pattern: params.pattern,
            limit,
            signal: ctx.abort,
          })

          const output = []
          if (files.files.length === 0) output.push("No files found")
          if (files.files.length > 0) {
            output.push(...files.files)
            if (files.truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: resolved.relative,
            metadata: {
              count: files.files.length,
              truncated: files.truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
