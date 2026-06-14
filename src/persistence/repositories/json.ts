import { sanitizeForPersistence } from "./sanitize"

export const toJson = (value: unknown): string => JSON.stringify(sanitizeForPersistence(value ?? null))

export const fromJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  return JSON.parse(value) as T
}
