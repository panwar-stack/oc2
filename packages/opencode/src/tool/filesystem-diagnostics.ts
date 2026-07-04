import { Effect } from "effect"
import { Log } from "@opencode-ai/core/util/log"
import type { SessionID } from "@/session/schema"

const log = Log.create({ service: "tool.filesystem" })
const slowFilesystemInfoMs = 5_000
const slowFilesystemWarnMs = 30_000

export function logSlowFilesystem(input: {
  toolName: string
  sessionID: SessionID
  durationMs: number
  resultCount?: number
  truncated?: boolean
  partial?: boolean
  status: "success" | "error"
}) {
  return Effect.sync(() => {
    if (input.durationMs > slowFilesystemWarnMs) {
      log.warn("filesystem.slow", input)
      return
    }
    if (input.durationMs > slowFilesystemInfoMs) {
      log.info("filesystem.slow", input)
    }
  })
}
