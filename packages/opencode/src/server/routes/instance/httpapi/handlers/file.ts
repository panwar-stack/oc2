import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@oc2-ai/core/filesystem"
import { LocationServiceMap } from "@oc2-ai/core/location-layer"
import { Ripgrep } from "@oc2-ai/core/filesystem/ripgrep"
import { Search } from "@oc2-ai/core/filesystem/search"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Log } from "@oc2-ai/core/util/log"
import { AbsolutePath, RelativePath } from "@oc2-ai/core/schema"
import { Effect, Layer, Stream } from "effect"
import fuzzysort from "fuzzysort"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const log = Log.create({ service: "server.file" })

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const search = yield* Search.Service
    const locations = yield* LocationServiceMap

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const instance = yield* InstanceState.context
      return yield* effect.pipe(
        Effect.provide(
          locations.get({
            directory: AbsolutePath.make(instance.directory),
            generation: instance.generation,
            revision: instance.revision,
          }),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const kind = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : "all")
      const started = performance.now()
      // Prefer fff (frecency + fuzzy ranking) and trust its ordering.
      const fff = yield* search.file({ cwd: directory, query: ctx.query.query, limit, kind }).pipe(Effect.orDie)
      if (fff !== undefined) {
        log.info("find file", {
          engine: "fff",
          query: ctx.query.query,
          kind,
          directory,
          limit,
          results: fff.length,
          duration: Math.round(performance.now() - started),
        })
        return fff
      }
      const fallback =
        kind === "file"
          ? fuzzyFiles(
              Array.from(yield* ripgrep.files({ cwd: directory }).pipe(Stream.runCollect, Effect.orDie)),
              ctx.query.query,
              limit,
            )
          : (yield* filesystem(
              FileSystem.Service.use((fs) =>
                fs.find({
                  query: ctx.query.query,
                  limit,
                  type: ctx.query.type,
                }),
              ),
            )).map((item) => item.path)
      log.info("find file", {
        engine: "ripgrep",
        query: ctx.query.query,
        kind,
        directory,
        limit,
        results: fallback.length,
        duration: Math.round(performance.now() - started),
      })
      return fallback
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        FileSystem.Service.use((fs) =>
          fs.list({ path: RelativePath.make(ctx.query.path) }).pipe(
            Effect.map((items) =>
              items.map((item) => ({
                name: path.basename(item.path),
                path: item.path,
                absolute: path.join(directory, item.path),
                type: item.type,
                ignored: fs.isIgnored(item.path, item.type),
              })),
            ),
          ),
        ),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.map((item) => ({
          type: item.type,
          content: item.type === "text" ? item.content.trim() : item.content,
          ...(item.type === "binary" ? { encoding: item.encoding, mimeType: item.mime } : {}),
        })),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
).pipe(Layer.provide(LocationServiceMap.layer), Layer.provide(Search.defaultLayer))

function fuzzyFiles(files: string[], query: string, limit: number) {
  const normalized = Array.from(new Set(files.map((file) => file.replaceAll("\\", "/"))))
  const text = query.trim()
  if (!text) return normalized.slice(0, limit)
  return fuzzysort.go(text, normalized, { limit }).map((item) => item.target)
}
