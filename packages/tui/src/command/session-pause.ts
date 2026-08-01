import type { SessionControlResult } from "@oc2-ai/sdk/v2"

/**
 * TUI-side pause control state for one session.
 *
 * The server read model exposes only the *effective* paused flag. Cascade ownership
 * (who rooted the pause) is only observable through the pause/start action results,
 * so the TUI keeps the small amount of extra state it has learned locally:
 *
 * - `cascadeID` is set once this client successfully paused the session.
 * - `ancestorBlocked` is set when a start released this session's cascade but the
 *   session stayed paused, which only happens when an ancestor owns a pause.
 */
export type SessionPauseState = {
  /** Effective paused state reported by the server read model. */
  paused: boolean
  /** Cascade owned by this session; present after this client paused it. */
  cascadeID?: string
  /** Paused by an ancestor pause instead of a cascade owned by this session. */
  ancestorBlocked?: boolean
}

/**
 * A session owns an active cascade when this client paused it (cascadeID is known)
 * or, at hydration time, when it is effectively paused and there is no evidence it
 * is only blocked by an ancestor. That conservative default keeps `/unpause` available
 * for every effectively paused root; an actual child-of-ancestor case is corrected
 * the first time `/unpause` reports the session as still blocked.
 */
export function sessionOwnsCascade(state: SessionPauseState | undefined): boolean {
  if (!state) return false
  if (state.cascadeID !== undefined) return true
  return state.paused && !state.ancestorBlocked
}

/** `/pause` is available while the viewed session does not own an active cascade. */
export function pauseCommandEnabled(state: SessionPauseState | undefined): boolean {
  return !sessionOwnsCascade(state)
}

/** `/unpause` is available while the viewed session owns an active cascade. */
export function unpauseCommandEnabled(state: SessionPauseState | undefined): boolean {
  return sessionOwnsCascade(state)
}

export type PauseStartAction = "pause" | "unpause"

export type PauseStartFeedback = {
  /** Pause state to record for the action root after the call. */
  state: SessionPauseState
  message: string
  variant: "info" | "success" | "warning" | "error"
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * Translate one typed pause/unpause result into the root's new pause state and the
 * user-facing feedback. `unchanged` reports an idempotent call: pause on a root
 * that already owns a cascade, or unpause on a root without one.
 */
export function controlResultFeedback(action: PauseStartAction, result: SessionControlResult): PauseStartFeedback {
  const root = result.rootSessionID
  const rootStillBlocked = result.stillBlockedSessionIDs.includes(root)

  if (action === "pause") {
    if (result.unchanged) {
      return {
        state: { paused: true, cascadeID: result.cascadeID, ancestorBlocked: false },
        message: "Session is already paused",
        variant: "info",
      }
    }
    const affected = result.affectedSessionIDs.length
    const signalled = result.interruptionSignalledSessionIDs.length
    const message =
      signalled > 0
        ? `Paused ${plural(affected, "session")}; interrupted ${plural(signalled, "running session")}`
        : `Paused ${plural(affected, "session")}`
    return {
      state: { paused: true, cascadeID: result.cascadeID, ancestorBlocked: false },
      message,
      variant: "success",
    }
  }

  if (result.unchanged) {
    if (rootStillBlocked) {
      return {
        state: { paused: true, ancestorBlocked: true },
        message: "This session is paused by an ancestor; unpause it from that ancestor",
        variant: "warning",
      }
    }
    return {
      state: { paused: false },
      message: "Session is not paused",
      variant: "info",
    }
  }

  if (rootStillBlocked) {
    return {
      state: { paused: true, ancestorBlocked: true },
      message: `Released this pause, but the session stays paused by an ancestor${blockedSuffix(result)}`,
      variant: "warning",
    }
  }

  const scheduled = result.scheduledSessionIDs.length
  return {
    state: { paused: false },
    message:
      scheduled > 0 ? `Unpaused; resumed ${plural(scheduled, "session")}` : "Unpaused session; nothing queued to resume",
    variant: "success",
  }
}

function blockedSuffix(result: SessionControlResult) {
  const others =
    result.stillBlockedSessionIDs.length - (result.stillBlockedSessionIDs.includes(result.rootSessionID) ? 1 : 0)
  return others > 0 ? ` (${plural(others, "descendant")} still blocked)` : ""
}

/**
 * Minimal SDK surface the pause/unpause commands need, so tests can inject a fake
 * and the route can pass the real client.
 */
export type PauseStartClient = {
  session: {
    pause: (parameters: { sessionID: string; workspace?: string }) => Promise<{
      data?: SessionControlResult
      error?: unknown
    }>
    start: (parameters: { sessionID: string; workspace?: string }) => Promise<{
      data?: SessionControlResult
      error?: unknown
    }>
  }
}

export type PauseStartDispatch = { ok: true; result: SessionControlResult } | { ok: false; error: unknown }

/**
 * Call the typed pause/unpause API for one session. The `unpause` action maps to
 * `client.session.start`; only the HTTP method name is transport-internal and stays
 * `start`. `sessionID` is the viewed session, which is also the cascade root.
 */
export async function dispatchPauseStart(
  client: PauseStartClient,
  action: PauseStartAction,
  sessionID: string,
  workspace: string | undefined,
): Promise<PauseStartDispatch> {
  const response =
    action === "pause"
      ? await client.session.pause({ sessionID, workspace })
      : await client.session.start({ sessionID, workspace })
  if (response.error) return { ok: false, error: response.error }
  if (!response.data) return { ok: false, error: new Error("Pause/unpause returned no result") }
  return { ok: true, result: response.data }
}

export type PauseStartCommandContext = {
  /** The viewed session ID; undefined outside a session route. */
  sessionID: () => string | undefined
  /** Effective pause state of the viewed session. */
  pauseState: () => SessionPauseState | undefined
  /** Invoked with the selected action when the command runs. */
  run: (action: PauseStartAction) => void
}

/**
 * Build the `/pause` or `/unpause` local session command descriptor in the same
 * shape the session route registers through `sessionCommands()`.
 */
export function createPauseStartCommand(action: PauseStartAction, ctx: PauseStartCommandContext) {
  if (action === "pause") {
    return {
      title: "Pause session",
      value: "session.pause",
      category: "Session",
      slash: { name: "pause", aliases: undefined },
      enabled: !!ctx.sessionID() && pauseCommandEnabled(ctx.pauseState()),
      run: () => ctx.run("pause"),
    }
  }
  return {
    title: "Unpause session",
    value: "session.unpause",
    category: "Session",
    slash: { name: "unpause", aliases: ["start"] },
    enabled: !!ctx.sessionID() && unpauseCommandEnabled(ctx.pauseState()),
    run: () => ctx.run("unpause"),
  }
}

/** Register both `/pause` and `/unpause` for the session command list. */
export function createPauseStartCommands(ctx: PauseStartCommandContext) {
  return [createPauseStartCommand("pause", ctx), createPauseStartCommand("unpause", ctx)]
}
