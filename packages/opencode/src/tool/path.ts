import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { CanonicalPath } from "@/util/canonical-path"
import type * as Tool from "./tool"

export type Root = Pick<Session.RootInfo, "directory" | "worktree" | "primary">

export type Resolved = {
  path: string
  root: Root
  relative: string
  permission: string
  caseInsensitive: boolean
  caseUnknown: boolean
}

export const roots = Effect.fn("ToolPath.roots")(function* (session: Session.Interface, ctx: Tool.Context) {
  const instance = yield* InstanceState.context
  const list = yield* session.listRoots(ctx.sessionID).pipe(
    Effect.catch(() =>
      Effect.succeed([
        {
          directory: instance.directory,
          worktree: instance.worktree,
          primary: true,
        },
      ]),
    ),
  )
  return yield* Effect.forEach(list, (root) =>
    CanonicalPath.resolve(root.directory).pipe(Effect.map((directory) => ({ ...root, directory }))),
  )
})

export const primary = Effect.fn("ToolPath.primary")(function* (ctx: Tool.Context) {
  const session = yield* Session.Service
  return yield* primaryWithSession(session, ctx)
})

export const primaryWithSession = Effect.fn("ToolPath.primaryWithSession")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
) {
  const list = yield* roots(session, ctx)
  const root = list.find((root) => root.primary) ?? list[0]
  if (root) return root
  const instance = yield* InstanceState.context
  return {
    directory: instance.directory,
    worktree: instance.worktree,
    primary: true,
  }
})

export const containingRoot = Effect.fn("ToolPath.containingRoot")(function* (ctx: Tool.Context, target: string) {
  const session = yield* Session.Service
  return yield* containingRootWithSession(session, ctx, target)
})

export const containingRootWithSession = Effect.fn("ToolPath.containingRootWithSession")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
  target: string,
) {
  const filepath = yield* canonical(target)
  return (yield* roots(session, ctx)).find((root) => contains(root.directory, filepath))
})

export const inside = Effect.fn("ToolPath.inside")(function* (ctx: Tool.Context, target: string) {
  const session = yield* Session.Service
  return yield* insideWithSession(session, ctx, target)
})

export const insideWithSession = Effect.fn("ToolPath.insideWithSession")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
  target: string,
) {
  return Boolean(yield* containingRootWithSession(session, ctx, target))
})

export const resolve = Effect.fn("ToolPath.resolve")(function* (ctx: Tool.Context, target?: string) {
  const session = yield* Session.Service
  return yield* resolveWithSession(session, ctx, target)
})

export const resolveWithSession = Effect.fn("ToolPath.resolveWithSession")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
  target?: string,
) {
  const list = yield* roots(session, ctx)
  const root = list.find((item) => item.primary) ?? list[0]
  if (!root) throw new Error("Session has no filesystem root")
  const targetInfo = yield* CanonicalPath.resolveInfo(
    path.isAbsolute(target ?? root.directory)
      ? (target ?? root.directory)
      : path.resolve(root.directory, target ?? "."),
  )
  const filepath = targetInfo.path
  const match = list.find((item) => contains(item.directory, filepath)) ?? root
  const resource = relative(match, filepath)
  return {
    path: filepath,
    root: match,
    relative: resource,
    permission: targetInfo.caseInsensitive ? resource.toLowerCase() : resource,
    caseInsensitive: targetInfo.caseInsensitive,
    caseUnknown: targetInfo.caseUnknown,
  }
})

export function relative(root: Root, target: string) {
  return path.relative(root.directory, target).replaceAll("\\", "/")
}

export function normalize(target: string) {
  return process.platform === "win32" ? FSUtil.normalizePath(target) : target
}

export const canonical = CanonicalPath.resolve

function contains(base: string, target: string) {
  return FSUtil.contains(normalize(base), target)
}

export * as ToolPath from "./path"
