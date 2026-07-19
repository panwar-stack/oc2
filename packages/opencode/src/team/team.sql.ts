import { sql } from "drizzle-orm"
import { text, integer, sqliteTable, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@oc2-ai/core/database/schema.sql"

export const TeamTable = sqliteTable(
  "team",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    goal: text().notNull(),
    lead_session_id: text().notNull(),
    status: text({ enum: ["active", "closed", "cancelled"] })
      .notNull()
      .default("active"),
    board_revision: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => ({
    lead_session_idx: uniqueIndex("team_active_lead_session_idx")
      .on(table.lead_session_id)
      .where(sql`${table.status} = 'active'`),
  }),
)

export const TeamMemberTable = sqliteTable(
  "team_member",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    session_id: text().notNull(),
    name: text().notNull(),
    agent_type: text().notNull(),
    model: text({ mode: "json" }).$type<{ providerID: string; modelID: string; variant?: string } | null>(),
    role_prompt: text().notNull(),
    role: text(),
    display_summary: text(),
    mutability: text({ enum: ["read_only", "write_allowed", "unknown"] })
      .notNull()
      .default("unknown"),
    current_work_source: text({ enum: ["task", "assignment"] }),
    current_work_id: text(),
    work_started_at: integer(),
    execution_epoch: integer().notNull().default(0),
    execution_state: text({ enum: ["starting", "busy", "retry", "idle"] }),
    lease_owner_id: text(),
    lease_expires_at: integer(),
    outcome_type: text({ enum: ["succeeded", "failed", "cancelled", "interrupted"] }),
    outcome_label: text({ enum: ["completed", "failed", "cancelled", "interrupted"] }),
    outcome_cause: text(),
    outcome_at: integer(),
    status: text({ enum: ["starting", "blocked", "active", "idle", "completed", "cancelled"] })
      .notNull()
      .default("starting"),
    lifecycle: text({ enum: ["task", "daemon"] })
      .notNull()
      .default("task"),
    daemon_state: text({ enum: ["initializing", "running", "idle", "cancelled", "error"] }),
    daemon_last_active: integer(),
    daemon_error: text(),
    plan_mode: integer({ mode: "boolean" }).notNull().default(false),
    work_mode: text({ enum: ["plan", "implement"] })
      .notNull()
      .default("implement"),
    dependency_ids: text({ mode: "json" }).$type<string[] | null>(),
    result: text(),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_member_team_idx").on(table.team_id, table.session_id),
    session_idx: uniqueIndex("team_member_session_idx").on(table.session_id),
  }),
)

export const TeamTaskTable = sqliteTable(
  "team_task",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    description: text().notNull(),
    status: text({ enum: ["pending", "in_progress", "completed", "cancelled"] })
      .notNull()
      .default("pending"),
    assignee: text(),
    dependency_ids: text({ mode: "json" }).$type<string[] | null>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown> | null>(),
    started_at: integer(),
    completed_at: integer(),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_task_team_idx").on(table.team_id, table.id),
  }),
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    sender: text().notNull(),
    recipients: text({ mode: "json" }).$type<string[]>().notNull(),
    body: text().notNull(),
    delivery_status: text({ enum: ["pending", "delivered", "read"] })
      .notNull()
      .default("pending"),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_message_team_idx").on(table.team_id, table.id),
    recipient_idx: index("team_message_recipient_idx").on(table.team_id, table.delivery_status),
  }),
)

export const TeamMessageRecipientTable = sqliteTable(
  "team_message_recipient",
  {
    id: text().primaryKey(),
    message_id: text().notNull(),
    team_id: text().notNull(),
    recipient: text().notNull(),
    delivery_status: text({ enum: ["pending", "delivered", "read"] })
      .notNull()
      .default("pending"),
    ...Timestamps,
  },
  (table) => ({
    message_recipient_idx: uniqueIndex("team_message_recipient_message_idx").on(table.message_id, table.recipient),
    recipient_idx: index("team_message_recipient_status_idx").on(table.team_id, table.recipient, table.delivery_status),
  }),
)

export const TeamUsageEventTable = sqliteTable(
  "team_usage_event",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    session_id: text(),
    member_id: text(),
    type: text({ enum: ["plan_approved", "plan_rejected", "broadcast_sent", "report_generated"] }).notNull(),
    metadata: text({ mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    time_created: integer().notNull(),
  },
  (table) => ({
    team_idx: index("team_usage_event_team_idx").on(table.team_id, table.time_created),
  }),
)

export const TeamBoardOutboxTable = sqliteTable(
  "team_board_outbox",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    revision: integer().notNull(),
    reasons: text({ mode: "json" }).$type<string[]>().notNull(),
    published_at: integer(),
    ...Timestamps,
  },
  (table) => ({
    revision_idx: uniqueIndex("team_board_outbox_revision_idx").on(table.team_id, table.revision),
    pending_idx: index("team_board_outbox_pending_idx").on(table.published_at, table.team_id, table.revision),
  }),
)

export const TeamPlanReviewTable = sqliteTable(
  "team_plan_review",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    member_id: text().notNull(),
    submitted_by_session_id: text().notNull(),
    plan_body: text().notNull(),
    state: text({ enum: ["drafting", "submitted", "approved", "rejected"] })
      .notNull()
      .default("submitted"),
    decision: text({ enum: ["approve", "reject"] }),
    decision_feedback: text(),
    decided_by_session_id: text(),
    decided_at: integer(),
    ...Timestamps,
  },
  (table) => ({
    team_idx: uniqueIndex("team_plan_review_team_idx").on(table.team_id, table.id),
    member_state_idx: index("team_plan_review_member_state_idx").on(
      table.team_id,
      table.member_id,
      table.state,
      table.time_created,
    ),
  }),
)

export const TeamAttentionTable = sqliteTable(
  "team_attention",
  {
    id: text().primaryKey(),
    team_id: text().notNull(),
    member_id: text().notNull(),
    session_id: text().notNull(),
    kind: text({ enum: ["permission", "question"] }).notNull(),
    detail_id: text().notNull(),
    detail: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    state: text({ enum: ["open", "resolved", "cancelled"] })
      .notNull()
      .default("open"),
    resolution: text(),
    ...Timestamps,
  },
  (table) => ({
    detail_idx: uniqueIndex("team_attention_detail_idx").on(table.kind, table.detail_id),
    team_state_idx: index("team_attention_team_state_idx").on(
      table.team_id,
      table.state,
      table.kind,
      table.time_created,
    ),
  }),
)
