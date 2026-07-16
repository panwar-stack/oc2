const protectedNames = new Set(["agents.md", "bunfig.toml", "codeowners", "package.json", "turbo.json"])

export function normalizeRepositoryPath(path: string) {
  if (
    !path ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\\") ||
    /[\p{Cc}\p{Cf}]/u.test(path)
  )
    throw new Error("invalid repository path")

  const segments = path.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error("invalid repository path")
  return segments.join("/")
}

export function isProtectedAutomationPath(path: string) {
  const normalized = normalizeRepositoryPath(path)
  const folded = foldRepositoryPath(normalized)
  const segments = folded.split("/")
  if (segments.some((segment) => segment === ".github" || segment === ".oc2")) return true
  if (segments.some((segment) => segment.startsWith(".git") || segment.startsWith(".env"))) return true
  if (segments.some((segment) => protectedNames.has(segment))) return true
  if (segments.some((segment) => segment.startsWith("tsconfig") && segment.endsWith(".json"))) return true
  if (segments.some((segment) => segment === "oc2.json" || segment === "oc2.jsonc")) return true
  if (folded.includes("lock")) return true
  if (folded === "specs/secure-issue-driven-oc2-automation.md") return true
  return /^script\/oc2-(issue|verify|automation|publish)/.test(folded)
}

export function validateChangedPaths(paths: ReadonlyArray<string>) {
  const normalized = validateRepositoryPathSet(paths)
  for (const path of normalized) {
    if (isProtectedAutomationPath(path)) throw new Error("patch changes a protected path")
  }
  return normalized
}

export function validateRepositoryPathSet(paths: ReadonlyArray<string>) {
  const normalized = paths.map(normalizeRepositoryPath)
  const folded = new Map<string, "directory" | "file">()
  for (const path of normalized) {
    const segments = path.split("/")
    for (let index = 1; index <= segments.length; index++) {
      const key = foldRepositoryPath(segments.slice(0, index).join("/"))
      const kind = index === segments.length ? "file" : "directory"
      const previous = folded.get(key)
      if (previous && (previous === "file" || kind === "file"))
        throw new Error("patch contains duplicate normalized paths")
      folded.set(key, kind)
    }
  }
  return normalized
}

function foldRepositoryPath(path: string) {
  return path.normalize("NFKC").replaceAll("ẞ", "ss").replaceAll("ß", "ss").toUpperCase().toLowerCase().normalize("NFC")
}
