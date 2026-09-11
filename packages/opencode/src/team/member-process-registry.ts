// Process-local registry of spawned member OS processes, keyed by member session id.
//
// This is intentionally plain module state with no Effect or database dependency: the
// spawner is a detached, non-blocking launch whose ChildProcess handle lives only in the
// lead process, and the shutdown handler needs a synchronous best-effort way to reach it.
// The registry is empty when the multi-process transport flag is off, so every operation
// is a no-op and default behavior is unchanged.
//
// Cross-VM note: a member process on another host has no handle in this process. Such a
// member observes `team.closed` on its control-plane SSE stream and exits on its own, so
// shutdown termination here must never be treated as the only stop mechanism.
import type { ChildProcess } from "node:child_process"

const processes = new Map<string, ChildProcess>()

/** Records the live child process for a member session. Overwrites any stale entry. */
export function register(sessionID: string, proc: ChildProcess): void {
  processes.set(sessionID, proc)
}

/** Drops a member session's handle. Safe to call for an unknown session. */
export function unregister(sessionID: string): void {
  processes.delete(sessionID)
}

/** Best-effort `SIGTERM` for one member session. Returns true when a live child was
 * signalled. A member with no local handle (another VM, already exited, or the feature
 * off) returns false and is left to stop through `team.closed`. */
export function terminate(sessionID: string): boolean {
  const proc = processes.get(sessionID)
  if (!proc) return false
  if (proc.exitCode !== null || proc.signalCode !== null) return false
  try {
    return proc.kill("SIGTERM")
  } catch {
    return false
  }
}

/** Terminates every given member session that has a live local child. Returns the count
 * of processes that accepted the signal. */
export function terminateMany(sessionIDs: readonly string[]): number {
  let count = 0
  for (const sessionID of sessionIDs) {
    if (terminate(sessionID)) count += 1
  }
  return count
}

/** Clears all handles. For tests and process teardown; it does not kill children. */
export function clear(): void {
  processes.clear()
}

export * as MemberProcessRegistry from "./member-process-registry"
