import { expect, test } from "bun:test"

test("adopts the startup trace immediately after worker creation and closes the current path", async () => {
  const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()
  const spawn = source.indexOf("const worker = new Worker")
  const adopt = source.indexOf("getTuiStartupProfile().adopt()", spawn)
  const handler = source.indexOf("worker.onerror", spawn)
  const rpc = source.indexOf("Rpc.client", spawn)
  const close = source.indexOf("startupProfile.close()", adopt)

  expect(spawn).toBeGreaterThan(-1)
  expect(adopt).toBeGreaterThan(spawn)
  expect(source.slice(spawn, adopt)).not.toContain("worker.")
  expect(source.slice(spawn, adopt)).not.toContain("Rpc.")
  expect(adopt).toBeLessThan(handler)
  expect(adopt).toBeLessThan(rpc)
  expect(close).toBeGreaterThan(adopt)
  expect(source).toContain("delete env[OC2_TUI_STARTUP_PROFILE]")
  expect(source).toContain("delete env[OC2_TUI_STARTUP_PROFILE_FD]")
})
