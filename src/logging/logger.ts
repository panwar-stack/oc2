import { redactValue } from "./redaction"
import type { LogLevel } from "../config/schema"

export interface LogEntry {
  level: LogLevel
  message: string
  fields?: Record<string, unknown>
  time: string
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface LoggerOptions {
  level?: LogLevel
  sink?: (entry: LogEntry) => void
  now?: () => Date
}

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** Creates a structured logger that filters by level and redacts secrets before writing. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minimumLevel = options.level ?? "info"
  const sink = options.sink ?? ((entry) => console.error(JSON.stringify(entry)))
  const now = options.now ?? (() => new Date())

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (levelWeight[level] < levelWeight[minimumLevel]) return
    sink({
      level,
      message: redactValue(message) as string,
      ...(fields === undefined ? {} : { fields: redactValue(fields) as Record<string, unknown> }),
      time: now().toISOString(),
    })
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  }
}
