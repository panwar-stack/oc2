import semver from "semver"

export function findRelease(pages: unknown, sourceSha: string) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error(`invalid release source SHA: ${JSON.stringify(sourceSha)}`)
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("unexpected GitHub Releases response")
  }

  const values = (pages as unknown[][]).flat()
  if (values.some((value) => typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new Error("unexpected GitHub Release")
  }
  const releases = values as Record<string, unknown>[]
  const sourceMarker = `<!-- oc2-release-source:${sourceSha} -->`
  const matches = releases.filter((release) => typeof release.body === "string" && release.body.includes(sourceMarker))
  if (matches.length > 1) throw new Error(`found ${matches.length} Releases for source commit`)

  if (matches.length === 1) {
    const release = validateRelease(matches[0])
    if (release.source !== sourceSha) throw new Error("Release source marker does not match requested source")
    return {
      state: release.draft ? "draft" : "published",
      complete: !release.draft,
      tag: release.tag,
      version: release.version,
      source: release.source,
    } as const
  }

  const workflowReleases = releases.filter(
    (release) => typeof release.body === "string" && release.body.includes("<!-- oc2-release-source:"),
  )
  if (workflowReleases.some((release) => typeof release.draft !== "boolean")) {
    throw new Error("unexpected Release draft state")
  }
  const workflowDrafts = workflowReleases.filter((release) => release.draft === true)
  if (workflowDrafts.length > 1) throw new Error(`found ${workflowDrafts.length} workflow draft Releases`)
  if (workflowDrafts.length === 1) {
    const release = validateRelease(workflowDrafts[0])
    return {
      state: "blocked",
      complete: false,
      tag: release.tag,
      version: release.version,
      source: release.source,
    } as const
  }

  return { state: "missing", complete: false } as const
}

function validateRelease(release: Record<string, unknown>) {
  if (typeof release.body !== "string") throw new Error("workflow Release body must be a string")
  const prefixes = release.body.match(/<!-- oc2-release-source:/g) ?? []
  const markers = [...release.body.matchAll(/<!-- oc2-release-source:([0-9a-f]{40}) -->/g)]
  if (prefixes.length !== 1 || markers.length !== 1) {
    throw new Error("workflow Release must contain exactly one lowercase 40-hex source marker")
  }

  const source = markers[0][1]
  if (release.target_commitish !== source) throw new Error("workflow Release source marker must match target_commitish")
  if (typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) {
    throw new Error(`Release tag must be canonical stable semver, got ${JSON.stringify(release.tag_name)}`)
  }
  const version = release.tag_name.slice(1)
  if (semver.valid(version) !== version || semver.prerelease(version) !== null) {
    throw new Error(`Release tag must be canonical stable semver, got ${JSON.stringify(release.tag_name)}`)
  }
  if (release.prerelease !== false) throw new Error(`Release ${release.tag_name} must not be a prerelease`)
  if (typeof release.draft !== "boolean") throw new Error("unexpected Release draft state")
  return { source, tag: release.tag_name, version, draft: release.draft }
}

if (import.meta.main) {
  const releasesFile = process.env.RELEASES_FILE
  const sourceSha = process.env.GITHUB_SHA
  if (!releasesFile || !sourceSha) throw new Error("missing release plan environment")

  const pages: unknown = await Bun.file(releasesFile).json()
  const plan = findRelease(pages, sourceSha)
  const output = [`complete=${plan.complete}`, `state=${plan.state}`]
  if (plan.state !== "missing") {
    output.push(`tag=${plan.tag}`, `version=${plan.version}`, `source=${plan.source}`)
  }
  process.stdout.write(`${output.join("\n")}\n`)
}
