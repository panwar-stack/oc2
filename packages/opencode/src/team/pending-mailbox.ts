import { Database } from "@oc2-ai/core/database/database"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { TeamMessageRecipientTable } from "./team.sql"

/**
 * Non-destructive pending-mailbox probe. Reports whether the recipient session has any
 * TeamMessageRecipientTable rows still in "pending" state. Unlike claimPendingMessages,
 * this never transitions delivery_status, so a paused session's mailbox stays claimable
 * exactly once after resume.
 */
export const hasPendingMailboxMessages = Effect.fn("Team.hasPendingMailboxMessages")((
  db: Database.Interface["db"],
  recipientSession: string,
) =>
  db
    .select({ id: TeamMessageRecipientTable.id })
    .from(TeamMessageRecipientTable)
    .where(
      and(
        eq(TeamMessageRecipientTable.recipient, recipientSession),
        eq(TeamMessageRecipientTable.delivery_status, "pending"),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie, Effect.map((row) => row !== undefined)),
)

export * as PendingMailbox from "./pending-mailbox"
