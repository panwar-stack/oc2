import { Database as CoreDatabase } from "@opencode-ai/core/database/database"

export type TxOrDb = CoreDatabase.Interface["db"]

export const Client = CoreDatabase.Client
export const use = CoreDatabase.use
export const transaction = CoreDatabase.transaction

export const Database = CoreDatabase
