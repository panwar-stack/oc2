import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260718001000_add_team_board_semantics",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `team` ADD COLUMN `board_revision` integer DEFAULT 0 NOT NULL")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `role` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `display_summary` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `mutability` text DEFAULT 'unknown' NOT NULL")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `current_work_source` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `current_work_id` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `work_started_at` integer")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `execution_epoch` integer DEFAULT 0 NOT NULL")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `execution_state` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `lease_owner_id` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `lease_expires_at` integer")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `outcome_type` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `outcome_label` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `outcome_cause` text")
      yield* tx.run("ALTER TABLE `team_member` ADD COLUMN `outcome_at` integer")
      yield* tx.run("ALTER TABLE `team_task` ADD COLUMN `started_at` integer")
      yield* tx.run("ALTER TABLE `team_task` ADD COLUMN `completed_at` integer")
      yield* tx.run(`
        UPDATE team_member
        SET outcome_type = 'succeeded', outcome_label = 'completed', outcome_cause = 'cause_unknown', outcome_at = time_updated
        WHERE status = 'completed'
      `)
      yield* tx.run(`
        UPDATE team_member
        SET outcome_type = 'cancelled', outcome_label = 'cancelled', outcome_cause = 'cause_unknown', outcome_at = time_updated
        WHERE status = 'cancelled'
      `)
      yield* tx.run(`
        CREATE TABLE team_board_outbox (
          id text PRIMARY KEY NOT NULL,
          team_id text NOT NULL,
          revision integer NOT NULL,
          reasons text NOT NULL,
          published_at integer,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        )
      `)
      yield* tx.run(
        "CREATE UNIQUE INDEX team_board_outbox_revision_idx ON team_board_outbox (team_id, revision)",
      )
      yield* tx.run(
        "CREATE INDEX team_board_outbox_pending_idx ON team_board_outbox (published_at, team_id, revision)",
      )
      yield* tx.run(`
        CREATE TABLE team_plan_review (
          id text PRIMARY KEY NOT NULL,
          team_id text NOT NULL,
          member_id text NOT NULL,
          submitted_by_session_id text NOT NULL,
          plan_body text NOT NULL,
          state text DEFAULT 'submitted' NOT NULL,
          decision text,
          decision_feedback text,
          decided_by_session_id text,
          decided_at integer,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        )
      `)
      yield* tx.run("CREATE UNIQUE INDEX team_plan_review_team_idx ON team_plan_review (team_id, id)")
      yield* tx.run(
        "CREATE INDEX team_plan_review_member_state_idx ON team_plan_review (team_id, member_id, state, time_created)",
      )
      yield* tx.run(`
        CREATE TABLE team_attention (
          id text PRIMARY KEY NOT NULL,
          team_id text NOT NULL,
          member_id text NOT NULL,
          session_id text NOT NULL,
          kind text NOT NULL,
          detail_id text NOT NULL,
          detail text NOT NULL,
          state text DEFAULT 'open' NOT NULL,
          resolution text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        )
      `)
      yield* tx.run("CREATE UNIQUE INDEX team_attention_detail_idx ON team_attention (kind, detail_id)")
      yield* tx.run(
        "CREATE INDEX team_attention_team_state_idx ON team_attention (team_id, state, kind, time_created)",
      )
    })
  },
} satisfies DatabaseMigration.Migration
