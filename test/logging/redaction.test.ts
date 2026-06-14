import { expect, test } from "bun:test"

import { createLogger, type LogEntry } from "../../src/logging/logger"
import { REDACTED, redactText, redactValue } from "../../src/logging/redaction"

test("redacts secret-shaped keys and token text", () => {
  expect(
    redactValue({
      apiKey: "sk-secret123456",
      headers: { Authorization: "Bearer token123" },
      nested: "Bearer abc.def",
    }),
  ).toEqual({
    apiKey: REDACTED,
    headers: { Authorization: REDACTED },
    nested: `Bearer ${REDACTED}`,
  })

  expect(redactText("key sk-secret123456 and Bearer abc.def")).toBe(`key ${REDACTED} and Bearer ${REDACTED}`)
})

test("logger redacts fields and respects minimum level", () => {
  const entries: LogEntry[] = []
  const logger = createLogger({
    level: "warn",
    sink: (entry) => entries.push(entry),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  })

  logger.info("ignored", { token: "secret" })
  logger.error("failed", { token: "secret" })

  expect(entries).toEqual([
    {
      level: "error",
      message: "failed",
      fields: { token: REDACTED },
      time: "2026-01-01T00:00:00.000Z",
    },
  ])
})
