import { Database } from "@opencode-ai/core/database/database"
import { inArray } from "drizzle-orm"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { Workspace } from "@/control-plane/workspace"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import * as Log from "@opencode-ai/core/util/log"
import { Naming } from "@opencode-ai/core/naming"
import { Effect } from "effect"

export const HEADER = Naming.headers.sync[0]
export const LEGACY_HEADER = Naming.headers.sync[1]
export type State = Record<string, number>
const log = Log.create({ service: "fence" })

export function load(db: Database.Interface["db"], ids?: string[]) {
  return Effect.gen(function* () {
    const rows = yield* (
      ids?.length
        ? db.select().from(EventSequenceTable).where(inArray(EventSequenceTable.aggregate_id, ids)).all()
        : db.select().from(EventSequenceTable).all()
    ).pipe(Effect.orDie)

    return Object.fromEntries(rows.map((row) => [row.aggregate_id, row.seq]))
  })
}

export function diff(prev: State, next: State) {
  const ids = new Set([...Object.keys(prev), ...Object.keys(next)])
  return Object.fromEntries(
    [...ids]
      .map((id) => [id, next[id] ?? -1] as const)
      .filter(([id, seq]) => {
        return (prev[id] ?? -1) !== seq
      }),
  )
}

export function parse(headers: Headers): State | undefined {
  const raw = Naming.header(headers, Naming.headers.sync)
  if (!raw) return

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  if (!data || typeof data !== "object") return

  return Object.fromEntries(
    Object.entries(data).filter((entry): entry is [string, number] => {
      return typeof entry[0] === "string" && Number.isInteger(entry[1])
    }),
  )
}

export function wait(workspaceID: WorkspaceV2.ID, state: State, signal?: AbortSignal) {
  return Effect.gen(function* () {
    log.info("waiting for state", {
      workspaceID,
      state,
    })
    yield* Workspace.Service.use((workspace) => workspace.waitForSync(workspaceID, state, signal))
    log.info("state fully synced", {
      workspaceID,
      state,
    })
  })
}
