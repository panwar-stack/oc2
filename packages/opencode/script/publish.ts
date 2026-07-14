#!/usr/bin/env bun
import { $ } from "bun"
import { Script } from "@oc2-ai/script"
import pkg from "../package.json"
import path from "path"
import { fileURLToPath } from "url"
import { nativePackages, validateNativePackages } from "./release-artifacts"

const dir = fileURLToPath(new URL("..", import.meta.url))
const wrapperName = "oc2-ai"

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
