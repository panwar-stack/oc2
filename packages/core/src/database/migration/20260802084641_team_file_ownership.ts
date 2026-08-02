import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802084641_team_file_ownership",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`team_file_ownership\` (
          \`id\` text PRIMARY KEY,
          \`team_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`root_key\` text NOT NULL,
          \`path_key\` text NOT NULL,
          \`display_path\` text NOT NULL,
          \`owner_session_id\` text,
          \`time_released\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`team_file_ownership_active_path_idx\` ON \`team_file_ownership\` (\`path_key\`) WHERE "team_file_ownership"."time_released" IS NULL;`)
      yield* tx.run(`CREATE INDEX \`team_file_ownership_task_idx\` ON \`team_file_ownership\` (\`team_id\`,\`task_id\`);`)
      yield* tx.run(`CREATE INDEX \`team_file_ownership_owner_session_idx\` ON \`team_file_ownership\` (\`team_id\`,\`owner_session_id\`,\`time_released\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
