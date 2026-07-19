type SessionContextProjection = {
  tokens: number
  limit?: number
  tokensLabel: string
  limitLabel?: string
  percent?: number
  cells?: number
  gauge?: string
  level: "success" | "warning" | "danger"
  action?: "compact" | "fork"
  headroom?: number
  headroomLabel?: string
}

export function projectSessionContext(tokens: number, limit?: number): SessionContextProjection {
  const compact = (value: number) => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
    return value.toString()
  }
  const tokensLabel = compact(tokens)
  if (!limit || limit <= 0) return { tokens, tokensLabel, level: "success" as const }

  const percent = Math.floor(Math.min(100, Math.max(0, (tokens / limit) * 100)))
  const cells = Math.round((percent / 100) * 8)
  const level = percent >= 90 ? ("danger" as const) : percent >= 70 ? ("warning" as const) : ("success" as const)
  const headroom = Math.max(0, limit - tokens)
  return {
    tokens,
    limit,
    tokensLabel,
    limitLabel: compact(limit),
    percent,
    cells,
    gauge: `${"▰".repeat(cells)}${"▱".repeat(8 - cells)}`,
    level,
    action: level === "danger" ? ("fork" as const) : level === "warning" ? ("compact" as const) : undefined,
    headroom,
    headroomLabel: compact(headroom),
  }
}
