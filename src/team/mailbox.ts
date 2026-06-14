import type {
  TeamMailboxRepository,
  DeliveredTeamMessage,
  TeamMailboxMessage,
} from "../persistence/repositories/mailbox"
import type { TeamMemberRecord } from "../persistence/repositories/teams"

/** Resolves logical team recipients to persisted mailbox recipient keys. */
export function resolveTeamRecipients(input: {
  readonly requested: readonly string[]
  readonly leadSessionId: string
  readonly members: readonly TeamMemberRecord[]
}): readonly string[] {
  return input.requested.map((recipient) => resolveTeamRecipient(recipient, input.leadSessionId, input.members))
}

/** Resolves one mailbox recipient by lead alias, member name, or member session id. */
export function resolveTeamRecipient(
  requested: string,
  leadSessionId: string,
  members: readonly TeamMemberRecord[],
): string {
  if (requested === "lead") return "lead"
  const member = members.find((candidate) => candidate.name === requested || candidate.sessionId === requested)
  return member?.name ?? (requested === leadSessionId ? "lead" : requested)
}

/** Returns the mailbox keys a session may receive through. */
export function recipientKeysForSession(input: {
  readonly sessionId: string
  readonly leadSessionId: string
  readonly members: readonly TeamMemberRecord[]
}): readonly string[] {
  const keys = [input.sessionId]
  if (input.sessionId === input.leadSessionId) keys.push("lead")
  const member = input.members.find((candidate) => candidate.sessionId === input.sessionId)
  if (member) keys.push(member.name)
  return [...new Set(keys)]
}

export type { DeliveredTeamMessage, TeamMailboxMessage, TeamMailboxRepository }
