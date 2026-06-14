import type { Database } from "bun:sqlite"
import { fromJson, toJson } from "./json"

export interface TeamMailboxMessage {
  readonly id: string
  readonly teamId: string
  readonly sender: string
  readonly recipients: readonly string[]
  readonly body: string
  readonly deliveryStatus: "pending" | "delivered"
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DeliveredTeamMessage extends TeamMailboxMessage {
  readonly recipient: string
}

interface MessageRow {
  readonly id: string
  readonly team_id: string
  readonly sender: string
  readonly recipients_json: string
  readonly body: string
  readonly delivery_status: "pending" | "delivered"
  readonly created_at: string
  readonly updated_at: string
}

interface RecipientRow extends MessageRow {
  readonly recipient: string
}

const createId = (): string => crypto.randomUUID()

/** Repository for team mailbox messages and per-recipient delivery state. */
export class TeamMailboxRepository {
  constructor(private readonly db: Database) {}

  send(input: {
    readonly teamId: string
    readonly sender: string
    readonly recipients: readonly string[]
    readonly body: string
    readonly now?: string
  }): TeamMailboxMessage {
    const now = input.now ?? new Date().toISOString()
    const id = createId()
    const recipients = [...new Set(input.recipients)].filter(Boolean)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db
        .query(
          `INSERT INTO team_messages (id, team_id, sender, recipients_json, body, delivery_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.teamId, input.sender, toJson(recipients), input.body, "pending", now, now)
      const insertRecipient = this.db.query(
        `INSERT INTO team_message_recipients (id, message_id, team_id, recipient, delivery_status, delivered_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const recipient of recipients)
        insertRecipient.run(createId(), id, input.teamId, recipient, "pending", null, now)
      this.db.exec("COMMIT")
      return this.get(id) as TeamMailboxMessage
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  get(id: string): TeamMailboxMessage | undefined {
    const row = this.db.query<MessageRow, [string]>("SELECT * FROM team_messages WHERE id = ?").get(id)
    return row ? toMessage(row) : undefined
  }

  deliver(
    teamId: string,
    recipients: readonly string[],
    now = new Date().toISOString(),
  ): readonly DeliveredTeamMessage[] {
    const uniqueRecipients = [...new Set(recipients)].filter(Boolean)
    if (uniqueRecipients.length === 0) return []
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const delivered: DeliveredTeamMessage[] = []
      for (const recipient of uniqueRecipients) {
        const rows = this.db
          .query<RecipientRow, [string, string]>(
            `SELECT team_messages.*, team_message_recipients.recipient
             FROM team_message_recipients
             JOIN team_messages ON team_messages.id = team_message_recipients.message_id
             WHERE team_message_recipients.team_id = ?
               AND team_message_recipients.recipient = ?
               AND team_message_recipients.delivery_status = 'pending'
             ORDER BY team_messages.created_at, team_messages.id`,
          )
          .all(teamId, recipient)
        for (const row of rows) delivered.push({ ...toMessage(row), recipient: row.recipient })
        this.db
          .query(
            `UPDATE team_message_recipients
             SET delivery_status = 'delivered', delivered_at = ?
             WHERE team_id = ? AND recipient = ? AND delivery_status = 'pending'`,
          )
          .run(now, teamId, recipient)
      }
      const messageIds = [...new Set(delivered.map((message) => message.id))]
      for (const messageId of messageIds) {
        const pending =
          this.db
            .query<
              { readonly count: number },
              [string]
            >("SELECT COUNT(*) AS count FROM team_message_recipients WHERE message_id = ? AND delivery_status = 'pending'")
            .get(messageId)?.count ?? 0
        if (pending === 0) {
          this.db
            .query("UPDATE team_messages SET delivery_status = 'delivered', updated_at = ? WHERE id = ?")
            .run(now, messageId)
        }
      }
      this.db.exec("COMMIT")
      return delivered
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}

function toMessage(row: MessageRow): TeamMailboxMessage {
  return {
    id: row.id,
    teamId: row.team_id,
    sender: row.sender,
    recipients: fromJson<readonly string[]>(row.recipients_json, []),
    body: row.body,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
