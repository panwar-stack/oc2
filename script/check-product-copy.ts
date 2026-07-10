#!/usr/bin/env bun
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const files = [
  "README.md",
  "Why.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "packages/onboarding.md",
  "packages/app/README.md",
  "package.json",
  "packages/app/package.json",
]
const prohibited = ["OC2 Local Template", "AI coding agent template", "local-first template"]
const pathProhibited: Record<string, string[]> = {
  "CONTRIBUTING.md": ["local-first coding agent harness", "without introducing a dependency on a hosted service"],
  "SECURITY.md": [
    "OpenCode is an AI-powered coding assistant",
    "OpenCode does **not** sandbox the agent",
    "run OpenCode inside a Docker container or VM",
  ],
  "packages/onboarding.md": [
    "local-first coding agent harness",
    "Avoid adding hosted fallbacks or external service dependencies",
  ],
}
const matches: { file: string; line: number; phrase: string }[] = []

for (const file of files) {
  const source = Bun.file(path.join(root, file))
  if (!(await source.exists())) throw new Error(`Product copy source does not exist: ${file}`)

  const text = await source.text()
  const normalized = text.toLowerCase()
  for (const phrase of [...prohibited, ...(pathProhibited[file] ?? [])]) {
    const target = phrase.toLowerCase()
    let offset = 0
    while (offset < normalized.length) {
      const index = normalized.indexOf(target, offset)
      if (index === -1) break
      matches.push({
        file,
        line: text.slice(0, index).split("\n").length,
        phrase: text.slice(index, index + phrase.length),
      })
      offset = index + target.length
    }
  }
}

for (const match of matches) {
  console.error(`${match.file}:${match.line}: prohibited product phrase: ${JSON.stringify(match.phrase)}`)
}

console.log(`Product copy check scanned ${files.length} files and found ${matches.length} prohibited phrase(s).`)

if (matches.length > 0) process.exitCode = 1
