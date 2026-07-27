import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727045732_yielding_preak",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_root\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`name\` text,
          \`directory\` text NOT NULL,
          \`worktree\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`path\` text,
          \`created\` integer NOT NULL,
          \`primary\` integer DEFAULT false NOT NULL,
          CONSTRAINT \`fk_session_root_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_root_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)
      if (!columns.some((column) => column.name === "time_processing"))
        yield* tx.run(`ALTER TABLE \`session\` ADD \`time_processing\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS \`session_root_session_directory_idx\` ON \`session_root\` (\`session_id\`,\`directory\`);`,
      )
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`session_root_session_idx\` ON \`session_root\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
