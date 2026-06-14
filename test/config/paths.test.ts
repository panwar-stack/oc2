import { expect, test } from "bun:test"

import { expandHome, getConfigPaths, resolvePath } from "../../src/config/paths"

test("expands home and resolves relative paths", () => {
  expect(expandHome("~/oc2", "/home/test")).toBe("/home/test/oc2")
  expect(resolvePath("logs", "/repo", "/home/test")).toBe("/repo/logs")
  expect(resolvePath("~/logs", "/repo", "/home/test")).toBe("/home/test/logs")
})

test("computes canonical config and data paths", () => {
  const paths = getConfigPaths({
    cwd: "/repo",
    homeDir: "/home/test",
    env: { OC2_CONFIG: "./custom.jsonc", OC2_DATA_DIR: "~/data" },
  })

  expect(paths.userConfigPath).toBe("/home/test/.config/oc2/config.jsonc")
  expect(paths.projectConfigPaths).toEqual(["/repo/oc2.jsonc", "/repo/.oc2/config.jsonc"])
  expect(paths.explicitConfigPath).toBe("/repo/custom.jsonc")
  expect(paths.dataDir).toBe("/home/test/data")
})
