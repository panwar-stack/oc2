export interface OutputBounds {
  readonly maxChars?: number
  readonly maxLines?: number
}

export interface BoundedOutput {
  readonly value: unknown
  readonly text: string
  readonly truncated: boolean
}

const defaultMaxChars = 50 * 1024
const defaultMaxLines = 2_000

export const stringifyToolOutput = (value: unknown): string => {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

export const boundToolOutput = (value: unknown, bounds: OutputBounds = {}): BoundedOutput => {
  const maxChars = bounds.maxChars ?? defaultMaxChars
  const maxLines = bounds.maxLines ?? defaultMaxLines
  const text = stringifyToolOutput(value)
  const lines = text.split("\n")
  let truncated = false
  let bounded = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text

  if (lines.length > maxLines) truncated = true
  if (bounded.length > maxChars) {
    bounded = bounded.slice(0, maxChars)
    truncated = true
  }

  const suffix = truncated ? `\n\n[Output truncated to ${maxLines} lines / ${maxChars} chars]` : ""
  return { value: truncated ? `${bounded}${suffix}` : value, text: `${bounded}${suffix}`, truncated }
}
