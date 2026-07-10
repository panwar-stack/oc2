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
  "packages/app/src/i18n/en.ts",
  "packages/tui/src/feature-plugins/sidebar/footer.tsx",
  "packages/core/src/plugin/command/initialize.txt",
  "packages/core/src/plugin/skill.ts",
  "packages/opencode/src/command/template/initialize.txt",
  "packages/opencode/src/session/prompt/anthropic.txt",
  "packages/opencode/src/session/prompt/copilot-gpt-5.txt",
  "packages/opencode/src/session/prompt/default.txt",
  "packages/opencode/src/session/prompt/gemini.txt",
  "packages/opencode/src/session/prompt/kimi.txt",
  "packages/opencode/src/session/prompt/trinity.txt",
  "packages/opencode/src/skill/index.ts",
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
  "packages/app/src/i18n/en.ts": ["includes free models", "Connect any provider", "bundled provider"],
  "packages/tui/src/feature-plugins/sidebar/footer.tsx": [
    "includes free models",
    "Connect from 75+ providers",
    "bundled provider",
  ],
  "packages/core/src/plugin/command/initialize.txt": ["OpenCode sessions", "repo-local OpenCode config"],
  "packages/core/src/plugin/skill.ts": ["opencode's own configuration", "opencode agents"],
  "packages/opencode/src/command/template/initialize.txt": ["OpenCode sessions", "repo-local OpenCode config"],
  "packages/opencode/src/session/prompt/anthropic.txt": [
    "use WebFetch to answer from the documentation",
    "documentation index is https://OC2.ai/docs",
  ],
  "packages/opencode/src/session/prompt/copilot-gpt-5.txt": ["Your name is oc2"],
  "packages/opencode/src/session/prompt/default.txt": [
    "interactive CLI tool that helps users",
    "use the WebFetch tool to gather information",
    "OC2 docs at https://oc2.ai",
  ],
  "packages/opencode/src/session/prompt/gemini.txt": ["interactive CLI agent specializing"],
  "packages/opencode/src/session/prompt/kimi.txt": ["interactive general AI agent"],
  "packages/opencode/src/session/prompt/trinity.txt": ["interactive CLI tool that helps users"],
  "packages/opencode/src/skill/index.ts": [
    "ships with opencode",
    "opencode hard-fails",
    "opencode's own config",
    "opencode agents",
    "configuring opencode itself",
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
