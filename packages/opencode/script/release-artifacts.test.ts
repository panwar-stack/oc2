import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { rmSync } from "fs"
import path from "path"
import { nativePackages, validateNativePackages } from "./release-artifacts"

setDefaultTimeout(30_000)

// The package preload disposes AppRuntime in afterAll, so load it outside that hook's five-second timeout.
await import("../src/effect/app-runtime")

async function fixture(version = "1.2.3") {
  const dist = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  for (const item of nativePackages) {
    const directory = path.join(dist, item.name)
    await Bun.$`mkdir -p ${path.join(directory, "bin")}`
    await Bun.write(path.join(directory, "bin", item.binary), item.name)
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: item.name,
        version,
        os: [item.os],
        cpu: [item.cpu],
        ...(item.libc ? { libc: [item.libc] } : {}),
      }),
    )
  }
  return dist
}

describe("release artifacts", () => {
  test("validates the exact native package set", async () => {
    const dist = await fixture()
    try {
      expect(await validateNativePackages(dist)).toBe("1.2.3")
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  test("rejects a missing native package", async () => {
    const dist = await fixture()
    try {
      rmSync(path.join(dist, nativePackages[0].name), { recursive: true })
      await expect(validateNativePackages(dist)).rejects.toThrow("expected native packages")
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  test("rejects mixed native versions", async () => {
    const dist = await fixture()
    try {
      const filepath = path.join(dist, nativePackages[1].name, "package.json")
      const value = await Bun.file(filepath).json()
      value.version = "1.2.4"
      await Bun.write(filepath, JSON.stringify(value))

      await expect(validateNativePackages(dist)).rejects.toThrow("does not match")
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })
})
