import { sanitizeForPersistence } from "./sanitize"

/** Serializes values after removing non-persistable causes and redacting secret-looking keys. */
export const toJson = (value: unknown): string => JSON.stringify(sanitizeForPersistence(value ?? null))

/** Parses persisted JSON, returning the provided fallback for nullable columns. */
export const fromJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  return JSON.parse(value) as T
}
