import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511182000_team_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`team\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`name\` text NOT NULL,
          \`goal\` text NOT NULL,
          \`lead_session_id\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`team_active_lead_session_idx\` ON \`team\` (\`lead_session_id\`) WHERE \`status\` = 'active';`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`team_member\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`team_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`agent_type\` text NOT NULL,
          \`model\` text,
          \`role_prompt\` text NOT NULL,
          \`status\` text DEFAULT 'starting' NOT NULL,
          \`plan_mode\` integer DEFAULT false NOT NULL,
          \`work_mode\` text DEFAULT 'implement' NOT NULL,
          \`dependency_ids\` text,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`team_member_team_idx\` ON \`team_member\` (\`team_id\`, \`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`team_member_session_idx\` ON \`team_member\` (\`session_id\`);`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`team_task\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`team_id\` text NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`assignee\` text,
          \`dependency_ids\` text,
          \`metadata\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`team_task_team_idx\` ON \`team_task\` (\`team_id\`, \`id\`);`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`team_message\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`team_id\` text NOT NULL,
          \`sender\` text NOT NULL,
          \`recipients\` text NOT NULL,
          \`body\` text NOT NULL,
          \`delivery_status\` text DEFAULT 'pending' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`team_message_team_idx\` ON \`team_message\` (\`team_id\`, \`id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`team_message_recipient_idx\` ON \`team_message\` (\`team_id\`, \`delivery_status\`);`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`team_message_recipient\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`message_id\` text NOT NULL,
          \`team_id\` text NOT NULL,
          \`recipient\` text NOT NULL,
          \`delivery_status\` text DEFAULT 'pending' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`team_message_recipient_message_idx\` ON \`team_message_recipient\` (\`message_id\`, \`recipient\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`team_message_recipient_status_idx\` ON \`team_message_recipient\` (\`team_id\`, \`recipient\`, \`delivery_status\`);`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`team_usage_event\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`team_id\` text NOT NULL,
          \`session_id\` text,
          \`member_id\` text,
          \`type\` text NOT NULL,
          \`metadata\` text DEFAULT '{}' NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`team_usage_event_team_idx\` ON \`team_usage_event\` (\`team_id\`, \`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
