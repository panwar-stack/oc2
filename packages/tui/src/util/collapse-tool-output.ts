export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lineLimit = Math.max(0, Math.trunc(maxLines))
  if (lineLimit === 0 || maxChars < 0) return { output: "…", overflow: true }

  const prefix: string[] = []
  let lines = 1

  for (const char of output) {
    if (char === "\n" && lines >= lineLimit) {
      return { output: prefix.join("") + "\n…", overflow: true }
    }

    if (prefix.length + 1 > maxChars) {
      return {
        output: prefix.slice(0, Math.max(0, maxChars - 1)).join("") + "…",
        overflow: true,
      }
    }

    prefix.push(char)
    if (char === "\n") lines++
  }

  return { output, overflow: false }
}
