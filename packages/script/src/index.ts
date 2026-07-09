import { $ } from "bun"
import semver from "semver"
import path from "path"

export { bunCompileTargets, formatBunCompileTargetName, selectBunCompileTargets } from "./bun-target"
export type { BunCompileTarget } from "./bun-target"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OC2_CHANNEL: process.env["OC2_CHANNEL"],
  OC2_BUMP: process.env["OC2_BUMP"],
  OC2_VERSION: process.env["OC2_VERSION"],
  OC2_RELEASE: process.env["OC2_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.OC2_CHANNEL) return env.OC2_CHANNEL
  if (env.OC2_BUMP) return "latest"
  if (env.OC2_VERSION && !env.OC2_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.OC2_VERSION) return env.OC2_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = await fetchLatestVersion("oc2-ai")
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.OC2_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OC2_RELEASE
  },
  get team() {
    return team
  },
}

async function fetchLatestVersion(name: string) {
  return await fetch(`https://registry.npmjs.org/${name}/latest`)
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.version)
}
console.log(`oc2 script`, JSON.stringify(Script, null, 2))
