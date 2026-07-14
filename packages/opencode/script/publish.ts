#!/usr/bin/env bun
import { $ } from "bun"
import { Script } from "@oc2-ai/script"
import pkg from "../package.json"
import path from "path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
const wrapperName = "oc2-ai"

type NativePackage = {
  name: string
  os: string
  cpu: string
  libc?: string
  binary: string
}

export const nativePackages: readonly NativePackage[] = [
  { name: "oc2-darwin-arm64", os: "darwin", cpu: "arm64", binary: "oc2" },
  { name: "oc2-darwin-x64", os: "darwin", cpu: "x64", binary: "oc2" },
  { name: "oc2-darwin-x64-baseline", os: "darwin", cpu: "x64", binary: "oc2" },
  { name: "oc2-linux-arm64", os: "linux", cpu: "arm64", binary: "oc2" },
  { name: "oc2-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl", binary: "oc2" },
  { name: "oc2-linux-x64", os: "linux", cpu: "x64", binary: "oc2" },
  { name: "oc2-linux-x64-baseline", os: "linux", cpu: "x64", binary: "oc2" },
  { name: "oc2-linux-x64-baseline-musl", os: "linux", cpu: "x64", libc: "musl", binary: "oc2" },
  { name: "oc2-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl", binary: "oc2" },
  { name: "oc2-windows-arm64", os: "win32", cpu: "arm64", binary: "oc2.exe" },
  { name: "oc2-windows-x64", os: "win32", cpu: "x64", binary: "oc2.exe" },
  { name: "oc2-windows-x64-baseline", os: "win32", cpu: "x64", binary: "oc2.exe" },
]

const packageMetadata = {
  description: "The AI coding agent built for the terminal.",
  repository: {
    type: "git",
    url: "git+https://github.com/panwar-stack/oc2.git",
  },
  bugs: {
    url: "https://github.com/panwar-stack/oc2/issues",
  },
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object")
  return value as Record<string, unknown>
}

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("expected strings")
  return value as string[]
}

async function manifest(filepath: string) {
  try {
    return record(await Bun.file(filepath).json())
  } catch (error) {
    throw new Error(`invalid package manifest ${filepath}`, { cause: error })
  }
}

export async function validateNativePackages(dist: string) {
  const names = Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: dist }))
    .map((filepath) => filepath.split("/")[0])
    .sort()
  const expected = nativePackages.map((item) => item.name)
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`expected native packages ${expected.join(", ")}; found ${names.join(", ") || "none"}`)
  }

  let version = ""
  for (const item of nativePackages) {
    const directory = path.join(dist, item.name)
    const value = await manifest(path.join(directory, "package.json"))
    if (value.name !== item.name) throw new Error(`${item.name} manifest name must be ${item.name}`)
    if (typeof value.version !== "string" || !value.version) throw new Error(`${item.name} must have a version`)
    if (version && value.version !== version)
      throw new Error(`${item.name} version ${value.version} does not match ${version}`)
    version = value.version
    if (JSON.stringify(stringArray(value.os)) !== JSON.stringify([item.os]))
      throw new Error(`${item.name} has invalid os`)
    if (JSON.stringify(stringArray(value.cpu)) !== JSON.stringify([item.cpu]))
      throw new Error(`${item.name} has invalid cpu`)
    const libc = item.libc ? [item.libc] : undefined
    if (JSON.stringify(value.libc) !== JSON.stringify(libc)) throw new Error(`${item.name} has invalid libc`)
    if (!(await Bun.file(path.join(directory, "bin", item.binary)).exists())) {
      throw new Error(`${item.name} is missing bin/${item.binary}`)
    }
    const otherBinary = item.binary === "oc2" ? "oc2.exe" : "oc2"
    if (await Bun.file(path.join(directory, "bin", otherBinary)).exists()) {
      throw new Error(`${item.name} contains unexpected bin/${otherBinary}`)
    }
  }
  return version
}

export async function writeWrapperPackage(dist: string, version: string) {
  const directory = path.join(dist, wrapperName)
  await $`rm -rf ${directory}`
  await $`mkdir -p ${path.join(directory, "bin")}`
  await Bun.write(path.join(directory, "postinstall.mjs"), Bun.file(path.join(dir, "script/postinstall.mjs")))
  await Bun.write(path.join(directory, "LICENSE"), Bun.file(path.join(dir, "../../LICENSE")))
  const fallback = [
    `echo "Error: ${wrapperName}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${wrapperName} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${wrapperName} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n")
  await Bun.write(path.join(directory, "bin/oc2.exe"), fallback)
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify(
      {
        name: wrapperName,
        ...packageMetadata,
        bin: { oc2: "./bin/oc2.exe" },
        scripts: { postinstall: "node ./postinstall.mjs" },
        version,
        license: pkg.license,
        os: ["darwin", "linux", "win32"],
        cpu: ["arm64", "x64"],
        optionalDependencies: Object.fromEntries(nativePackages.map((item) => [item.name, version])),
      },
      null,
      2,
    ),
  )
}

function validateWrapperManifest(value: Record<string, unknown>, version: string) {
  const optionalDependencies = record(value.optionalDependencies)
  const expected = Object.fromEntries(nativePackages.map((item) => [item.name, version]))
  if (value.name !== wrapperName || value.version !== version)
    throw new Error(`wrapper must be ${wrapperName}@${version}`)
  if (JSON.stringify(optionalDependencies) !== JSON.stringify(expected)) {
    throw new Error(`${wrapperName} optional dependencies do not match the native package set`)
  }
  const bin = record(value.bin)
  if (bin.oc2 !== "./bin/oc2.exe" || Object.keys(bin).length !== 1)
    throw new Error(`${wrapperName} must expose only oc2`)
}

async function pack(directory: string, archives: string) {
  const output = await $`bun pm pack --quiet --destination ${archives}`.cwd(directory).text()
  const archive = path.resolve(directory, output.trim())
  if (!(await Bun.file(archive).exists())) throw new Error(`pack did not create ${archive}`)
  return archive
}

export async function validateArchive(archive: string, name: string, version: string, files: string[]) {
  const entries = (await $`tar -tzf ${archive}`.text()).trim().split("\n").filter(Boolean).sort()
  const expected = files.map((file) => `package/${file}`).sort()
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`${name} archive contains ${entries.join(", ")}; expected ${expected.join(", ")}`)
  }
  const value = record(JSON.parse(await $`tar -xOzf ${archive} package/package.json`.text()))
  if (value.name !== name || value.version !== version) {
    throw new Error(`${archive} contains ${String(value.name)}@${String(value.version)}, expected ${name}@${version}`)
  }
  return value
}

export async function prepareArchives(dist: string) {
  await $`rm -rf ${path.join(dist, wrapperName)}`
  const version = await validateNativePackages(dist)
  await writeWrapperPackage(dist, version)
  const archives = path.join(dist, "npm")
  await $`rm -rf ${archives}`
  await $`mkdir -p ${archives}`

  const packed: { name: string; version: string; archive: string }[] = []
  for (const item of nativePackages) {
    const directory = path.join(dist, item.name)
    if (process.platform !== "win32") await $`chmod 755 ${path.join(directory, "bin", item.binary)}`
    const archive = await pack(directory, archives)
    await validateArchive(archive, item.name, version, ["package.json", `bin/${item.binary}`])
    packed.push({ name: item.name, version, archive })
  }
  const wrapperDirectory = path.join(dist, wrapperName)
  if (process.platform !== "win32") await $`chmod 755 ${path.join(wrapperDirectory, "bin/oc2.exe")}`
  const wrapperArchive = await pack(wrapperDirectory, archives)
  const wrapper = await validateArchive(wrapperArchive, wrapperName, version, [
    "LICENSE",
    "bin/oc2.exe",
    "package.json",
    "postinstall.mjs",
  ])
  validateWrapperManifest(wrapper, version)
  packed.push({ name: wrapperName, version, archive: wrapperArchive })
  return packed
}

export function npmViewResult(name: string, version: string, exitCode: number, stdout: string, stderr: string) {
  if (exitCode !== 0) {
    if (/\bE404\b/.test(`${stdout}\n${stderr}`)) return false
    throw new Error(`npm view failed for ${name}@${version}:\n${stderr || stdout}`)
  }
  const value = record(JSON.parse(stdout))
  if (value.name !== name || value.version !== version) {
    throw new Error(`npm has ${String(value.name)}@${String(value.version)}, expected ${name}@${version}`)
  }
  return true
}

async function published(name: string, version: string) {
  const result = await $`npm view ${`${name}@${version}`} name version --json`.quiet().nothrow()
  return npmViewResult(name, version, result.exitCode, result.stdout.toString(), result.stderr.toString())
}

async function publish(item: { name: string; version: string; archive: string }) {
  if (await published(item.name, item.version)) {
    console.log(`already published ${item.name}@${item.version}`)
    return
  }
  await $`npm publish ${item.archive} --access public --tag ${Script.channel} --provenance false`
}

async function main() {
  const packages = await prepareArchives(path.join(dir, "dist"))
  console.log(
    "packages",
    packages.map((item) => `${item.name}@${item.version}`),
  )
  for (const item of packages.slice(0, -1)) await publish(item)
  await publish(packages[packages.length - 1])
}

if (import.meta.main) await main()
