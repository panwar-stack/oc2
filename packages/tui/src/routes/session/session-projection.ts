import { Locale } from "../../util/locale"

type SessionContextProjection = {
  tokens: number
  limit?: number
  tokensLabel: string
  limitLabel?: string
  percent?: number
  cells?: number
  gauge?: string
  level: "normal" | "warning" | "danger"
  action?: string
}

export function projectSessionContext(tokens: number, limit?: number): SessionContextProjection {
  const tokensLabel = Locale.number(tokens)
  if (!limit || limit <= 0) return { tokens, tokensLabel, level: "normal" as const }

  const percent = Math.floor(Math.min(100, Math.max(0, (tokens / limit) * 100)))
  const cells = Math.round((percent / 100) * 8)
  const level = percent >= 90 ? ("danger" as const) : percent >= 70 ? ("warning" as const) : ("normal" as const)
  return {
    tokens,
    limit,
    tokensLabel,
    limitLabel: Locale.number(limit),
    percent,
    cells,
    gauge: `${"▰".repeat(cells)}${"▱".repeat(8 - cells)}`,
    level,
    action: level === "danger" ? "fork/new" : level === "warning" ? "compact" : undefined,
  }
}
