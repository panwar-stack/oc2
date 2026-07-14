import path from "path"

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
