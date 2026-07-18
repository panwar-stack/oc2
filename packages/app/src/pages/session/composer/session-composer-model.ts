export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export type ComposerPresentation = {
  state: "idle" | "working" | "queued"
  action: "send" | "queue" | "queued"
}

export function composerPresentation(input: {
  working: boolean
  delivery: "steer" | "queue"
  queued: number
  hasDraft: boolean
}): ComposerPresentation {
  if (input.queued > 0 && !input.hasDraft) return { state: "queued", action: "queued" }
  if (!input.working) return { state: "idle", action: "send" }
  if (input.delivery === "queue") return { state: "working", action: "queue" }
  return { state: "working", action: "send" }
}

export function latchComposerWorkingSince(
  previous: number | undefined,
  working: boolean,
  now: number,
  sessionChanged = false,
) {
  if (!working) return undefined
  if (sessionChanged) return now
  return previous ?? now
}

export function formatComposerElapsed(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remaining = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remaining}s`
  return `${remaining}s`
}
