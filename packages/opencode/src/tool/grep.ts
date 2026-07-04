import path from "path"
import { Clock, Effect, Exit, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Search } from "@opencode-ai/core/filesystem/search"
import { assertExternalDirectoryWithSession } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { ToolPath } from "./path"
import { Session } from "@/session/session"
import { logSlowFilesystem } from "./filesystem-diagnostics"

const MAX_LINE_LENGTH = 2000

type Metadata = {
  matches: number
  truncated: boolean
}

type Diagnostics = {
  resultCount: number
  truncated: boolean
  partial: boolean
}

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Search.Service | Reference.Service | Session.Service
>(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const searchSvc = yield* Search.Service
    const reference = yield* Reference.Service
    const session = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const exit = yield* Effect.gen(function* () {
            const empty = (diagnostics: Diagnostics = { resultCount: 0, truncated: false, partial: false }) => ({
              value: {
                title: params.pattern,
                metadata: { matches: 0, truncated: false } satisfies Metadata,
                output: "No files found",
              },
              diagnostics,
            })
            if (!params.pattern) {
              throw new Error("pattern is required")
            }

            yield* ctx.ask({
              permission: "grep",
              patterns: [params.pattern],
              always: ["*"],
              metadata: {
                pattern: params.pattern,
                path: params.path,
                include: params.include,
              },
            })

            const resolved = yield* ToolPath.resolveWithSession(session, ctx, params.path)
            const requested = resolved.path
            yield* reference.ensure(requested)
            const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
            yield* assertExternalDirectoryWithSession(session, ctx, requested, {
              bypass: yield* reference.contains(requested),
              kind: requestedInfo?.type === "Directory" ? "directory" : "file",
            })

            const search = FSUtil.resolve(requested)
            const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const cwd = info?.type === "Directory" ? search : path.dirname(search)
            const file = info?.type === "Directory" ? undefined : [path.relative(cwd, search)]

            const result = yield* searchSvc.search({
              cwd,
              pattern: params.pattern,
              glob: params.include ? [params.include] : undefined,
              file,
              signal: ctx.abort,
            })
            if (result.items.length === 0) {
              return empty({ resultCount: 0, truncated: result.hasNextPage, partial: result.partial })
            }

            const rows = result.items.map((item) => ({
              path: FSUtil.resolve(path.isAbsolute(item.path.text) ? item.path.text : path.join(cwd, item.path.text)),
              line: item.line_number,
              text: item.lines.text,
            }))

            const limit = 100
            const truncated = rows.length > limit
            const final = truncated ? rows.slice(0, limit) : rows
            if (final.length === 0) {
              return empty({
                resultCount: rows.length,
                truncated: truncated || result.hasNextPage,
                partial: result.partial,
              })
            }

            const total = rows.length
            const hasMore = truncated || result.hasNextPage
            const output = [`Found ${total} matches${hasMore ? " (more matches available)" : ""}`]

            let current = ""
            for (const match of final) {
              if (current !== match.path) {
                if (current !== "") output.push("")
                current = match.path
                output.push(`${match.path}:`)
              }
              const text =
                match.text.length > MAX_LINE_LENGTH ? match.text.substring(0, MAX_LINE_LENGTH) + "..." : match.text
              output.push(`  Line ${match.line}: ${text}`)
            }

            if (truncated) {
              output.push("")
              output.push(
                `(Results truncated: showing ${limit} of ${total} matches (${total - limit} hidden). Consider using a more specific path or pattern.)`,
              )
            }

            if (result.hasNextPage) {
              output.push("")
              output.push(`(Results truncated. Consider using a more specific path or pattern.)`)
            }

            if (result.partial) {
              output.push("")
              output.push("(Some paths were inaccessible and skipped)")
            }

            if (result.regexFallbackError) {
              output.push("")
              output.push(`(Regex fallback: ${result.regexFallbackError})`)
            }

            return {
              value: {
                title: params.pattern,
                metadata: {
                  matches: total,
                  truncated,
                },
                output: output.join("\n"),
              },
              diagnostics: { resultCount: total, truncated: hasMore, partial: result.partial } satisfies Diagnostics,
            }
          }).pipe(Effect.exit)
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt
          const diagnostics = Exit.isSuccess(exit) ? exit.value.diagnostics : undefined
          yield* logSlowFilesystem({
            toolName: "grep",
            sessionID: ctx.sessionID,
            durationMs,
            resultCount: diagnostics?.resultCount,
            truncated: diagnostics?.truncated,
            partial: diagnostics?.partial,
            status: Exit.isSuccess(exit) ? "success" : "error",
          })
          if (Exit.isSuccess(exit)) return exit.value.value
          return yield* Effect.failCause(exit.cause)
        }).pipe(Effect.orDie),
    }
  }),
)
