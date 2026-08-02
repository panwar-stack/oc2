import path from "path"
import { Effect, Schema, Semaphore } from "effect"
import { and, inArray, isNull } from "drizzle-orm"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Database } from "@oc2-ai/core/database/database"
import { TeamFileOwnershipTable } from "@oc2-ai/core/team/ownership.sql"
import { ToolPath } from "@/tool/path"
import type { Tool } from "@/tool/tool"
import { Session } from "@/session/session"

/**
 * Exact-file ownership model for structured file tools. This is an exclusive
 * reservation system, not a filesystem sandbox: a reserved row claims one
 * exact canonical file path for one task until the task completes or cancels.
 */

export type OwnedPath = {
  rootKey: string
  pathKey: string
  displayPath: string
}

export type OwnedReservation = {
  id: string
  rootKey: string
  pathKey: string
  displayPath: string
  ownerSessionID: string | null
  timeReleased: number | null
}

type TeamFileOwnershipInsert = typeof TeamFileOwnershipTable.$inferInsert

/** Stable error for a path that cannot be reserved. */
export class OwnedPathError extends Schema.TaggedErrorClass<OwnedPathError>()("Team.OwnedPathError", {
  target: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `Cannot reserve path ${this.target}: ${this.detail}`
  }
}

/** Stable error for an already-active exact-file reservation. */
export class OwnedPathConflict extends Schema.TaggedErrorClass<OwnedPathConflict>()("Team.OwnedPathConflict", {
  displayPath: Schema.String,
}) {
  override get message() {
    return `File already reserved by another task: ${this.displayPath}`
  }
}

const caseFold = (p: string) =>
  process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p

const normalizeSlashes = (p: string) => p.replaceAll("\\", "/")

const realpathOrSelf =
  (fs: FSUtil.Interface, p: string) =>
    fs.realPath(p).pipe(Effect.catch(() => Effect.succeed(p)))

/**
 * Realpath `p`, or for a missing path realpath its nearest existing ancestor and
 * append the normalized missing segments. Returns the canonical absolute path.
 */
const nearestExisting = Effect.fn("Team.FileOwnership.nearestExisting")(function* (
  fs: FSUtil.Interface,
  p: string,
) {
  let current = p
  const missing: string[] = []
  for (;;) {
    const exists = yield* fs.exists(current).pipe(Effect.catch(() => Effect.succeed(false)))
    if (exists) {
      const real = yield* realpathOrSelf(fs, current)
      return path.join(real, ...missing)
    }
    const parent = path.dirname(current)
    if (parent === current) return p
    missing.unshift(path.basename(current))
    current = parent
  }
})

/**
 * Canonicalize an exact file target for reservation and mutation checks.
 * Shared by task creation and (in PR 6) the structured file tools.
 *
 * Rules:
 * 1. Resolve with ToolPath.resolveWithSession, including registered-root selection.
 * 2. rootKey is the realpath'd selected root directory, case-folded.
 * 3. Existing targets use realpath.
 * 4. Missing targets realpath the nearest existing ancestor and append missing segments.
 * 5. The canonical target must stay inside the canonical root (symlink escape rejected).
 * 6. `.git` path segments are rejected.
 * 7. Separators are normalized to `/`.
 * 8. The pathKey is case-folded on Windows and macOS.
 * 9. displayPath is a stable root-relative path, separate from the canonical key.
 *
 * Exact files only: existing directory claims and glob metacharacters are rejected.
 */
export const canonicalize = Effect.fn("Team.FileOwnership.canonicalize")(function* (
  session: Session.Interface,
  ctx: Tool.Context,
  target: string,
) {
  const fs = yield* FSUtil.Service
  const resolved = yield* ToolPath.resolveWithSession(session, ctx, target)
  const root = resolved.root

  const canonicalRoot = yield* nearestExisting(fs, root.directory)
  const rootKey = caseFold(normalizeSlashes(canonicalRoot))

  const canonicalTarget = yield* nearestExisting(fs, resolved.path)

  if (!FSUtil.contains(canonicalRoot, canonicalTarget)) {
    return yield* Effect.fail(new OwnedPathError({ target, detail: "path escapes the workspace root" }))
  }

  const relative = path.relative(canonicalRoot, canonicalTarget)
  if (relative.split(/[\\/]/).some((segment) => segment === ".git")) {
    return yield* Effect.fail(new OwnedPathError({ target, detail: ".git path segments are not allowed" }))
  }

  if (/[*?[\]{}]/.test(target)) {
    return yield* Effect.fail(new OwnedPathError({ target, detail: "glob patterns are not allowed; reserve exact files only" }))
  }

  const stat = yield* fs.stat(resolved.path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (stat && stat.type === "Directory") {
    return yield* Effect.fail(new OwnedPathError({ target, detail: "directories cannot be reserved; reserve exact files only" }))
  }

  const pathKey = caseFold(normalizeSlashes(canonicalTarget))
  const displayPath = normalizeSlashes(relative)
  return { rootKey, pathKey, displayPath }
})

/** Reject two distinct inputs that canonicalize to the same pathKey. */
export const assertNoDuplicateAliases = Effect.fn("Team.FileOwnership.assertNoDuplicateAliases")(function* (
  owned: readonly OwnedPath[],
) {
  const seen = new Map<string, string>()
  for (const entry of owned) {
    const existing = seen.get(entry.pathKey)
    if (existing !== undefined) {
      return yield* Effect.fail(
        new OwnedPathError({
          target: entry.displayPath,
          detail: `duplicate alias of ${existing}`,
        }),
      )
    }
    seen.set(entry.pathKey, entry.displayPath)
  }
})

/**
 * Fail if any of the given pathKeys has an active reservation (time_released IS
 * NULL). The partial unique index is the final race guard; this pre-check gives
 * a stable, conflict-naming error inside the same transaction.
 */
export const assertNoActivePathConflicts = Effect.fn("Team.FileOwnership.assertNoActivePathConflicts")(function* (
  db: Pick<Database.Interface["db"], "select">,
  paths: readonly OwnedPath[],
) {
  if (paths.length === 0) return
  const pathKeys = [...new Set(paths.map((entry) => entry.pathKey))]
  const row = yield* db
    .select({ displayPath: TeamFileOwnershipTable.display_path })
    .from(TeamFileOwnershipTable)
    .where(and(isNull(TeamFileOwnershipTable.time_released), inArray(TeamFileOwnershipTable.path_key, pathKeys)))
    .get()
  if (row) return yield* Effect.fail(new OwnedPathConflict({ displayPath: row.displayPath }))
})

/** Build the reservation rows for an owned task. All rows start unowned and active. */
export const buildReservationRows = (input: {
  id: string
  teamID: string
  taskID: string
  owned: readonly OwnedPath[]
  now: number
}): TeamFileOwnershipInsert[] =>
  input.owned.map((entry, index) => ({
    id: `${input.id}-${index}`,
    team_id: input.teamID,
    task_id: input.taskID,
    root_key: entry.rootKey,
    path_key: entry.pathKey,
    display_path: entry.displayPath,
    owner_session_id: null,
    time_released: null,
    time_created: input.now,
    time_updated: input.now,
  }))

export const toOwnedReservation = (row: typeof TeamFileOwnershipTable.$inferSelect): OwnedReservation => ({
  id: row.id,
  rootKey: row.root_key,
  pathKey: row.path_key,
  displayPath: row.display_path,
  ownerSessionID: row.owner_session_id,
  timeReleased: row.time_released,
})

/**
 * Stable denial for a structured write to a path with an active reservation owned by another
 * session (or by no session yet). Emitted only while holding the sorted path locks, so the
 * check-to-mutation race inside one project instance is closed.
 */
export class OwnedWriteDenied extends Schema.TaggedErrorClass<OwnedWriteDenied>()("Team.OwnedWriteDenied", {
  displayPath: Schema.String,
  taskID: Schema.String,
}) {
  override get message() {
    return `Write denied: ${this.displayPath} is reserved by task ${this.taskID.slice(0, 8)}. Complete or cancel that task before writing this file.`
  }
}

/** Process-wide in-process keyed lock registry: one semaphore per canonical pathKey. */
const locks = new Map<string, Semaphore.Semaphore>()

function lockFor(pathKey: string) {
  const existing = locks.get(pathKey)
  if (existing) return existing
  const next = Semaphore.makeUnsafe(1)
  locks.set(pathKey, next)
  return next
}

/**
 * Acquire one permit per unique canonical pathKey in SORTED order, run `effect`, and release the
 * permits in reverse order. Sorted acquisition prevents lock-order deadlock between any two
 * multi-path operations, and `withPermits` guarantees release on success, failure, or interrupt.
 */
export const withPathLocks = <A, E, R>(
  pathKeys: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const unique = [...new Set(pathKeys)].sort()
  let wrapped = effect
  for (let index = unique.length - 1; index >= 0; index--) {
    const semaphore = lockFor(unique[index]!)
    wrapped = semaphore.withPermits(1)(wrapped)
  }
  return wrapped
}

/** Inside the held locks, verify every active reservation belongs to `sessionID`. */
const assertLeaseAllowed = Effect.fn("Team.FileOwnership.assertLeaseAllowed")(function* (
  db: Pick<Database.Interface["db"], "select">,
  sessionID: string,
  pathKeys: readonly string[],
) {
  const unique = [...new Set(pathKeys)]
  if (unique.length === 0) return
  const rows = yield* db
    .select({
      displayPath: TeamFileOwnershipTable.display_path,
      taskID: TeamFileOwnershipTable.task_id,
      ownerSessionID: TeamFileOwnershipTable.owner_session_id,
    })
    .from(TeamFileOwnershipTable)
    .where(and(isNull(TeamFileOwnershipTable.time_released), inArray(TeamFileOwnershipTable.path_key, unique)))
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) {
    // An active reservation with no owner, or with a different owner, denies the mutation. The
    // authoritative owner succeeds; an unreserved (protocol-0) path remains allowed.
    if (row.ownerSessionID === null || row.ownerSessionID !== sessionID) {
      return yield* Effect.fail(new OwnedWriteDenied({ displayPath: row.displayPath, taskID: row.taskID }))
    }
  }
})

/**
 * Structured write lease: acquire the sorted path locks, verify inside the locks that every active
 * reservation for the given canonical pathKeys is owned by `sessionID` (or unreserved), then run the
 * full mutation (permission ask plus all writes) while holding the locks. One denied path fails the
 * whole operation before any permission ask or mutation.
 */
export const withWriteLease = <A, E, R>(
  db: Pick<Database.Interface["db"], "select">,
  sessionID: string,
  pathKeys: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OwnedWriteDenied, R> =>
  withPathLocks(pathKeys, assertLeaseAllowed(db, sessionID, pathKeys).pipe(Effect.andThen(effect)))

/**
 * Sorted path locks for the service on reservation mutation: task creation holds them from before
 * the conflict check through commit; release/cancellation holds them before changing reservation
 * state. Identical ordering to `withWriteLease`, so service and file tools never deadlock.
 */
export const withReservationLocks = <A, E, R>(
  pathKeys: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withPathLocks(pathKeys, effect)

export * as FileOwnership from "./file-ownership"
