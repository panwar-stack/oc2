import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260511181000_session_root",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_root\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE cascade,
          \`name\` text,
          \`directory\` text NOT NULL,
          \`worktree\` text NOT NULL,
          \`project_id\` text NOT NULL REFERENCES \`project\`(\`id\`) ON DELETE cascade,
          \`path\` text,
          \`created\` integer NOT NULL,
          \`primary\` integer DEFAULT false NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS \`session_root_session_directory_idx\` ON \`session_root\` (\`session_id\`, \`directory\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_root_session_idx\` ON \`session_root\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
