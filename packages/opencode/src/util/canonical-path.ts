import path from "path"
import { lstat, realpath, stat } from "node:fs/promises"
import { Effect } from "effect"
import { FSUtil } from "@oc2-ai/core/fs-util"

export const resolveInfo = Effect.fn("CanonicalPath.resolveInfo")(function* (target: string) {
  const normalize = (value: string) => (process.platform === "win32" ? FSUtil.normalizePath(value) : value)
  const isNotFound = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  const exists = (value: string) =>
    Effect.promise(() =>
      lstat(value).then(
        () => true,
        (error: unknown) => {
          if (isNotFound(error)) return false
          throw error
        },
      ),
    )
  const caseInsensitive = Effect.fnUntraced(function* (value: string) {
    if (process.platform !== "darwin") return "unknown" as const
    let current = value
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) return "unknown" as const
      const currentInfo = yield* Effect.promise(() => lstat(current))
      const parentInfo = yield* Effect.promise(() => stat(parent))
      if (currentInfo.dev !== parentInfo.dev) return "unknown" as const
      const name = path.basename(current)
      const index = name.search(/[a-z]/i)
      if (index >= 0) {
        const char = name[index]
        const variant = path.join(
          path.dirname(current),
          name.slice(0, index) +
            (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()) +
            name.slice(index + 1),
        )
        const alias = yield* Effect.promise(() =>
          lstat(variant).then(
            (result) => result,
            (error: unknown) => {
              if (isNotFound(error)) return undefined
              throw error
            },
          ),
        )
        if (!alias) return "sensitive" as const
        if (alias.isSymbolicLink()) return "unknown" as const
        return alias.dev === currentInfo.dev && alias.ino === currentInfo.ino
          ? ("insensitive" as const)
          : ("sensitive" as const)
      }
      current = parent
    }
  })
  const absolute = path.resolve(normalize(target))
  const existing = yield* Effect.promise(() =>
    realpath(absolute).then(
      (value) => value,
      (error: unknown) => {
        if (isNotFound(error)) return undefined
        throw error
      },
    ),
  )
  if (existing !== undefined) {
    const canonical = normalize(existing)
    const sensitivity = yield* caseInsensitive(canonical)
    return {
      path: canonical,
      caseInsensitive: sensitivity === "insensitive",
      caseUnknown: sensitivity === "unknown",
    }
  }
  if (yield* exists(absolute)) throw new Error(`Unable to canonicalize path: ${target}`)

  let anchor = path.dirname(absolute)
  while (true) {
    const canonical = yield* Effect.promise(() =>
      realpath(anchor).then(
        (value) => value,
        (error: unknown) => {
          if (isNotFound(error)) return undefined
          throw error
        },
      ),
    )
    if (canonical !== undefined) {
      const info = yield* Effect.promise(() => stat(canonical))
      if (!info.isDirectory()) throw new Error(`Path has a non-directory ancestor: ${target}`)
      const sensitivity = yield* caseInsensitive(canonical)
      return {
        path: normalize(path.resolve(canonical, path.relative(anchor, absolute))),
        caseInsensitive: sensitivity === "insensitive",
        caseUnknown: sensitivity === "unknown",
      }
    }
    if (yield* exists(anchor)) throw new Error(`Unable to canonicalize path: ${target}`)
    const parent = path.dirname(anchor)
    if (parent === anchor) throw new Error(`Unable to canonicalize path: ${target}`)
    anchor = parent
  }
})

export const resolve = Effect.fn("CanonicalPath.resolve")(function* (target: string) {
  return (yield* resolveInfo(target)).path
})

export * as CanonicalPath from "./canonical-path"
