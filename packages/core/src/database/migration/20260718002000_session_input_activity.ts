import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260718002000_session_input_activity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text,
          \`activity\` text NOT NULL,
          \`source\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__new_session_input\` (
          \`id\`, \`session_id\`, \`prompt\`, \`activity\`, \`source\`, \`delivery\`, \`admitted_seq\`,
          \`promoted_seq\`, \`time_created\`
        )
        SELECT
          \`id\`, \`session_id\`, \`prompt\`, json_object('type', 'prompt', 'prompt', json(\`prompt\`)), 'prompt',
          \`delivery\`, \`admitted_seq\`, \`promoted_seq\`, \`time_created\`
        FROM \`session_input\`;
      `)
      yield* tx.run(`DROP TABLE \`session_input\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_input\` RENAME TO \`session_input\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
