import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { $ } from "bun"
import { rmSync } from "fs"
import path from "path"
import { nativePackages } from "./release-artifacts"
import { npmViewResult, prepareArchives } from "./publish"

setDefaultTimeout(30_000)

// The package preload disposes AppRuntime in afterAll, so load it outside that hook's five-second timeout.
await import("../src/effect/app-runtime")

async function fixture(version = "1.2.3") {
  const dist = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  for (const item of nativePackages) {
    const directory = path.join(dist, item.name)
    await $`mkdir -p ${path.join(directory, "bin")}`
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

describe("npm packaging", () => {
  test("packs the exact native set and wrapper once", async () => {
    const dist = await fixture()
    try {
      await Bun.write(path.join(dist, "npm", "stale.tgz"), "stale")

      const first = await prepareArchives(dist)
      const packed = await prepareArchives(dist)

      expect(first.map((item) => item.name)).toEqual(packed.map((item) => item.name))
      expect(packed.map((item) => item.name)).toEqual([...nativePackages.map((item) => item.name), "oc2-ai"])
      expect(Array.from(new Bun.Glob("*.tgz").scanSync({ cwd: path.join(dist, "npm") })).sort()).toEqual(
        packed.map((item) => path.basename(item.archive)).sort(),
      )
      expect(await Bun.file(path.join(dist, "npm", "stale.tgz")).exists()).toBeFalse()
      expect((await $`tar -tzf ${packed[0].archive}`.text()).trim().split("\n").sort()).toEqual([
        "package/bin/oc2",
        "package/package.json",
      ])
      expect((await $`tar -tzf ${packed[packed.length - 1].archive}`.text()).trim().split("\n").sort()).toEqual([
        "package/LICENSE",
        "package/bin/oc2.exe",
        "package/package.json",
        "package/postinstall.mjs",
      ])
      const wrapper = await Bun.file(path.join(dist, "oc2-ai", "package.json")).json()
      expect(wrapper.name).toBe("oc2-ai")
      expect(wrapper.version).toBe("1.2.3")
      expect(wrapper.bin).toEqual({ oc2: "./bin/oc2.exe" })
      expect(wrapper.optionalDependencies).toEqual(
        Object.fromEntries(nativePackages.map((item) => [item.name, "1.2.3"])),
      )
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  test("rejects a missing native package before packing", async () => {
    const dist = await fixture()
    try {
      await $`rm -rf ${path.join(dist, nativePackages[0].name)}`

      await expect(prepareArchives(dist)).rejects.toThrow("expected native packages")
      expect(await Bun.file(path.join(dist, "npm")).exists()).toBeFalse()
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  test("only treats npm E404 as unpublished", () => {
    expect(npmViewResult("oc2-ai", "1.2.3", 1, "", "npm error code E404")).toBeFalse()
    expect(() => npmViewResult("oc2-ai", "1.2.3", 1, "", "npm error code E401")).toThrow("npm view failed")
    expect(npmViewResult("oc2-ai", "1.2.3", 0, '{"name":"oc2-ai","version":"1.2.3"}', "")).toBeTrue()
    expect(() => npmViewResult("oc2-ai", "1.2.3", 0, '{"name":"other","version":"1.2.3"}', "")).toThrow(
      "expected oc2-ai@1.2.3",
    )
  })
})
