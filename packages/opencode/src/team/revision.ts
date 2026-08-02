import { eq, sql } from "drizzle-orm"
import { Database } from "@oc2-ai/core/database/database"
import { TeamTable } from "./team.sql"

type RevisionDb = Pick<Database.Interface["db"], "update">

/**
 * Increment the team revision by one. Must be called INSIDE the same immediate transaction as the
 * material change it covers, and at most once per logical transaction. The revision is the durable
 * anchor for the final-report checkpoint: any later material mutation moves it and invalidates a
 * recorded checkpoint.
 *
 * Do not call for message claim/delivery/read state, wake state, the report event itself,
 * recoverDeliveries, or the team-close transaction.
 */
export const bumpTeamRevision = (db: RevisionDb, teamID: string) =>
  db
    .update(TeamTable)
    .set({ revision: sql`${TeamTable.revision} + 1` })
    .where(eq(TeamTable.id, teamID))
    .run()
