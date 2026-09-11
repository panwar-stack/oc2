import { Database } from "@oc2-ai/core/database/database"
import { Hash } from "@oc2-ai/core/util/hash"
import * as Log from "@oc2-ai/core/util/log"
import {
  OC2_PROCESS_ROLE,
  OC2_TEAM_ID,
  OC2_TEAM_LEAD_URL,
  OC2_TEAM_MEMBER_SESSION_ID,
  OC2_TEAM_SECRET,
  sanitizedProcessEnv,
} from "@oc2-ai/core/util/opencode-process"
import { TeamMemberTable } from "./team.sql"
import { randomBytes } from "crypto"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { mkdirSync } from "fs"
import path from "path"
import launch from "cross-spawn"
import type { ChildProcess } from "node:child_process"

const log = Log.create({ service: "member-process" })

/** Inline config env name for the spawned member process. The core
 * process-role constants file does not export this key yet, so it is declared
 * locally (the lead config loader reads it from `Flag.OC2_CONFIG_CONTENT`). */
export const OC2_CONFIG_CONTENT = "OC2_CONFIG_CONTENT"

/** Member-local database env name. The core process-role constants file does
 * not export this key yet, so it is declared locally (the core database layer
 * reads it from `Flag.OC2_DB`). */
export const OC2_DB = "OC2_DB"

/** Subdirectory below a project's `.oc2` data directory that holds one private
 * transcript-mirror database per member session. */
export const TEAMMATE_DATA_SUBDIR = "teammates"

/** Filename of a member's local transcript-mirror sqlite database. */
export const MEMBER_DB_FILE = "oc2.sqlite"

/** Stable failure surfaced when a member process cannot be spawned. */
export class MemberSpawnError extends Schema.TaggedErrorClass<MemberSpawnError>()(
  "MemberProcess.SpawnError",
  {
    memberSessionID: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail
  }
}

/** Inline prompt-id env name for the spawned member process. Optional: when
 * present, the member uses it as the messageID of its first user message so the
 * run continues the lead's durably admitted prompt. Declared locally because
 * the core process-role constants file does not export it yet. */
export const OC2_TEAM_PROMPT_ID = "OC2_TEAM_PROMPT_ID"

/** Input for {@link spawnMemberProcess}. Team/role/secret/db/config values are
 * serialized into the child environment; `memberID` identifies the durable
 * `team_member` row the caller persists the secret hash on (it is not part of
 * the child env contract). `configContent` is the JSON value of
 * `OC2_CONFIG_CONTENT`. */
export interface SpawnMemberInput {
  readonly teamID: string
  readonly memberSessionID: string
  readonly memberID: string
  readonly leadURL: string
  /** Per-member control-plane credential. The lead persists its SHA-256 hash. */
  readonly secret: string
  /** Absolute member-local sqlite path (the `OC2_DB` of the spawned process). */
  readonly dbPath: string
  /** JSON serialization of the Config.Service `Info` for the member process. */
  readonly configContent: string
  /** Optional durable admitted prompt message ID (`OC2_TEAM_PROMPT_ID`). */
  readonly promptID?: string
  /** Working directory of the child process. Defaults to the lead's cwd. */
  readonly cwd?: string
}

/** Optional env override for the CLI entrypoint the spawner prefixes on the
 * Bun executable. Production resolves `process.argv[1]`; tests and embedded
 * runs set this to the real `packages/opencode/src/index.ts` because their
 * argv[1] is the test runner, not the CLI. */
export const OC2_CLI_ENTRY = "OC2_CLI_ENTRY"

/** Resolves the current executable and argv prefix exactly like the CLI daemon
 * (`packages/cli/src/services/daemon.ts`): a compiled binary runs `teammate`
 * directly; a Bun source checkout passes the current entrypoint first so Bun
 * interprets it as the script to run. An explicit `OC2_CLI_ENTRY` env override
 * wins over `process.argv[1]` (tests and embedded hosts have no CLI argv). */
export function resolveMemberExecutableArgs(): {
  readonly execPath: string
  readonly args: string[]
} {
  const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
  const entrypoint = compiled ? undefined : (process.env[OC2_CLI_ENTRY] ?? process.argv[1])
  if (!compiled && entrypoint === undefined) {
    throw new Error("Failed to resolve CLI entrypoint")
  }
  return {
    execPath: process.execPath,
    args: [...(entrypoint ? [entrypoint] : []), "teammate"],
  }
}

/** Builds the full environment contract for a spawned member process: the
 * sanitized parent environment plus every `OC2_TEAM_*` value, `OC2_DB`, and
 * `OC2_CONFIG_CONTENT`. Any parent team/role/db values are intentionally
 * overwritten by the member contract. */
export function memberEnvContract(input: SpawnMemberInput): NodeJS.ProcessEnv {
  return sanitizedProcessEnv({
    [OC2_PROCESS_ROLE]: "teammate",
    [OC2_TEAM_LEAD_URL]: input.leadURL,
    [OC2_TEAM_ID]: input.teamID,
    [OC2_TEAM_MEMBER_SESSION_ID]: input.memberSessionID,
    [OC2_TEAM_SECRET]: input.secret,
    [OC2_DB]: input.dbPath,
    [OC2_CONFIG_CONTENT]: input.configContent,
    ...(input.promptID ? { [OC2_TEAM_PROMPT_ID]: input.promptID } : {}),
  })
}

/** Returns an absolute member-local sqlite path under `<directory>/.oc2/teammates/
 * <sessionID>/oc2.sqlite`. The `.oc2` directory is the project-local data root
 * used across this codebase, and the per-session subdirectory guarantees the
 * path never equals the lead DB path (the lead DB resolves under the XDG data
 * directory, outside the project tree, unless a test overrides `OC2_DB`). */
export function memberDbPath(directory: string, memberSessionID: string): string {
  return path.join(directory, ".oc2", TEAMMATE_DATA_SUBDIR, memberSessionID, MEMBER_DB_FILE)
}

/** Creates the parent directory of a member-local database path. Callers run
 * this before spawning when the member's `OC2_DB` must exist up front. Sync
 * Node mkdir keeps this free of Effect service requirements (the reconciler
 * spawn path has no Effect FileSystem layer in scope). */
export function ensureMemberDbDir(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true })
}

/** Hex SHA-256 digest of a member credential secret. This is the value stored
 * in `team_member.credential_hash`; a control-plane verifier compares the same
 * digest of the presented secret. */
export function hashSecret(secret: string): string {
  return Hash.sha256(secret)
}

/** Generates a strong random per-member credential (192 bits, base64url). */
export function generateSecret(): string {
  return randomBytes(24).toString("base64url")
}

/** Persists the SHA-256 hash of a member credential on the `team_member` row.
 * Runs against the passed-in db handle (the caller captures `Database.Service`
 * itself so its effect stays free of a fresh `Database.Service` requirement).
 * The write is a single-row update keyed by member id. It does not bump the
 * team revision: the credential is spawn-time admission state, not a material
 * coordination mutation that the revision counter tracks. */
export const persistMemberCredentialHash = (
  db: Database.Interface["db"],
  memberID: string,
  secretHash: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    yield* db
      .update(TeamMemberTable)
      .set({ credential_hash: secretHash, time_updated: Date.now() })
      .where(eq(TeamMemberTable.id, memberID))
      .run()
      .pipe(Effect.orDie)
  })

/** Accumulates streamed text and emits each completed line (plus any trailing
 * partial line when the stream ends) to `onLine`. A plain per-chunk split would
 * fragment lines that span chunk boundaries. */
function routeStreamLines(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ""
  return (chunk) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const text = line.trimEnd()
      if (text) onLine(text)
    }
  }
}

/** Spawns one detached, non-blocking member OS process on the current
 * executable with the `teammate` subcommand and the full member env contract.
 * Child stdout and stderr lines are logged at debug level with the member
 * session tag. Spawn failures (including an unresolvable entrypoint) surface as
 * a typed {@link MemberSpawnError}. The child is unref'd so it never keeps the
 * lead process alive by itself. */
export const spawnMemberProcess = (input: SpawnMemberInput): Effect.Effect<void, MemberSpawnError> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.try({
      try: () => resolveMemberExecutableArgs(),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.mapError(
        (error) =>
          new MemberSpawnError({
            memberSessionID: input.memberSessionID,
            detail: `Failed to resolve member executable for session ${input.memberSessionID}: ${error.message}`,
          }),
      ),
    )
    const { execPath, args } = resolved
    yield* Effect.callback<ChildProcess, MemberSpawnError>((resume) => {
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        resume(
          Effect.fail(
            new MemberSpawnError({
              memberSessionID: input.memberSessionID,
              detail: `Failed to spawn member process for session ${input.memberSessionID}: ${error.message}`,
            }),
          ),
        )
      }

      let proc: ChildProcess
      try {
        proc = launch(execPath, args, {
          detached: true,
          cwd: input.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: memberEnvContract(input),
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }

      proc.once("error", (error) => {
        if (settled) {
          log.error("member process error", { memberSessionID: input.memberSessionID, error: error.message })
          return
        }
        fail(error)
      })
      proc.once("spawn", () => {
        if (settled) return
        settled = true
        proc.unref()
        log.debug("member process spawned", {
          memberSessionID: input.memberSessionID,
          pid: proc.pid,
          execPath,
        })
        resume(Effect.succeed(proc))
      })

      // Wire output lines to the debug log immediately so no early child output
      // is lost between spawn() and the async "spawn" event. The accumulator
      // keeps partial lines across chunk boundaries intact.
      proc.stdout?.setEncoding("utf8")
      proc.stdout?.on(
        "data",
        routeStreamLines((line) => log.debug(`member stdout: ${line}`, { memberSessionID: input.memberSessionID })),
      )
      proc.stderr?.setEncoding("utf8")
      proc.stderr?.on(
        "data",
        routeStreamLines((line) => log.debug(`member stderr: ${line}`, { memberSessionID: input.memberSessionID })),
      )
      proc.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        log.debug("member process exited", {
          memberSessionID: input.memberSessionID,
          code,
          signal: signal ?? undefined,
        })
      })

      return Effect.sync(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM")
      })
    })
  })

export * as MemberProcess from "./member-process"
