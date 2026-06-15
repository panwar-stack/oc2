import type { SlashMatch } from "../state"

export function SlashSuggestions({
  matches,
  width = 80,
  active,
}: {
  readonly matches: readonly SlashMatch[]
  readonly width?: number
  readonly active: boolean
}): string {
  if (!active) return ""

  const unique = [...new Map(matches.map((match) => [match.name, match])).values()]
  const visible = unique.slice(0, 5)
  const lines = visible.map((match) => {
    const prefix = `  ${match.display.padEnd(16)} `
    const suffix = ` [${match.source}]`
    return `${prefix}${truncate(match.description, Math.max(width - prefix.length - suffix.length, 0))}${suffix}`
  })

  if (unique.length > visible.length) lines.push(`  ... and ${unique.length - visible.length} more`)
  lines.push("  [ESC to cancel]")
  return lines.join("\n")
}

const truncate = (value: string, maxLength: number): string => {
  if (maxLength <= 0) return ""
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}
