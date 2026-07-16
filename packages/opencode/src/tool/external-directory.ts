import path from "path"
import { Effect } from "effect"
import * as EffectLogger from "@oc2-ai/core/effect/logger"
import type * as Tool from "./tool"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { ToolPath } from "./path"
import { Session } from "@/session/session"
import { CanonicalPath } from "@/util/canonical-path"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  const session = yield* Session.Service
  yield* assertExternalDirectoryWithSession(session, ctx, target, options)
})

export const assertExternalDirectoryWithSession = Effect.fn("Tool.assertExternalDirectoryWithSession")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  const resolved = yield* CanonicalPath.resolveInfo(target)
  const full = resolved.path
  if (options?.bypass) return

  if (yield* ToolPath.insideWithSession(session, ctx, full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")
  const permission = glob

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [permission],
    always: [permission],
    metadata: {
      filepath: full,
      parentDir: dir,
      filesystemCaseInsensitive: resolved.caseInsensitive ? [permission] : [],
      filesystemCaseUnknown: resolved.caseUnknown ? [permission] : [],
    },
  })
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(
    assertExternalDirectoryEffect(ctx, target, options).pipe(
      Effect.provide(Session.defaultLayer),
      Effect.provide(EffectLogger.layer),
    ),
  )
}
